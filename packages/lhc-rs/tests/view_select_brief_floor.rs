//! Ported from packages/lhc/test/view-select-brief-floor.test.ts.
//!
//! The brief band's two failure defenses, from the production incident where a
//! chunk whose brief derivation never landed rendered its whole uncompressed
//! fallback, and the brief walk stopped there — silently dropping every older
//! chunk although each had a healthy, small brief.
//!
//!   - the walk: brief is the last band, so an entry that does not fit is
//!     skipped (recorded as a gap) and the walk continues to older candidates.
//!   - the floor: a brief that fell back to larger material is capped at 5% of
//!     the brief band budget (never below 200 tokens) with a terminal marker,
//!     so the failure costs the band a brief-sized entry, not a body-sized one.
//!
//! Selection is exercised through `select_arrangement` directly (pure over its
//! inputs); the floor is exercised through the ladder resolver it lives in.

use indexmap::IndexMap;
use lhc::shared_tech::derivation::DerivationState;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{Band, ViewProfilePercentages};
use lhc::thread_view::internal::render::{
    CompactChunkMaterialSnapshot, DerivationLookup, DerivationSnapshot, brief_fallback_cap_tokens,
    resolve_brief_representation,
};
use lhc::thread_view::internal::select::{
    SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionInputs, SelectionMessage,
    SelectionResult, SelectionTurn, SelectionTurnStatus, select_arrangement,
};

/// full 250 (t8 alone), smooth 10 (t7 alone), detailed 40 (c6 alone as an
/// oversized loner), brief 700 for the remaining chunks c5…c1.
fn params() -> SelectionConfig {
    SelectionConfig {
        lower_bound: 1000.0,
        percentages: ViewProfilePercentages {
            full: 25.0,
            smooth: 1.0,
            detailed: 4.0,
            brief: 70.0,
        },
    }
}

const BRIEF_BUDGET: f64 = 700.0;
const CHUNK_IDS: [&str; 6] = ["c1", "c2", "c3", "c4", "c5", "c6"];

/// ~2251 tokens: more than three times the whole brief band budget, the shape
/// of an uncompressed fallback standing in for a failed brief.
fn oversized_body() -> String {
    "chunk detail line ".repeat(750)
}

fn ready(content: &str) -> DerivationSnapshot {
    DerivationSnapshot {
        state: DerivationState::Ready,
        content: Some(content.to_string()),
        reason: None,
    }
}

fn failed(reason: &str) -> DerivationSnapshot {
    DerivationSnapshot {
        state: DerivationState::Failed,
        content: None,
        reason: Some(reason.to_string()),
    }
}

#[derive(Default)]
struct IncidentOptions {
    brief_override: Option<DerivationSnapshot>,
    brief_material: Option<CompactChunkMaterialSnapshot>,
}

/// Eight closed turns, one message each; t1…t6 are single-turn chunks, t7 is
/// the smooth band's one entry, t8's 500 tokens put the compact point at t7's
/// close.
fn incident_inputs(options: IncidentOptions) -> SelectionInputs {
    let turns: Vec<SelectionTurn> = (0..8)
        .map(|index| SelectionTurn {
            turn_id: format!("t{}", index + 1),
            turn_order: index + 1,
            status: SelectionTurnStatus::Closed,
            opened_at: index * 10 + 1,
            closed_at: Some((index + 1) * 10),
        })
        .collect();
    let messages: Vec<SelectionMessage> = turns
        .iter()
        .map(|turn| SelectionMessage {
            message_id: format!("m{}", turn.turn_order),
            order: turn.opened_at,
            kind: "user_prompt".to_string(),
            token_estimate: if turn.turn_id == "t8" { 500 } else { 10 },
            turn_id: turn.turn_id.clone(),
            text: format!("prompt {}", turn.turn_id),
        })
        .collect();
    let chunks: Vec<SelectionChunk> = CHUNK_IDS
        .iter()
        .enumerate()
        .map(|(index, chunk_id)| SelectionChunk {
            chunk_id: (*chunk_id).to_string(),
            chunk_order: (index as i64) + 1,
            status: SelectionChunkStatus::Closed,
            member_turn_ids: vec![format!("t{}", index + 1)],
        })
        .collect();

    let mut derivations: IndexMap<String, DerivationSnapshot> = IndexMap::new();
    derivations.insert("t7/turn_rendering".to_string(), ready("rendered turn t7"));
    for chunk_id in CHUNK_IDS {
        // Detailed material is deliberately larger than the detailed share, so
        // c6 takes that band alone and c5…c1 arrive at brief.
        derivations.insert(
            format!("{chunk_id}/chunk_summary_detailed"),
            ready(&format!("detailed summary line {chunk_id} ").repeat(15)),
        );
        derivations.insert(
            format!("{chunk_id}/chunk_summary_brief"),
            ready(&format!("brief summary for chunk {chunk_id}")),
        );
    }
    if let Some(brief_override) = options.brief_override {
        derivations.insert("c3/chunk_summary_brief".to_string(), brief_override);
    }

    let mut compact_chunk_materials: IndexMap<String, CompactChunkMaterialSnapshot> =
        IndexMap::new();
    if let Some(material) = options.brief_material {
        compact_chunk_materials.insert("c3/chunk_summary_brief".to_string(), material);
    }

    SelectionInputs {
        messages,
        turns,
        chunks,
        derivations,
        compact_chunk_materials: Some(compact_chunk_materials),
        max_event_order: 80,
        derivation_counts: IndexMap::new(),
    }
}

fn brief_subjects(selection: &SelectionResult) -> Vec<String> {
    selection
        .entries
        .iter()
        .filter(|entry| entry.band == Band::Brief)
        .map(|entry| entry.subject_id.clone())
        .collect()
}

// ── brief band: a chunk whose brief derivation failed ─────────────

#[test]
fn capped_to_failure_floor_and_every_older_healthy_chunk_still_lands_in_the_band() {
    let selection = select_arrangement(
        &incident_inputs(IncidentOptions {
            brief_override: Some(failed("provider timeout")),
            brief_material: Some(CompactChunkMaterialSnapshot::Concat {
                content: oversized_body(),
                reason: "failed_floor".to_string(),
            }),
        }),
        &params(),
    )
    .expect("selection");

    // The incident's regression: c2 and c1 sit behind the bad chunk.
    assert_eq!(brief_subjects(&selection), ["c1", "c2", "c3", "c4", "c5"]);
    assert_eq!(selection.skipped, []);
    assert_eq!(selection.covered_from, 1); // t1's oldest message

    let bad = selection
        .entries
        .iter()
        .find(|entry| entry.subject_id == "c3")
        .expect("c3 entry");
    assert!(bad.degraded);
    assert_eq!(bad.derivation_used, "stored_member_concat");
    assert!(
        bad.text.ends_with(" tokens of content truncated]")
            && bad.text.contains("[compression failed: ~"),
        "unexpected terminal marker: {:?}",
        &bad.text[bad.text.len().saturating_sub(80)..]
    );
    // Reported post-truncation: the cap plus the ladder's own [degraded: …]
    // line, not the multi-thousand-token body.
    assert!((estimate_tokens(&oversized_body()) as f64) > 3.0 * BRIEF_BUDGET);
    assert!((bad.tokens as f64) < brief_fallback_cap_tokens(BRIEF_BUDGET) + 20.0);
}

// ── brief band: an entry too large for the remaining budget ───────

#[test]
fn skipped_with_a_gap_note_while_older_entries_continue_to_be_selected() {
    // A ready brief is never capped, so this reaches the walk oversized —
    // the walk fix on its own, with the failure floor out of the picture.
    let selection = select_arrangement(
        &incident_inputs(IncidentOptions {
            brief_override: Some(ready(&oversized_body())),
            brief_material: None,
        }),
        &params(),
    )
    .expect("selection");

    assert_eq!(brief_subjects(&selection), ["c1", "c2", "c4", "c5"]);
    assert_eq!(selection.covered_from, 1);
    assert_eq!(selection.skipped.len(), 1);
    let skip = &selection.skipped[0];
    assert_eq!(skip.band, Band::Brief);
    assert_eq!(skip.subject_id, "c3");
    assert!((skip.tokens as f64) > BRIEF_BUDGET);
    assert!(skip.reason.contains(&skip.tokens.to_string()));
    // The skipped chunk's turns are accounted for by the gap note, not
    // answered with unbudgeted detailed material.
    assert!(
        selection
            .entries
            .iter()
            .all(|entry| entry.subject_id != "t3")
    );
}

// ── brief failure floor ───────────────────────────────────────────

fn failed_brief_lookup() -> Box<DerivationLookup> {
    Box::new(|_subject_id: &str, derivation_type: &str| {
        if derivation_type == "chunk_summary_brief" {
            Some(failed("provider timeout"))
        } else {
            None
        }
    })
}

fn fallback(band_budget: f64) -> String {
    resolve_brief_representation(
        "c3",
        failed_brief_lookup().as_ref(),
        band_budget,
        Some(&CompactChunkMaterialSnapshot::Concat {
            content: oversized_body(),
            reason: "failed_floor".to_string(),
        }),
    )
    .body
}

#[test]
fn caps_at_five_percent_of_the_brief_band_budget_above_the_floor() {
    assert_eq!(brief_fallback_cap_tokens(8000.0), 400.0);
    assert!(estimate_tokens(&fallback(8000.0)) <= 400);
    assert!(estimate_tokens(&fallback(8000.0)) > 300);
}

#[test]
fn caps_at_two_hundred_tokens_where_five_percent_would_fall_below_it() {
    assert_eq!(brief_fallback_cap_tokens(4000.0), 200.0); // the crossover
    assert_eq!(brief_fallback_cap_tokens(1000.0), 200.0);
    assert!(estimate_tokens(&fallback(1000.0)) <= 200);
    assert!(estimate_tokens(&fallback(1000.0)) > 150);
}

#[test]
fn marks_the_truncation_with_the_tokens_it_dropped_and_degrades_the_representation() {
    let rep = resolve_brief_representation(
        "c3",
        failed_brief_lookup().as_ref(),
        BRIEF_BUDGET,
        Some(&CompactChunkMaterialSnapshot::Concat {
            content: oversized_body(),
            reason: "failed_floor".to_string(),
        }),
    );
    let marker_open = "[compression failed: ~";
    let marker_close = " tokens of content truncated]";
    assert!(rep.body.ends_with(marker_close), "no terminal marker");
    let start = rep.body.rfind(marker_open).expect("marker open");
    let dropped: i64 = rep.body[start + marker_open.len()..rep.body.len() - marker_close.len()]
        .parse()
        .expect("dropped token count");
    assert!(dropped > estimate_tokens(&oversized_body()) - 250);
    assert!(rep.degraded);
    assert_eq!(
        rep.degraded_marker.as_deref(),
        Some("brief-from-stored-members")
    );
}

#[test]
fn never_truncates_a_ready_brief_however_large() {
    let body = oversized_body();
    let ready_lookup: Box<DerivationLookup> = {
        let body = body.clone();
        Box::new(move |_subject_id: &str, derivation_type: &str| {
            if derivation_type == "chunk_summary_brief" {
                Some(ready(&body))
            } else {
                None
            }
        })
    };
    let rep = resolve_brief_representation("c3", ready_lookup.as_ref(), 100.0, None);
    assert_eq!(rep.body, body);
    assert!(!rep.degraded);
    assert_eq!(rep.derivation_used, "chunk_summary_brief");
}
