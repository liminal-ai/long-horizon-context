//! Shared Smart Compact band walk, ported from `internal/walk.ts`.
//!
//! Both execution plans use this exact decision code. Sources differ only in
//! whether material is already eager in memory or loaded when a rung asks for
//! it. The turn-parts capability (split the open turn at a step edge, settle a
//! closed transition turn whole, protect the newest closed turn) is an optional
//! surface of the source: absent on the legacy plan, so the legacy walk can
//! neither split nor settle and its bytes are unchanged.

use std::collections::{HashMap, HashSet};

use crate::shared_tech::derivation::DerivationState;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{
    Band, PartRange, ProtectedRepresentation, ProtectedTurn, ReceiptPart, SettleConstruction,
    SettledTurn, SplitPoint, ViewSubjectKind,
};
use crate::turns::WholeTurnComposition;
use crate::turns::internal::steps::StepEdges;

use super::profiles::DEFAULT_NEWEST_CLOSED_PROTECTION;
use super::render::{
    CompactChunkMaterialSnapshot, DerivationSnapshot, ResolvedRepresentation,
    render_arrangement_entry, resolve_brief_representation, resolve_detailed_representation,
    resolve_smooth_representation,
};
use super::select::{
    ArrangementEntry, SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionResult,
    SelectionTurn, SelectionTurnStatus, SkippedEntry,
};
use super::snapshot::InstalledTransition;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactStoppedError {
    pub detail: String,
}

/// What the walk may ask of the record. Structure is eager because it is
/// bounded by turn and chunk counts; message facts are aggregates; excerpt and
/// fallback material are hydration points, reached only from the ladder rung
/// that renders them.
///
/// Turn parts (TS `PartsSource`): the optional capability the bounded plan on a
/// clean thread offers — the installed transition turn, step edges, and the
/// part / whole-turn constructions. The defaults are the legacy plan: no parts
/// source, so the walk can neither split nor settle.
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

    // ── turn parts: absent on the legacy plan ──────────────────────
    /// Whether this source offers the parts capability at all.
    fn has_parts_source(&self) -> bool {
        false
    }
    /// The installed view's transition turn with its part ranges; None when
    /// every served turn is whole (or no parts source).
    fn installed_transition(&self) -> Option<InstalledTransition> {
        None
    }
    /// Step edges of one turn from its host-supplied step indices.
    fn turn_steps(&mut self, _turn_id: &str) -> StepEdges {
        unreachable!("turn_steps asked of a source without a parts capability")
    }
    /// The part construction over one order span, ending in `trailer`.
    fn part_text(
        &mut self,
        _turn_id: &str,
        _from_order: i64,
        _to_order: i64,
        _trailer: &str,
    ) -> String {
        unreachable!("part_text asked of a source without a parts capability")
    }
    /// The whole-turn construction composed in-walk under the serving cap.
    fn whole_turn_text(&mut self, _turn_id: &str) -> Option<WholeTurnComposition> {
        None
    }
}

/// The seam line a part ends with: identity, range, direction — nothing else.
/// Position-independent by design: a part's bytes must not change when a later
/// compact appends another part after it (AC-4.1b), so the last part's marker
/// reads the same whether the tail or another part follows.
pub fn seam_marker(turn_id: &str, range: &PartRange) -> String {
    format!(
        "[seam · {turn_id} · steps {}–{} summarized above · {turn_id} resumes below]",
        range.from_step, range.to_step
    )
}

/// Ordinal k for a part range: how many steps of the turn the parts through
/// `to_step` cover. Zero when the step is unknown to the record.
fn ordinal_through(steps: &StepEdges, to_step: i64) -> usize {
    steps
        .steps
        .iter()
        .position(|step| step.index == to_step)
        .map(|at| at + 1)
        .unwrap_or(0)
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

/// Rule 1's snap: the compact point a crossing message implies.
fn snap_compact_point(
    source: &mut dyn SelectionSource,
    turns_by_id: &HashMap<String, SelectionTurn>,
    closed_turns: &[SelectionTurn],
    full_budget: f64,
    order: i64,
    turn_id: &str,
) -> i64 {
    // Every selected message resolves to a live turn: the source's message
    // population skipped the ones that do not.
    let Some(candidate) = turns_by_id.get(turn_id) else {
        return 0;
    };
    if candidate.status == SelectionTurnStatus::Open {
        // Open-turn messages are tail regardless of budget; the tail begins at
        // the open turn's start.
        return previous_close(closed_turns, candidate);
    }
    // Fully covered down to the turn's start ⇒ the tail begins at this turn.
    if order <= turn_start_order(source, candidate) {
        return previous_close(closed_turns, candidate);
    }
    // A partially-covered closed turn straddles the full-budget line. Round
    // toward the side holding at least half of the turn's tokens (ties stay in
    // full). The split is at the exact budget line, even when that line falls
    // inside the crossing message's estimate.
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
        previous_close(closed_turns, candidate)
    } else {
        candidate.closed_at.unwrap_or(0)
    }
}

/// The ordinary smooth ladder for one turn: stored rendering → stored
/// compression → excerpt.
fn ordinary_smooth_rep(
    source: &mut dyn SelectionSource,
    turn: &SelectionTurn,
) -> ResolvedRepresentation {
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
    resolve_smooth_representation(&turn.turn_id, &lookup, excerpt.as_deref())
}

struct WholeConstruction {
    rep: ResolvedRepresentation,
    construction: SettleConstruction,
}

/// The whole construction from canonical, with the construction reference the
/// settle record carries. Never the excerpt or compression rung.
///
/// With a parts source (the bounded plan on a clean thread) a ready stored
/// rendering is never parsed or truncated: the turn is recomposed from
/// canonical and its ready message derivations under the serving cap (F1),
/// and the cap decides. When no message's construction is over the cap the
/// stored row is served as the stored construction — what the legacy plan
/// serves; when the cap elided anything the capped recomposition is served
/// and reported truthfully as composed_in_walk. Without a parts source the
/// stored row serves unchanged.
fn resolve_whole_construction(
    source: &mut dyn SelectionSource,
    parts_enabled: bool,
    turn: &SelectionTurn,
    require_stored: bool,
) -> Option<WholeConstruction> {
    let rendering = source.derivation(&turn.turn_id, "turn_rendering");
    let stored = match &rendering {
        Some(DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some(content),
            ..
        }) => Some(content.clone()),
        _ => None,
    };
    if stored.is_none() && require_stored {
        return None;
    }
    let composed = if parts_enabled {
        source.whole_turn_text(&turn.turn_id)
    } else {
        None
    };
    if let Some(stored) = stored
        && composed.as_ref().is_none_or(|c| !c.capped)
    {
        return Some(WholeConstruction {
            rep: ResolvedRepresentation {
                derivation_used: "turn_rendering".to_string(),
                body: stored,
                degraded: false,
                gap: false,
                degraded_marker: None,
                reason: None,
            },
            construction: SettleConstruction::Stored {
                subject_id: turn.turn_id.clone(),
                derivation_type: "turn_rendering".to_string(),
                source_version: rendering.and_then(|r| r.source_version).unwrap_or(1),
            },
        });
    }
    composed.map(|composed| WholeConstruction {
        rep: ResolvedRepresentation {
            derivation_used: "composed_in_walk".to_string(),
            body: composed.text,
            degraded: false,
            gap: false,
            degraded_marker: None,
            reason: None,
        },
        construction: SettleConstruction::ComposedInWalk {
            turn_id: turn.turn_id.clone(),
        },
    })
}

/// How smooth turn entries resolve on this walk (TS `buildTurnEntry`'s
/// closed-over state).
struct TurnEntryPolicy {
    parts_enabled: bool,
    settling_turn_id: Option<String>,
    protected_whole_turn_id: Option<String>,
}

fn build_turn_entry(
    source: &mut dyn SelectionSource,
    policy: &TurnEntryPolicy,
    turn: &SelectionTurn,
    settled_record: &mut Option<SettledTurn>,
) -> ArrangementEntry {
    let mut rep: Option<ResolvedRepresentation> = None;
    if policy.settling_turn_id.as_deref() == Some(turn.turn_id.as_str()) {
        if let Some(whole) = resolve_whole_construction(source, policy.parts_enabled, turn, false) {
            *settled_record = Some(SettledTurn {
                turn_id: turn.turn_id.clone(),
                construction: whole.construction,
            });
            rep = Some(whole.rep);
        }
    } else if policy.protected_whole_turn_id.as_deref() == Some(turn.turn_id.as_str()) {
        rep = resolve_whole_construction(source, policy.parts_enabled, turn, false).map(|w| w.rep);
    } else if policy.parts_enabled {
        // Ordinary smooth rung on the bounded plan: a ready stored rendering is
        // served under the cap; anything else takes the ordinary ladder.
        rep = resolve_whole_construction(source, policy.parts_enabled, turn, true).map(|w| w.rep);
    }
    let rep = rep.unwrap_or_else(|| ordinary_smooth_rep(source, turn));
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
        part: None,
    }
}

fn build_chunk_entry(
    source: &mut dyn SelectionSource,
    chunk: &SelectionChunk,
    band: Band,
    compact_point: i64,
    turns_by_id: &HashMap<String, SelectionTurn>,
    brief_share: f64,
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
            resolve_brief_representation(&chunk.chunk_id, &lookup, brief_share, material.as_ref())
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
        part: None,
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

/// The one fill rule, shared by all three bands: newest-first whole-entry
/// fill, <= inclusion, the first crossing entry included only when the band
/// was still empty — except a band whose share the precedence cascade consumed
/// entirely (`admit_first == false` with no budget), which stays empty.
fn fill_band<T, F>(
    candidates: &[T],
    band_budget: f64,
    crossing: BandCrossing,
    admit_first: bool,
    mut build: F,
) -> Result<FillBandResult<T>, CompactStoppedError>
where
    T: Clone,
    F: FnMut(&T) -> Result<ArrangementEntry, CompactStoppedError>,
{
    if !admit_first && band_budget <= 0.0 {
        return Ok(FillBandResult {
            included: Vec::new(),
            rest: candidates.to_vec(),
            skipped: Vec::new(),
        });
    }
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
        part: None,
    }
}

/// A planned split: the transition turn, its step edges, and the part ranges
/// (installed ones first, then the new range this walk adds).
struct PartsPlan {
    turn: SelectionTurn,
    steps: StepEdges,
    ranges: Vec<PartRange>,
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

    // Rule 1 — compact point: messages newest-first until the estimate sum
    // first reaches the full share; the point snaps to a turn boundary so the
    // tail never begins mid-turn. Open-turn messages always land in the tail.
    let full_budget = budget(config, config.percentages.full);
    let closed_turns: Vec<SelectionTurn> = turns
        .iter()
        .filter(|turn| turn.status == SelectionTurnStatus::Closed)
        .cloned()
        .collect();
    let open_turn: Option<SelectionTurn> = turns
        .iter()
        .find(|turn| turn.status == SelectionTurnStatus::Open)
        .cloned();
    // A compact point upper bound is the protected-pair clamp of the
    // forced-boundary runtime. Per-thread exclusivity (AC-7.3) means it never
    // meets a thread that has served parts; if it does, the invariant is
    // broken above this walk and the walk says so rather than splitting under
    // a clamp it cannot honor. Under a bound on a clean thread, no split.
    let installed = if source.has_parts_source() {
        source.installed_transition()
    } else {
        None
    };
    if config.compact_point_upper_bound.is_some()
        && let Some(installed) = installed.as_ref()
    {
        panic!(
            "turn parts invariant violated: compactPointUpperBound on a thread serving parts of {}",
            installed.turn_id
        );
    }
    let parts_enabled = config.compact_point_upper_bound.is_none() && source.has_parts_source();
    let mut compact_point = 0;
    // The crossing is read whenever a closed turn can be banded — and, with a
    // parts source, whenever the open turn alone could need splitting.
    let crossing = if (!closed_turns.is_empty() || parts_enabled) && source.has_placeable_messages()
    {
        source.crossing_message(full_budget)
    } else {
        None
    };
    if !closed_turns.is_empty() {
        // Budget never reached ⇒ the whole record fits the full share:
        // everything is tail, no bands.
        compact_point = match &crossing {
            None => 0,
            Some((order, turn_id)) => snap_compact_point(
                source,
                &turns_by_id,
                &closed_turns,
                full_budget,
                *order,
                turn_id,
            ),
        };
    }
    if let Some(upper) = config.compact_point_upper_bound
        && compact_point > upper
    {
        // Snap backward to the greatest legal closed-turn boundary <= the upper
        // bound. Compact points must land on a real turn.closed_at (or 0); a raw
        // numeric clamp could split a turn and violate selector/view invariants.
        compact_point = closed_turns
            .iter()
            .filter_map(|turn| turn.closed_at.filter(|closed| *closed <= upper))
            .max()
            .unwrap_or(0);
    }

    // ── turn parts: the transition turn, settle, and the split point ──
    //
    // The installed view names at most one transition turn. When it is closed,
    // it settles here iff the ordinary compact point would band it (the walk
    // never serves it whole-unsettled: short of settle it keeps its parts and
    // the compact point stays on its installed edge). Only with no other turn
    // left unsettled may the open turn split, at the smallest complete step
    // edge whose verbatim tail fits the full share (inclusive), clamped up to
    // the installed k so a split point never moves backward.
    let mut settling: Option<SelectionTurn> = None;
    let mut settled_record: Option<SettledTurn> = None;
    let mut parts_plan: Option<PartsPlan> = None;
    if parts_enabled {
        let installed_turn = installed
            .as_ref()
            .and_then(|installed| turns_by_id.get(&installed.turn_id))
            .cloned();
        if let (Some(installed), Some(installed_turn)) = (installed.as_ref(), installed_turn)
            && !installed.parts.is_empty()
        {
            let steps = source.turn_steps(&installed_turn.turn_id);
            let last_installed = installed.parts[installed.parts.len() - 1];
            let installed_edge = steps
                .steps
                .iter()
                .find(|step| step.index == last_installed.to_step)
                .map(|step| step.last_order);
            if installed_turn.status == SelectionTurnStatus::Closed
                && let Some(closed_at) = installed_turn.closed_at
            {
                if compact_point >= closed_at {
                    settling = Some(installed_turn);
                } else if let Some(edge) = installed_edge {
                    compact_point = edge;
                    parts_plan = Some(PartsPlan {
                        turn: installed_turn,
                        steps,
                        ranges: installed.parts.clone(),
                    });
                }
            }
        }
        if parts_plan.is_none()
            && let Some(open) = open_turn.as_ref()
        {
            let prior = installed.as_ref().filter(|installed| {
                installed.turn_id == open.turn_id && !installed.parts.is_empty()
            });
            let steps = source.turn_steps(&open.turn_id);
            let prior_k = prior
                .map(|prior| ordinal_through(&steps, prior.parts[prior.parts.len() - 1].to_step))
                .unwrap_or(0);
            let k_max = if steps.splittable {
                steps.last_edge.unwrap_or(0)
            } else {
                prior_k
            };
            let mut k_computed = 0usize;
            if let Some((_, crossing_turn_id)) = &crossing
                && crossing_turn_id == &open.turn_id
                && k_max > 0
            {
                // The open turn alone reaches the full share. Smallest k whose tail
                // fits (<=); when none does, the minimum verbatim tail is served —
                // elder bands absorb the overrun.
                k_computed = k_max;
                for k in 1..=k_max {
                    let edge = steps.steps[k - 1].last_order;
                    if (source.message_tokens_after(edge) as f64) <= full_budget {
                        k_computed = k;
                        break;
                    }
                }
            }
            let k = k_computed.max(prior_k);
            if k > 0 {
                compact_point = steps.steps[k - 1].last_order;
                let mut ranges: Vec<PartRange> =
                    prior.map(|prior| prior.parts.clone()).unwrap_or_default();
                if k > prior_k {
                    ranges.push(PartRange {
                        from_step: steps.steps[prior_k].index,
                        to_step: steps.steps[k - 1].index,
                    });
                }
                parts_plan = Some(PartsPlan {
                    turn: open.clone(),
                    steps,
                    ranges,
                });
            }
        }
    }

    // ── Flow 5: the newest closed turn is protected by placement ──
    //
    // Precedence: (1) the active turn's minimum verbatim tail; (2) the newest
    // closed turn full when its verbatim cost fits min(fraction × lower bound,
    // what (1) left); (3)–(4) the extended tail and elder bands take the rest.
    //
    // The served view is contiguous — bands, then one verbatim tail from the
    // compact point — so a full newest closed turn puts everything newer than
    // it in the tail too. Under a planned split, (1) therefore reserves the
    // whole active turn, and a turn already served as parts can never be
    // followed by a full closed turn (k never moves backward). A turn that does
    // not fit takes its whole deterministic rendering — stored or composed
    // in-walk — never an excerpt. Requires the parts source (the bounded plan
    // on a clean thread): the legacy plan is byte-unchanged.
    let mut protected_record: Option<ProtectedTurn> = None;
    let newest_closed = closed_turns.last().cloned();
    let transition_turn_id: Option<String> = parts_plan
        .as_ref()
        .map(|plan| plan.turn.turn_id.clone())
        .or_else(|| settling.as_ref().map(|turn| turn.turn_id.clone()));
    if parts_enabled
        && let Some(newest) = newest_closed.as_ref()
        && let Some(newest_closed_at) = newest.closed_at
        && transition_turn_id.as_deref() != Some(newest.turn_id.as_str())
        && newest_closed_at <= compact_point
    {
        let fraction = config
            .newest_closed_protection
            .unwrap_or(DEFAULT_NEWEST_CLOSED_PROTECTION);
        let active_already_split = match (installed.as_ref(), open_turn.as_ref()) {
            (Some(installed), Some(open)) => installed.turn_id == open.turn_id,
            _ => false,
        };
        let reserve = match (parts_plan.as_ref(), open_turn.as_ref()) {
            (Some(_), Some(open)) => source.turn_message_tokens(&open.turn_id),
            _ => source.message_tokens_after(compact_point),
        };
        let bound = (fraction * config.lower_bound).min(config.lower_bound - reserve as f64);
        let verbatim_cost = source.turn_message_tokens(&newest.turn_id);
        if !active_already_split && (verbatim_cost as f64) <= bound {
            compact_point = previous_close(&closed_turns, newest);
            parts_plan = None;
            protected_record = Some(ProtectedTurn {
                turn_id: newest.turn_id.clone(),
                representation: ProtectedRepresentation::Full,
            });
        } else {
            protected_record = Some(ProtectedTurn {
                turn_id: newest.turn_id.clone(),
                representation: ProtectedRepresentation::WholeRendering,
            });
        }
    }

    // Band candidates: closed turns wholly behind the compact point. Rule 5 is
    // structural here — chunked or not, a banded turn is a smooth candidate
    // (bands are defined by representation, not strict time strata).
    let banded_turns: Vec<SelectionTurn> = closed_turns
        .iter()
        .filter(|turn| turn.closed_at.is_some_and(|closed| closed <= compact_point))
        .cloned()
        .collect();
    let banded_turn_ids: HashSet<String> = banded_turns
        .iter()
        .map(|turn| turn.turn_id.clone())
        .collect();

    let policy = TurnEntryPolicy {
        parts_enabled,
        settling_turn_id: settling.as_ref().map(|turn| turn.turn_id.clone()),
        protected_whole_turn_id: protected_record
            .as_ref()
            .filter(|p| p.representation == ProtectedRepresentation::WholeRendering)
            .map(|p| p.turn_id.clone()),
    };

    // Turn parts: one entry per part, composed independently over its own
    // order span, each ending in its seam line. Parts are the newest smooth
    // material and are always included; they consume the smooth share first.
    let mut part_entries: Vec<ArrangementEntry> = Vec::new();
    if let Some(plan) = parts_plan.as_ref() {
        let mut from_order = turn_start_order(source, &plan.turn);
        for range in &plan.ranges {
            let Some(to_order) = plan
                .steps
                .steps
                .iter()
                .find(|step| step.index == range.to_step)
                .map(|step| step.last_order)
            else {
                panic!(
                    "turn parts: installed part {} step {} is unknown to the record",
                    plan.turn.turn_id, range.to_step
                );
            };
            let text = source.part_text(
                &plan.turn.turn_id,
                from_order,
                to_order,
                &seam_marker(&plan.turn.turn_id, range),
            );
            part_entries.push(ArrangementEntry {
                band: Band::Smooth,
                subject_kind: ViewSubjectKind::Turn,
                subject_id: plan.turn.turn_id.clone(),
                derivation_used: "part".to_string(),
                degraded: false,
                gap: false,
                reason: None,
                start_order: from_order,
                tokens: estimate_tokens(&text),
                text,
                part: Some(*range),
            });
            from_order = to_order + 1;
        }
    }
    let part_tokens: i64 = part_entries.iter().map(|entry| entry.tokens).sum();

    // Precedence (4): the placements this mechanism makes — a split, a settle,
    // a lazy keep, newest-closed protection — may leave the verbatim tail over
    // the full share. That overrun, with the part tokens, cascades through the
    // elder shares smooth → detailed → brief, so the served view stays within
    // the bound (plus at most one entry's slack per band that keeps a share);
    // a share the cascade consumes entirely yields an empty band. An ordinary
    // walk (Rule 1's straddle rounding alone) is untouched.
    let mechanism_placement =
        parts_plan.is_some() || settling.is_some() || protected_record.is_some();
    let tail_overrun = if mechanism_placement {
        (source.message_tokens_after(compact_point) as f64 - full_budget).max(0.0)
    } else {
        0.0
    };

    // Mandatory smooth entries: a settling turn's whole construction (AC-3.2,
    // AC-3.4) and a protected turn's whole rendering (AC-5.2) are placements,
    // not fill candidates — served whatever the share, priced against it first.
    let mut mandatory_turn_ids: HashSet<String> = HashSet::new();
    if let Some(id) = policy.settling_turn_id.as_ref() {
        mandatory_turn_ids.insert(id.clone());
    }
    if let Some(id) = policy.protected_whole_turn_id.as_ref() {
        mandatory_turn_ids.insert(id.clone());
    }
    let mandatory_entries: Vec<ArrangementEntry> = banded_turns
        .iter()
        .filter(|turn| mandatory_turn_ids.contains(&turn.turn_id))
        .map(|turn| build_turn_entry(source, &policy, turn, &mut settled_record))
        .collect();
    let mandatory_tokens: i64 = mandatory_entries.iter().map(|entry| entry.tokens).sum();
    let mut carry = part_tokens as f64 + mandatory_tokens as f64 + tail_overrun;
    let cascading = carry > 0.0;
    let mut share_after_carry = |percentage: f64| -> f64 {
        let share = budget(config, percentage);
        let usable = (share - carry).max(0.0);
        carry = (carry - share).max(0.0);
        usable
    };
    let smooth_budget = share_after_carry(config.percentages.smooth);
    let detailed_budget = share_after_carry(config.percentages.detailed);
    let brief_budget = share_after_carry(config.percentages.brief);

    // Rule 2 + 5 — smooth band: banded closed turns newest-first, chunked or
    // not (rule 5 is structural: a closed-but-unchunked turn is a turn, takes
    // the smooth representation, and consumes this budget).
    let smooth_candidates: Vec<SelectionTurn> = banded_turns
        .iter()
        .rev()
        .filter(|turn| !mandatory_turn_ids.contains(&turn.turn_id))
        .cloned()
        .collect();
    let mut smooth = fill_band(
        &smooth_candidates,
        smooth_budget,
        BandCrossing::Stop,
        !cascading,
        |turn| Ok(build_turn_entry(source, &policy, turn, &mut settled_record)),
    )?;
    smooth.included.extend(mandatory_entries);
    smooth.included.extend(part_entries);
    let oldest_smooth_order = smooth
        .included
        .iter()
        .filter(|entry| entry.part.is_none())
        .fold(i64::MAX, |oldest, entry| {
            oldest.min(
                turns_by_id
                    .get(&entry.subject_id)
                    .map(|turn| turn.turn_order)
                    .unwrap_or(i64::MAX),
            )
        });

    // Rules 3–4 — chunk candidacy: chunks entirely older than the smooth
    // band's coverage, with the pinned tie-breaker doing the deciding — chunk
    // coverage is its NEWEST member turn, which must sit behind the compact
    // point and be older than the smooth band's oldest included turn.
    // A chunk holding the still-unsettled transition turn is not a band
    // candidate until that turn settles.
    let unsettled_closed_turn_id: Option<String> = parts_plan
        .as_ref()
        .filter(|plan| plan.turn.status == SelectionTurnStatus::Closed)
        .map(|plan| plan.turn.turn_id.clone());
    let chunk_candidates: Vec<SelectionChunk> = chunks
        .iter()
        .filter(|chunk| chunk.status == SelectionChunkStatus::Closed)
        .filter(|chunk| {
            unsettled_closed_turn_id
                .as_ref()
                .is_none_or(|unsettled| !chunk.member_turn_ids.contains(unsettled))
        })
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
    let brief_share = budget(config, config.percentages.brief);
    // Rule 3 — detailed: same fill rule against its share.
    let detailed = fill_band(
        &chunk_candidates,
        detailed_budget,
        BandCrossing::Stop,
        !cascading,
        |chunk| {
            build_chunk_entry(
                source,
                chunk,
                Band::Detailed,
                compact_point,
                &turns_by_id,
                brief_share,
            )
        },
    )?;
    // Rule 4 — brief: the remaining chunks, same fill rule against its share,
    // skipping (not stopping at) entries too large for the remaining budget —
    // this is the last band, so a stop here would drop every older chunk.
    let brief = fill_band(
        &detailed.rest,
        brief_budget,
        BandCrossing::Skip,
        !cascading,
        |chunk| {
            build_chunk_entry(
                source,
                chunk,
                Band::Brief,
                compact_point,
                &turns_by_id,
                brief_share,
            )
        },
    )?;

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
    // Coverage invariant: every closed turn behind the compact point must be
    // represented by a selected turn, represented by a selected chunk's
    // membership, or explicitly surfaced as a smooth gap.
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
    // A skipped chunk's turns are accounted for — as a recorded gap, not as
    // content.
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
    // The coverage edge is the oldest INCLUDED entry: a skipped subject inside
    // the window is a hole in coverage that already extends past it.
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

    // The one invariant: at most one turn is unsettled at compact completion,
    // and a turn settled here is not also served as parts.
    let mut unsettled: Vec<String> = Vec::new();
    for entry in entries.iter().filter(|entry| entry.part.is_some()) {
        if !unsettled.contains(&entry.subject_id) {
            unsettled.push(entry.subject_id.clone());
        }
    }
    if unsettled.len() > 1
        || settling
            .as_ref()
            .is_some_and(|turn| unsettled.contains(&turn.turn_id))
    {
        panic!(
            "turn parts invariant violated: unsettled turns [{}]",
            unsettled.join(", ")
        );
    }

    let (parts, split_point) = match parts_plan.as_ref() {
        None => (None, None),
        Some(plan) => (
            Some(
                plan.ranges
                    .iter()
                    .map(|range| ReceiptPart {
                        turn_id: plan.turn.turn_id.clone(),
                        from_step: range.from_step,
                        to_step: range.to_step,
                    })
                    .collect(),
            ),
            Some(SplitPoint {
                turn_id: plan.turn.turn_id.clone(),
                step_index: plan.ranges[plan.ranges.len() - 1].to_step,
            }),
        ),
    };
    Ok(SelectionResult {
        compact_point,
        covered_from,
        entries,
        skipped,
        parts,
        split_point,
        settled: settled_record,
        protected_turn: protected_record,
    })
}
