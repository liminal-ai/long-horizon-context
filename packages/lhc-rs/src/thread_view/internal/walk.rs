//! Shared Smart Compact band walk, ported from `internal/walk.ts`.
//!
//! Both execution plans use this exact decision code. Sources differ only in
//! whether material is already eager in memory or loaded when a rung asks for
//! it.

use std::collections::{HashMap, HashSet};

use crate::shared_tech::derivation::DerivationState;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{Band, ViewSubjectKind};

use super::render::{
    CompactChunkMaterialSnapshot, DerivationSnapshot, ResolvedRepresentation,
    render_arrangement_entry, resolve_brief_representation, resolve_detailed_representation,
    resolve_smooth_representation,
};
use super::select::{
    ArrangementEntry, SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionResult,
    SelectionTurn, SelectionTurnStatus, SkippedEntry,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactStoppedError {
    pub detail: String,
}

pub trait SelectionSource {
    fn turns(&self) -> Vec<SelectionTurn>;
    fn chunks(&self) -> Vec<SelectionChunk>;
    fn has_placeable_messages(&mut self) -> bool;
    fn crossing_message(&mut self, budget: f64) -> Option<(i64, String)>;
    fn turn_min_message_order(&mut self, turn_id: &str) -> Option<i64>;
    fn turn_message_tokens(&mut self, turn_id: &str) -> i64;
    fn message_tokens_after(&mut self, order: i64) -> i64;
    fn turn_excerpt(&mut self, turn_id: &str) -> Option<String>;
    fn derivation(&mut self, subject_id: &str, derivation_type: &str)
    -> Option<DerivationSnapshot>;
    fn chunk_material(
        &mut self,
        chunk_id: &str,
        derivation_type: &str,
    ) -> Result<Option<CompactChunkMaterialSnapshot>, CompactStoppedError>;
}

fn usable(snapshot: Option<&DerivationSnapshot>) -> bool {
    matches!(
        snapshot,
        Some(DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some(_),
            ..
        })
    )
}

fn lookup_map(
    rows: &HashMap<String, DerivationSnapshot>,
    subject_id: &str,
    derivation_type: &str,
) -> Option<DerivationSnapshot> {
    rows.get(&format!("{subject_id}/{derivation_type}"))
        .cloned()
}

fn budget(config: &SelectionConfig, share: f64) -> f64 {
    (config.lower_bound * share) / 100.0
}

fn previous_close(closed_turns: &[SelectionTurn], turn: &SelectionTurn) -> i64 {
    closed_turns
        .iter()
        .rfind(|candidate| candidate.turn_order < turn.turn_order)
        .and_then(|candidate| candidate.closed_at)
        .unwrap_or(0)
}

fn turn_start_order(source: &mut dyn SelectionSource, turn: &SelectionTurn) -> i64 {
    source
        .turn_min_message_order(&turn.turn_id)
        .unwrap_or(turn.opened_at)
}

fn build_turn_entry(source: &mut dyn SelectionSource, turn: &SelectionTurn) -> ArrangementEntry {
    let mut rows = HashMap::new();
    let rendering = source.derivation(&turn.turn_id, "turn_rendering");
    if let Some(row) = rendering.clone() {
        rows.insert(format!("{}/turn_rendering", turn.turn_id), row);
    }
    let mut compression = None;
    if !usable(rendering.as_ref()) {
        compression = source.derivation(&turn.turn_id, "detailed_turn_compression");
        if let Some(row) = compression.clone() {
            rows.insert(format!("{}/detailed_turn_compression", turn.turn_id), row);
        }
    }
    let excerpt = if usable(rendering.as_ref()) || usable(compression.as_ref()) {
        None
    } else {
        source.turn_excerpt(&turn.turn_id)
    };
    let lookup = move |subject_id: &str, derivation_type: &str| {
        lookup_map(&rows, subject_id, derivation_type)
    };
    let rep = resolve_smooth_representation(&turn.turn_id, &lookup, excerpt.as_deref());
    let text = render_arrangement_entry(ViewSubjectKind::Turn, &turn.turn_id, &rep, &[], &[]);
    ArrangementEntry {
        band: Band::Smooth,
        subject_kind: ViewSubjectKind::Turn,
        subject_id: turn.turn_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order: turn_start_order(source, turn),
        tokens: estimate_tokens(&text),
        text,
    }
}

fn build_chunk_entry(
    source: &mut dyn SelectionSource,
    chunk: &SelectionChunk,
    band: Band,
    compact_point: i64,
    turns_by_id: &HashMap<String, SelectionTurn>,
    brief_budget: f64,
) -> Result<ArrangementEntry, CompactStoppedError> {
    let derivation_type = match band {
        Band::Detailed => "chunk_summary_detailed",
        Band::Brief => "chunk_summary_brief",
        Band::Smooth => unreachable!(),
    };
    let derivation = source.derivation(&chunk.chunk_id, derivation_type);
    let material = if usable(derivation.as_ref()) {
        None
    } else {
        source.chunk_material(&chunk.chunk_id, derivation_type)?
    };
    let mut rows = HashMap::new();
    if let Some(row) = derivation {
        rows.insert(format!("{}/{derivation_type}", chunk.chunk_id), row);
    }
    let lookup = move |subject_id: &str, kind: &str| lookup_map(&rows, subject_id, kind);
    let rep = match band {
        Band::Detailed => {
            resolve_detailed_representation(&chunk.chunk_id, &lookup, material.as_ref())
        }
        Band::Brief => {
            resolve_brief_representation(&chunk.chunk_id, &lookup, brief_budget, material.as_ref())
        }
        Band::Smooth => unreachable!(),
    };
    let text = render_arrangement_entry(
        ViewSubjectKind::Chunk,
        &chunk.chunk_id,
        &rep,
        &[],
        &chunk.member_turn_ids,
    );
    let member_starts: Vec<i64> = chunk
        .member_turn_ids
        .iter()
        .filter_map(|turn_id| turns_by_id.get(turn_id))
        .map(|turn| turn_start_order(source, turn))
        .collect();
    Ok(ArrangementEntry {
        band,
        subject_kind: ViewSubjectKind::Chunk,
        subject_id: chunk.chunk_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order: member_starts.into_iter().min().unwrap_or(compact_point),
        tokens: estimate_tokens(&text),
        text,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BandCrossing {
    Stop,
    Skip,
}

struct FillBandResult<T> {
    included: Vec<ArrangementEntry>,
    rest: Vec<T>,
    skipped: Vec<ArrangementEntry>,
}

fn fill_band<T, F>(
    candidates: &[T],
    band_budget: f64,
    crossing: BandCrossing,
    mut build: F,
) -> Result<FillBandResult<T>, CompactStoppedError>
where
    T: Clone,
    F: FnMut(&T) -> Result<ArrangementEntry, CompactStoppedError>,
{
    let mut included = Vec::new();
    let mut passed_over: Vec<(ArrangementEntry, usize)> = Vec::new();
    let mut sum = 0_i64;
    for (index, candidate) in candidates.iter().enumerate() {
        if crossing == BandCrossing::Skip && !included.is_empty() && (sum as f64) >= band_budget {
            let skipped = passed_over
                .into_iter()
                .filter(|(_, before)| *before < included.len())
                .map(|(entry, _)| entry)
                .collect();
            return Ok(FillBandResult {
                included,
                rest: candidates[index..].to_vec(),
                skipped,
            });
        }
        let entry = build(candidate)?;
        if (sum + entry.tokens) as f64 <= band_budget {
            sum += entry.tokens;
            included.push(entry);
            continue;
        }
        if included.is_empty() {
            sum += entry.tokens;
            included.push(entry);
            if crossing == BandCrossing::Stop {
                return Ok(FillBandResult {
                    included,
                    rest: candidates[index + 1..].to_vec(),
                    skipped: Vec::new(),
                });
            }
            continue;
        }
        if crossing == BandCrossing::Stop {
            return Ok(FillBandResult {
                included,
                rest: candidates[index..].to_vec(),
                skipped: Vec::new(),
            });
        }
        let before = included.len();
        passed_over.push((entry, before));
    }
    let skipped = passed_over
        .into_iter()
        .filter(|(_, before)| *before < included.len())
        .map(|(entry, _)| entry)
        .collect();
    Ok(FillBandResult {
        included,
        rest: Vec::new(),
        skipped,
    })
}

fn derivation_state(row: Option<&DerivationSnapshot>) -> String {
    row.map(|value| value.state.as_str().to_string())
        .unwrap_or_else(|| "missing".to_string())
}

fn ready_content(row: Option<&DerivationSnapshot>) -> Option<String> {
    match row {
        Some(row) if row.state == DerivationState::Ready => row.content.clone(),
        _ => None,
    }
}

fn build_coverage_entry(
    source: &mut dyn SelectionSource,
    turn: &SelectionTurn,
) -> ArrangementEntry {
    let compression = source.derivation(&turn.turn_id, "detailed_turn_compression");
    let assembly = source.derivation(&turn.turn_id, "pre_detailed_assembly");
    let rep = if let Some(body) = ready_content(compression.as_ref()) {
        ResolvedRepresentation {
            derivation_used: "detailed_turn_compression".into(),
            body,
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        }
    } else if let Some(body) = ready_content(assembly.as_ref()) {
        ResolvedRepresentation {
            derivation_used: "pre_detailed_assembly".into(),
            body,
            degraded: true,
            gap: false,
            degraded_marker: Some("coverage-from-pre-detailed-assembly".into()),
            reason: Some(format!(
                "detailed_turn_compression {}",
                derivation_state(compression.as_ref())
            )),
        }
    } else {
        ResolvedRepresentation {
            derivation_used: "gap".into(),
            body: String::new(),
            degraded: false,
            gap: true,
            degraded_marker: None,
            reason: Some(format!(
                "closed turn before compact point was not represented by selected bands (detailed_turn_compression: {}, pre_detailed_assembly: {})",
                derivation_state(compression.as_ref()),
                derivation_state(assembly.as_ref())
            )),
        }
    };
    let text = render_arrangement_entry(ViewSubjectKind::Turn, &turn.turn_id, &rep, &[], &[]);
    ArrangementEntry {
        band: Band::Detailed,
        subject_kind: ViewSubjectKind::Turn,
        subject_id: turn.turn_id.clone(),
        derivation_used: rep.derivation_used,
        degraded: rep.degraded,
        gap: rep.gap,
        reason: rep.reason,
        start_order: turn_start_order(source, turn),
        tokens: estimate_tokens(&text),
        text,
    }
}

pub fn walk_arrangement(
    source: &mut dyn SelectionSource,
    config: &SelectionConfig,
) -> Result<SelectionResult, CompactStoppedError> {
    let turns = source.turns();
    let chunks = source.chunks();
    let turns_by_id: HashMap<String, SelectionTurn> = turns
        .iter()
        .map(|turn| (turn.turn_id.clone(), turn.clone()))
        .collect();
    let full_budget = budget(config, config.percentages.full);
    let closed_turns: Vec<SelectionTurn> = turns
        .iter()
        .filter(|turn| turn.status == SelectionTurnStatus::Closed)
        .cloned()
        .collect();
    let mut compact_point = 0;
    if !closed_turns.is_empty() && source.has_placeable_messages() {
        if let Some((order, turn_id)) = source.crossing_message(full_budget) {
            if let Some(candidate) = turns_by_id.get(&turn_id) {
                compact_point = if candidate.status == SelectionTurnStatus::Open {
                    previous_close(&closed_turns, candidate)
                } else if order <= turn_start_order(source, candidate) {
                    previous_close(&closed_turns, candidate)
                } else {
                    let turn_tokens = source.turn_message_tokens(&candidate.turn_id);
                    let newer_tokens = candidate
                        .closed_at
                        .map(|closed| source.message_tokens_after(closed))
                        .unwrap_or(0);
                    let full_side = (full_budget - newer_tokens as f64)
                        .max(0.0)
                        .min(turn_tokens as f64);
                    let smooth_side = turn_tokens as f64 - full_side;
                    if full_side >= smooth_side {
                        previous_close(&closed_turns, candidate)
                    } else {
                        candidate.closed_at.unwrap_or(0)
                    }
                };
            }
        }
    }
    if let Some(upper) = config.compact_point_upper_bound
        && compact_point > upper
    {
        compact_point = closed_turns
            .iter()
            .filter_map(|turn| turn.closed_at.filter(|closed| *closed <= upper))
            .max()
            .unwrap_or(0);
    }

    let banded_turns: Vec<SelectionTurn> = closed_turns
        .iter()
        .filter(|turn| turn.closed_at.is_some_and(|closed| closed <= compact_point))
        .cloned()
        .collect();
    let banded_turn_ids: HashSet<String> = banded_turns
        .iter()
        .map(|turn| turn.turn_id.clone())
        .collect();
    let smooth_candidates: Vec<SelectionTurn> = banded_turns.iter().rev().cloned().collect();
    let smooth = fill_band(
        &smooth_candidates,
        budget(config, config.percentages.smooth),
        BandCrossing::Stop,
        |turn| Ok(build_turn_entry(source, turn)),
    )?;
    let oldest_smooth_order = smooth.included.iter().fold(i64::MAX, |oldest, entry| {
        oldest.min(
            turns_by_id
                .get(&entry.subject_id)
                .map(|turn| turn.turn_order)
                .unwrap_or(i64::MAX),
        )
    });

    let chunk_candidates: Vec<SelectionChunk> = chunks
        .iter()
        .filter(|chunk| chunk.status == SelectionChunkStatus::Closed)
        .filter(|chunk| {
            let newest = chunk
                .member_turn_ids
                .iter()
                .filter_map(|turn_id| turns_by_id.get(turn_id))
                .max_by_key(|turn| turn.turn_order);
            newest.is_some_and(|turn| {
                banded_turn_ids.contains(&turn.turn_id) && turn.turn_order < oldest_smooth_order
            })
        })
        .rev()
        .cloned()
        .collect();
    let brief_budget = budget(config, config.percentages.brief);
    let detailed = fill_band(
        &chunk_candidates,
        budget(config, config.percentages.detailed),
        BandCrossing::Stop,
        |chunk| {
            build_chunk_entry(
                source,
                chunk,
                Band::Detailed,
                compact_point,
                &turns_by_id,
                brief_budget,
            )
        },
    )?;
    let brief = fill_band(&detailed.rest, brief_budget, BandCrossing::Skip, |chunk| {
        build_chunk_entry(
            source,
            chunk,
            Band::Brief,
            compact_point,
            &turns_by_id,
            brief_budget,
        )
    })?;

    let selected_entries: Vec<&ArrangementEntry> = brief
        .included
        .iter()
        .chain(detailed.included.iter())
        .chain(smooth.included.iter())
        .collect();
    let chunks_by_id: HashMap<String, &SelectionChunk> = chunks
        .iter()
        .map(|chunk| (chunk.chunk_id.clone(), chunk))
        .collect();
    let mut covered_turn_ids = HashSet::new();
    let mut oldest_selected_turn_order = i64::MAX;
    for entry in selected_entries {
        if entry.subject_kind == ViewSubjectKind::Turn {
            covered_turn_ids.insert(entry.subject_id.clone());
            if let Some(turn) = turns_by_id.get(&entry.subject_id) {
                oldest_selected_turn_order = oldest_selected_turn_order.min(turn.turn_order);
            }
        } else if let Some(chunk) = chunks_by_id.get(&entry.subject_id) {
            for turn_id in &chunk.member_turn_ids {
                if let Some(turn) = turns_by_id.get(turn_id)
                    && banded_turn_ids.contains(turn_id)
                {
                    covered_turn_ids.insert(turn_id.clone());
                    oldest_selected_turn_order = oldest_selected_turn_order.min(turn.turn_order);
                }
            }
        }
    }
    for entry in &brief.skipped {
        if let Some(chunk) = chunks_by_id.get(&entry.subject_id) {
            for turn_id in &chunk.member_turn_ids {
                if banded_turn_ids.contains(turn_id) {
                    covered_turn_ids.insert(turn_id.clone());
                }
            }
        }
    }
    let mut coverage_gaps = Vec::new();
    for turn in &banded_turns {
        if turn.turn_order >= oldest_selected_turn_order
            && !covered_turn_ids.contains(&turn.turn_id)
        {
            coverage_gaps.push(build_coverage_entry(source, turn));
        }
    }

    let mut brief_entries = brief.included;
    brief_entries.sort_by_key(|entry| entry.start_order);
    let mut detailed_entries = detailed.included;
    detailed_entries.extend(coverage_gaps);
    detailed_entries.sort_by_key(|entry| entry.start_order);
    let mut smooth_entries = smooth.included;
    smooth_entries.sort_by_key(|entry| entry.start_order);
    let entries: Vec<ArrangementEntry> = brief_entries
        .into_iter()
        .chain(detailed_entries)
        .chain(smooth_entries)
        .collect();
    let covered_from = entries
        .iter()
        .map(|entry| entry.start_order)
        .min()
        .unwrap_or(compact_point);
    let skipped = brief
        .skipped
        .into_iter()
        .map(|entry| SkippedEntry {
            band: entry.band,
            subject_id: entry.subject_id,
            tokens: entry.tokens,
            reason: format!(
                "entry did not fit the remaining {} budget ({} tokens from {}); skipped so older entries could be selected",
                entry.band.as_str(), entry.tokens, entry.derivation_used
            ),
        })
        .collect();
    Ok(SelectionResult {
        compact_point,
        covered_from,
        entries,
        skipped,
    })
}
