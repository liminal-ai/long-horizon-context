//! Ported from the F6 cases in packages/lhc/test/view-select-brief-floor.test.ts.
//!
//! Exercises the production walk (`walk_arrangement`), not the leftover
//! `select_arrangement` copy in select.rs.

use indexmap::IndexMap;
use lhc::shared_tech::derivation::DerivationState;
use lhc::shared_tech::view::{Band, ViewProfilePercentages, ViewSubjectKind};
use lhc::thread_view::internal::render::DerivationSnapshot;
use lhc::thread_view::internal::select::{
    EagerSelectionSource, SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionInputs,
    SelectionMessage, SelectionResult, SelectionTurn, SelectionTurnStatus,
};
use lhc::thread_view::internal::walk::walk_arrangement;
use pretty_assertions::assert_eq;

/// full 250 (newest turn's 300-token message), smooth 300, detailed 200, brief 250.
fn straddle_params() -> SelectionConfig {
    SelectionConfig {
        lower_bound: 1000.0,
        percentages: ViewProfilePercentages {
            full: 25.0,
            smooth: 30.0,
            detailed: 20.0,
            brief: 25.0,
        },
        newest_closed_protection: None,
        compact_point_upper_bound: None,
    }
}

fn body(subject_id: &str, tokens: usize) -> String {
    format!("{subject_id}{}", " alpha".repeat(tokens.saturating_sub(1)))
}

fn ready(content: &str) -> DerivationSnapshot {
    DerivationSnapshot {
        state: DerivationState::Ready,
        content: Some(content.to_string()),
        reason: None,
        source_version: None,
    }
}

fn straddle_inputs(
    count: usize,
    chunks: &[Vec<&str>],
    compressions: &[(&str, usize)],
    newest_chunk_status: SelectionChunkStatus,
) -> SelectionInputs {
    let turns: Vec<SelectionTurn> = (0..count)
        .map(|index| SelectionTurn {
            turn_id: format!("t{}", index + 1),
            turn_order: (index as i64) + 1,
            status: SelectionTurnStatus::Closed,
            opened_at: (index as i64) * 10 + 1,
            closed_at: Some((index as i64 + 1) * 10),
        })
        .collect();
    let messages: Vec<SelectionMessage> = turns
        .iter()
        .map(|turn| SelectionMessage {
            message_id: format!("m{}", turn.turn_order),
            order: turn.opened_at,
            kind: "user_prompt".to_string(),
            token_estimate: if turn.turn_order == count as i64 {
                300
            } else {
                10
            },
            turn_id: turn.turn_id.clone(),
            text: format!("prompt {}", turn.turn_id),
        })
        .collect();
    let last_chunk = chunks.len().saturating_sub(1);
    let chunks: Vec<SelectionChunk> = chunks
        .iter()
        .enumerate()
        .map(|(index, member_turn_ids)| SelectionChunk {
            chunk_id: format!("c{}", index + 1),
            chunk_order: (index as i64) + 1,
            status: if index == last_chunk {
                newest_chunk_status
            } else {
                SelectionChunkStatus::Closed
            },
            member_turn_ids: member_turn_ids
                .iter()
                .map(|turn_id| (*turn_id).to_string())
                .collect(),
        })
        .collect();
    let mut derivations: IndexMap<String, DerivationSnapshot> = IndexMap::new();
    for turn in &turns {
        derivations.insert(
            format!("{}/turn_rendering", turn.turn_id),
            ready(&body(&format!("rendered-{}", turn.turn_id), 90)),
        );
    }
    for (turn_id, tokens) in compressions {
        derivations.insert(
            format!("{turn_id}/detailed_turn_compression"),
            ready(&body(&format!("compressed-{turn_id}"), *tokens)),
        );
    }
    for chunk in &chunks {
        derivations.insert(
            format!("{}/chunk_summary_detailed", chunk.chunk_id),
            ready(&format!("detailed {}", chunk.chunk_id)),
        );
        derivations.insert(
            format!("{}/chunk_summary_brief", chunk.chunk_id),
            ready(&format!("brief {}", chunk.chunk_id)),
        );
    }
    SelectionInputs {
        messages,
        turns,
        chunks,
        derivations,
        compact_chunk_materials: None,
        max_event_order: (count as i64) * 10,
        derivation_counts: IndexMap::new(),
        empty_chunk_ids: Vec::new(),
        skipped_records: Vec::new(),
    }
}

fn walk_select(inputs: SelectionInputs, config: &SelectionConfig) -> SelectionResult {
    let mut source = EagerSelectionSource::new(inputs);
    walk_arrangement(&mut source, config).expect("walk")
}

fn layout(selection: &SelectionResult) -> Vec<String> {
    selection
        .entries
        .iter()
        .map(|entry| {
            format!(
                "{}:{}:{}",
                entry.band.as_str(),
                entry.subject_id,
                entry.derivation_used
            )
        })
        .collect()
}

#[test]
fn straddling_members_older_than_smooth_take_unused_detailed_budget() {
    let selection = walk_select(
        straddle_inputs(
            6,
            &[vec!["t1", "t2", "t3", "t4", "t5", "t6"]],
            &[("t1", 20), ("t2", 20)],
            SelectionChunkStatus::Closed,
        ),
        &straddle_params(),
    );

    assert_eq!(selection.compact_point, 50);
    assert_eq!(
        layout(&selection),
        [
            "detailed:t1:detailed_turn_compression",
            "detailed:t2:detailed_turn_compression",
            "smooth:t3:turn_rendering",
            "smooth:t4:turn_rendering",
            "smooth:t5:turn_rendering",
        ]
    );
    assert_eq!(selection.entries[0].text, body("compressed-t1", 20));
    let detailed_tokens: i64 = selection
        .entries
        .iter()
        .filter(|entry| entry.band == Band::Detailed)
        .map(|entry| entry.tokens)
        .sum();
    assert!(detailed_tokens <= 200);
    assert_eq!(selection.covered_from, 1);
    assert_eq!(selection.skipped, []);
    assert!(selection.entries.iter().all(|entry| !entry.gap));
}

#[test]
fn stops_in_detailed_and_skips_in_brief_with_one_gap_marker_per_run() {
    let selection = walk_select(
        straddle_inputs(
            9,
            &[vec!["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]],
            &[
                ("t1", 20),
                ("t2", 400),
                ("t3", 400),
                ("t4", 150),
                ("t5", 150),
            ],
            SelectionChunkStatus::Closed,
        ),
        &straddle_params(),
    );

    assert_eq!(
        layout(&selection),
        [
            "brief:t1:detailed_turn_compression",
            "brief:t2–t3:gap",
            "brief:t4:detailed_turn_compression",
            "detailed:t5:detailed_turn_compression",
            "smooth:t6:turn_rendering",
            "smooth:t7:turn_rendering",
            "smooth:t8:turn_rendering",
        ]
    );
    assert_eq!(selection.covered_from, 1);

    let marker = selection
        .entries
        .iter()
        .find(|entry| entry.gap)
        .expect("gap marker");
    assert_eq!(marker.text, "[turns t2–t3 not in view; use get-turns]");
    assert_eq!(
        marker.reason.as_deref(),
        Some("turns t2–t3 not in view; use get-turns")
    );
    let mut gaps: Vec<String> = selection
        .entries
        .iter()
        .filter(|entry| entry.gap)
        .map(|entry| format!("{}:{}", entry.band.as_str(), entry.subject_id))
        .collect();
    gaps.extend(
        selection
            .skipped
            .iter()
            .map(|skip| format!("{}:{}", skip.band.as_str(), skip.subject_id)),
    );
    assert_eq!(gaps, ["brief:t2–t3", "brief:t3", "brief:t2"]);
}

#[test]
fn open_first_chunk_elders_take_ready_turn_compressions() {
    let selection = walk_select(
        straddle_inputs(
            6,
            &[vec!["t1", "t2", "t3", "t4", "t5", "t6"]],
            &[("t1", 20), ("t2", 20)],
            SelectionChunkStatus::Open,
        ),
        &straddle_params(),
    );

    assert_eq!(selection.compact_point, 50);
    assert_eq!(
        layout(&selection),
        [
            "detailed:t1:detailed_turn_compression",
            "detailed:t2:detailed_turn_compression",
            "smooth:t3:turn_rendering",
            "smooth:t4:turn_rendering",
            "smooth:t5:turn_rendering",
        ]
    );
    assert_eq!(selection.entries[0].text, body("compressed-t1", 20));
    assert_eq!(selection.covered_from, 1);
    assert!(selection.entries.iter().all(|entry| !entry.gap));
}

#[test]
fn leading_turns_with_no_material_get_one_run_marker_without_moving_covered_from() {
    let mut config = straddle_params();
    config.percentages.detailed = 0.0;
    config.percentages.brief = 0.0;
    let selection = walk_select(
        straddle_inputs(
            6,
            &[vec!["t1", "t2", "t3", "t4", "t5", "t6"]],
            &[],
            SelectionChunkStatus::Open,
        ),
        &config,
    );

    assert_eq!(
        layout(&selection),
        [
            "detailed:t1–t2:gap",
            "smooth:t3:turn_rendering",
            "smooth:t4:turn_rendering",
            "smooth:t5:turn_rendering",
        ]
    );
    assert_eq!(
        selection.entries[0].text,
        "[turns t1–t2 not in view; use get-turns]"
    );
    assert_eq!(selection.covered_from, 21);
}

fn long_open_chunk_stays_budgeted(count: usize) {
    let members: Vec<String> = (1..=count).map(|i| format!("t{i}")).collect();
    let member_refs: Vec<&str> = members.iter().map(String::as_str).collect();
    let selection = walk_select(
        straddle_inputs(
            count,
            &[member_refs],
            &[("t1", 20)],
            SelectionChunkStatus::Open,
        ),
        &straddle_params(),
    );
    let total: i64 = selection.entries.iter().map(|entry| entry.tokens).sum();
    assert!(total < 1000);
    let n = count - 1;
    assert_eq!(
        layout(&selection),
        [
            "detailed:t1:detailed_turn_compression".to_string(),
            format!("detailed:t2–t{}:gap", n - 3),
            format!("smooth:t{}:turn_rendering", n - 2),
            format!("smooth:t{}:turn_rendering", n - 1),
            format!("smooth:t{n}:turn_rendering"),
        ]
    );
    assert_eq!(
        selection.entries[1].text,
        format!("[turns t2–t{} not in view; use get-turns]", n - 3)
    );
    assert_eq!(selection.covered_from, 1);
}

#[test]
fn long_open_chunk_with_only_the_oldest_summary_ready_stays_budgeted_30_turns() {
    long_open_chunk_stays_budgeted(30);
}

#[test]
fn long_open_chunk_with_only_the_oldest_summary_ready_stays_budgeted_1000_turns() {
    long_open_chunk_stays_budgeted(1000);
}

#[test]
fn mixed_ready_and_missing_elder_turns_one_marker_per_missing_run() {
    let selection = walk_select(
        straddle_inputs(
            12,
            &[vec![
                "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12",
            ]],
            &[("t1", 20), ("t4", 20), ("t8", 20)],
            SelectionChunkStatus::Open,
        ),
        &straddle_params(),
    );
    assert_eq!(
        layout(&selection),
        [
            "detailed:t1:detailed_turn_compression",
            "detailed:t2–t3:gap",
            "detailed:t4:detailed_turn_compression",
            "detailed:t5–t7:gap",
            "detailed:t8:detailed_turn_compression",
            "smooth:t9:turn_rendering",
            "smooth:t10:turn_rendering",
            "smooth:t11:turn_rendering",
        ]
    );
    let detailed_tokens: i64 = selection
        .entries
        .iter()
        .filter(|entry| entry.band == Band::Detailed)
        .map(|entry| entry.tokens)
        .sum();
    assert!(detailed_tokens <= 200);
    assert_eq!(selection.covered_from, 1);
}

#[test]
fn elder_backlog_larger_than_the_shares_leaves_one_leading_marker() {
    let count = 305;
    let compressions: Vec<(String, usize)> = (1..=301).map(|i| (format!("t{i}"), 40)).collect();
    let compression_refs: Vec<(&str, usize)> = compressions
        .iter()
        .map(|(id, tokens)| (id.as_str(), *tokens))
        .collect();
    let members: Vec<String> = (1..=count).map(|i| format!("t{i}")).collect();
    let member_refs: Vec<&str> = members.iter().map(String::as_str).collect();
    let selection = walk_select(
        straddle_inputs(
            count,
            &[member_refs],
            &compression_refs,
            SelectionChunkStatus::Open,
        ),
        &straddle_params(),
    );
    let gaps: Vec<_> = selection.entries.iter().filter(|entry| entry.gap).collect();
    assert_eq!(gaps.len(), 1);
    assert!(
        gaps[0].text.starts_with("[turns t1–t")
            && gaps[0].text.ends_with(" not in view; use get-turns]"),
        "unexpected leading marker {}",
        gaps[0].text
    );
    assert!(selection.entries.len() < 20);
    let total: i64 = selection.entries.iter().map(|entry| entry.tokens).sum();
    assert!(total < 1000);
}

#[test]
fn non_straddling_layout_matches_pre_f6_arrangement() {
    let selection = walk_select(
        straddle_inputs(
            6,
            &[vec!["t1", "t2"]],
            &[("t1", 20), ("t2", 20)],
            SelectionChunkStatus::Closed,
        ),
        &straddle_params(),
    );

    assert_eq!(selection.compact_point, 50);
    assert_eq!(selection.covered_from, 1);
    assert_eq!(selection.skipped, []);
    assert_eq!(selection.entries.len(), 4);
    assert_eq!(selection.entries[0].band, Band::Detailed);
    assert_eq!(selection.entries[0].subject_kind, ViewSubjectKind::Chunk);
    assert_eq!(selection.entries[0].subject_id, "c1");
    assert_eq!(
        selection.entries[0].derivation_used,
        "chunk_summary_detailed"
    );
    assert!(!selection.entries[0].degraded);
    assert!(!selection.entries[0].gap);
    assert_eq!(selection.entries[0].start_order, 1);
    assert_eq!(
        selection.entries[0].text,
        "<turns>t1 t2</turns>\ndetailed c1"
    );
    for (index, n) in [3, 4, 5].into_iter().enumerate() {
        let entry = &selection.entries[index + 1];
        assert_eq!(entry.band, Band::Smooth);
        assert_eq!(entry.subject_kind, ViewSubjectKind::Turn);
        assert_eq!(entry.subject_id, format!("t{n}"));
        assert_eq!(entry.derivation_used, "turn_rendering");
        assert!(!entry.degraded);
        assert!(!entry.gap);
        assert_eq!(entry.start_order, (n - 1) * 10 + 1);
        assert_eq!(entry.text, body(&format!("rendered-t{n}"), 90));
    }
}
