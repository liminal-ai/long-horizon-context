//! Ported from packages/lhc/test/view-compact-full-boundary.test.ts. Phase 1.
//!
//! Compact full-band boundary rounding.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, CompactContinuationMarkerOverrides,
    RuntimeNoteOverrides, RuntimeNotePayload, TempStore, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, kind, open_raw, temp_store, valid_event,
};
use indexmap::IndexMap;
use lhc::create_deterministic_inference_callbacks;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::persist::DbReadTransaction;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, PreviewCompactOutcome, PreviewCompactResult, ViewCompactParams,
    ViewProfilePercentages,
};
use lhc::thread_view::CompactOpts;
use lhc::thread_view::internal::bounded_source::create_bounded_selection;
use lhc::thread_view::internal::select::{
    EagerSelectionSource, SelectionConfig, SelectionInputs, SelectionMessage, SelectionTurn,
    SelectionTurnStatus, read_selection_inputs, select_arrangement,
};
use lhc::thread_view::internal::walk::walk_arrangement;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};

fn selection_inputs(turns: Vec<SelectionTurn>, messages: Vec<SelectionMessage>) -> SelectionInputs {
    let max_event_order = turns
        .iter()
        .map(|turn| match turn.closed_at {
            Some(closed) => closed,
            None => turn.opened_at,
        })
        .max()
        .unwrap_or(0)
        .max(0);
    SelectionInputs {
        turns,
        messages,
        chunks: Vec::new(),
        derivations: IndexMap::new(),
        compact_chunk_materials: None,
        max_event_order,
        derivation_counts: IndexMap::new(),
        empty_chunk_ids: Vec::new(),
        skipped_records: Vec::new(),
    }
}

fn sel_msg(
    message_id: &str,
    order: i64,
    token_estimate: i64,
    turn_id: &str,
    kind: &str,
) -> SelectionMessage {
    SelectionMessage {
        message_id: message_id.into(),
        order,
        kind: kind.into(),
        token_estimate,
        turn_id: turn_id.into(),
        text: message_id.into(),
    }
}

fn mid_thread_turns() -> Vec<SelectionTurn> {
    vec![
        SelectionTurn {
            turn_id: "t1".into(),
            turn_order: 1,
            status: SelectionTurnStatus::Closed,
            opened_at: 1,
            closed_at: Some(3),
        },
        SelectionTurn {
            turn_id: "t2".into(),
            turn_order: 2,
            status: SelectionTurnStatus::Closed,
            opened_at: 4,
            closed_at: Some(7),
        },
        SelectionTurn {
            turn_id: "t3".into(),
            turn_order: 3,
            status: SelectionTurnStatus::Closed,
            opened_at: 8,
            closed_at: Some(9),
        },
        SelectionTurn {
            turn_id: "t4".into(),
            turn_order: 4,
            status: SelectionTurnStatus::Open,
            opened_at: 10,
            closed_at: None,
        },
    ]
}

fn mid_thread_messages() -> Vec<SelectionMessage> {
    vec![
        sel_msg("m1", 1, 10, "t1", "assistant_text"),
        sel_msg("m2-old", 4, 40, "t2", "assistant_text"),
        sel_msg("m2-mid", 5, 30, "t2", "assistant_text"),
        sel_msg("m2-new", 6, 30, "t2", "assistant_text"),
        sel_msg("m3", 8, 20, "t3", "assistant_text"),
    ]
}

fn compact_point_at(full_budget: i64) -> i64 {
    let inputs = selection_inputs(mid_thread_turns(), mid_thread_messages());
    let config = SelectionConfig {
        lower_bound: full_budget as f64,
        percentages: ViewProfilePercentages {
            full: 100.0,
            smooth: 0.0,
            detailed: 0.0,
            brief: 0.0,
        },
        newest_closed_protection: None,
        compact_point_upper_bound: None,
    };
    let legacy_point = select_arrangement(&inputs, &config)
        .expect("select_arrangement")
        .compact_point;
    let mut shared_source = EagerSelectionSource::new(inputs);
    let shared_point = walk_arrangement(&mut shared_source, &config)
        .expect("shared walk")
        .compact_point;
    assert_eq!(shared_point, legacy_point);
    shared_point
}

async fn new_sdk(store: &TempStore) -> (Lhc, String) {
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("{}", error.reason),
    }
    (sdk, file_path)
}

async fn exact_fixture_points(tokens_by_turn: &[(i64, i64)]) -> (i64, i64) {
    let store = temp_store();
    let (sdk, file_path) = new_sdk(&store).await;
    for turn in 1..=tokens_by_turn.len() {
        let sent = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &[
                    valid_event(
                        kind::USER_PROMPT,
                        UserPromptOverrides {
                            payload: Some(UserPromptPayload {
                                text: format!("turn {turn} prompt"),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(
                        kind::ASSISTANT_TEXT,
                        AssistantTextOverrides {
                            payload: Some(AssistantTextPayload::new(format!("turn {turn} answer"))),
                            ..Default::default()
                        },
                    ),
                    valid_event(kind::TURN_END, TurnEndOverrides::default()),
                ],
            )
            .await;
        assert!(sent.is_ok());
    }
    let db = open_raw(&file_path);
    let rows = db
        .prepare("SELECT message_id, turn_id FROM message ORDER BY source_event_order")
        .all(&[]);
    for (index, (older, newer)) in tokens_by_turn.iter().enumerate() {
        let turn_id = format!("t{}", index + 1);
        let turn_rows: Vec<&serde_json::Map<String, serde_json::Value>> = rows
            .iter()
            .filter(|row| row.get("turn_id").and_then(|value| value.as_str()) == Some(&turn_id))
            .collect();
        assert_eq!(turn_rows.len(), 2);
        for (row, tokens) in turn_rows.into_iter().zip([older, newer]) {
            let message_id = row
                .get("message_id")
                .and_then(|value| value.as_str())
                .expect("message id");
            db.prepare("UPDATE message SET token_estimate = ? WHERE message_id = ?")
                .run(&[SqlParam::from(*tokens), SqlParam::from(message_id)]);
        }
    }
    let config = SelectionConfig {
        lower_bound: 1_000.0,
        percentages: ViewProfilePercentages {
            full: 10.0,
            smooth: 30.0,
            detailed: 30.0,
            brief: 30.0,
        },
        newest_closed_protection: None,
        compact_point_upper_bound: None,
    };
    let eager_inputs = read_selection_inputs(&db).expect("eager inputs");
    let mut eager = EagerSelectionSource::new(eager_inputs);
    let eager_point = walk_arrangement(&mut eager, &config)
        .expect("eager shared walk")
        .compact_point;
    let transaction = DbReadTransaction {
        db: &db,
        thread_id: "exact-boundary".into(),
        file_path: file_path.clone(),
    };
    let mut bounded = create_bounded_selection(&db, &transaction, true, None);
    let bounded_point = walk_arrangement(&mut bounded.source, &config)
        .expect("bounded shared walk")
        .compact_point;
    drop(bounded);
    drop(transaction);
    db.close();
    (bounded_point, eager_point)
}

fn ok_preview(result: OpResult<PreviewCompactOutcome>) -> PreviewCompactResult {
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        panic!("expected ok OpResult");
    };
    match value {
        PreviewCompactOutcome::Ok { preview } => preview,
        PreviewCompactOutcome::Error { reason } => panic!("{reason}"),
    }
}

async fn oversized_final_turn(remove_open_turn: bool) -> PreviewCompactResult {
    let store = temp_store();
    let (sdk, file_path) = new_sdk(&store).await;
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "small first turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("done")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "large final turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("oversized ".repeat(1_000))),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    if !captured.is_ok() {
        let OpResult::Err { error } = captured else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }

    if remove_open_turn {
        let db = open_raw(&file_path);
        db.prepare("DELETE FROM turns WHERE status = 'open'")
            .run(&[]);
        db.close();
    }

    ok_preview(
        sdk.thread_view
            .preview_compact(
                ThreadRef::file_path(&file_path),
                CompactOpts {
                    profile: None,
                    params: Some(ViewCompactParams {
                        lower_bound: Some(120.0),
                        percentages: Some(PartialViewProfilePercentages {
                            full: Some(25.0),
                            smooth: Some(25.0),
                            detailed: Some(25.0),
                            brief: Some(25.0),
                        }),
                        newest_closed_protection: None,
                    }),
                    signal: None,
                    compact_point_upper_bound: None,
                },
            )
            .await,
    )
}

#[tokio::test]
async fn evicts_an_oversized_newest_closed_turn_ahead_of_an_empty_open_turn() {
    let preview = oversized_final_turn(false).await;
    // Token split puts most of t2 on the smooth side. Empty open turn is not
    // a reason to keep t2 in full; tail starts after t2 close with no
    // mappable messages.
    assert_eq!(preview.compact_point, 6);
    assert!(preview.first_kept_message_id.is_none());
}

#[tokio::test]
async fn evicts_an_oversized_newest_closed_turn_when_there_is_no_open_turn() {
    let preview = oversized_final_turn(true).await;
    assert_eq!(preview.compact_point, 6);
    assert!(preview.first_kept_message_id.is_none());
}

#[test]
fn keeps_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_full_side() {
    assert_eq!(compact_point_at(80), 3);
}

#[test]
fn evicts_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_smooth_side() {
    assert_eq!(compact_point_at(60), 7);
}

#[test]
fn compact_point_upper_bound_keeps_compact_point_behind_a_later_event_order() {
    let selection = select_arrangement(
        &selection_inputs(mid_thread_turns(), mid_thread_messages()),
        &SelectionConfig {
            lower_bound: 60.0,
            percentages: ViewProfilePercentages {
                full: 100.0,
                smooth: 0.0,
                detailed: 0.0,
                brief: 0.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: Some(3),
        },
    )
    .unwrap();
    assert_eq!(selection.compact_point, 3);
}

#[test]
fn compact_point_upper_bound_snaps_to_greatest_closed_turn_boundary() {
    // Upper bound 5 is inside t2 (closed_at=7). The greatest legal
    // closed-turn boundary <= 5 is t1.closed_at=3.
    let selection = select_arrangement(
        &selection_inputs(mid_thread_turns(), mid_thread_messages()),
        &SelectionConfig {
            lower_bound: 60.0,
            percentages: ViewProfilePercentages {
                full: 100.0,
                smooth: 0.0,
                detailed: 0.0,
                brief: 0.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: Some(5),
        },
    )
    .unwrap();
    assert_eq!(selection.compact_point, 3);
}

#[test]
fn keeps_a_mid_thread_straddling_turn_on_an_exact_50_50_split() {
    assert_eq!(compact_point_at(70), 3);
}

#[test]
fn keeps_an_exactly_covered_closed_turn_in_full() {
    assert_eq!(compact_point_at(120), 3);
}

#[tokio::test]
async fn real_bounded_and_eager_sources_pin_exact_crossing_and_half_turn_ties() {
    let crossing = exact_fixture_points(&[(10, 10), (10, 10), (30, 20), (20, 20), (20, 20)]).await;
    assert_eq!(crossing, (9, 9));

    let tie = exact_fixture_points(&[(10, 10), (10, 10), (15, 25), (20, 20), (20, 20)]).await;
    assert_eq!(tie, (6, 6));

    let one_token_to_smooth =
        exact_fixture_points(&[(10, 10), (10, 10), (16, 25), (20, 20), (20, 20)]).await;
    assert_eq!(one_token_to_smooth, (9, 9));
}

#[test]
fn includes_a_smooth_entry_that_exactly_fills_the_remaining_band_budget() {
    let turns = vec![
        SelectionTurn {
            turn_id: "t1".into(),
            turn_order: 1,
            status: SelectionTurnStatus::Closed,
            opened_at: 1,
            closed_at: Some(2),
        },
        SelectionTurn {
            turn_id: "t2".into(),
            turn_order: 2,
            status: SelectionTurnStatus::Closed,
            opened_at: 3,
            closed_at: Some(4),
        },
        SelectionTurn {
            turn_id: "t3".into(),
            turn_order: 3,
            status: SelectionTurnStatus::Open,
            opened_at: 5,
            closed_at: None,
        },
    ];
    let messages = vec![
        sel_msg("first smooth entry", 1, 100, "t1", "assistant_text"),
        sel_msg("second smooth entry", 3, 100, "t2", "assistant_text"),
        sel_msg("open tail", 5, 1_000_000, "t3", "assistant_text"),
    ];
    let inputs = selection_inputs(turns, messages);
    let probe_config = SelectionConfig {
        lower_bound: 10_000.0,
        percentages: ViewProfilePercentages {
            full: 0.0,
            smooth: 100.0,
            detailed: 0.0,
            brief: 0.0,
        },
        newest_closed_protection: None,
        compact_point_upper_bound: None,
    };
    let mut probe_source = EagerSelectionSource::new(inputs.clone());
    let probe = walk_arrangement(&mut probe_source, &probe_config).expect("probe walk");
    let exact_tokens: i64 = probe
        .entries
        .iter()
        .filter(|entry| entry.band.as_str() == "smooth")
        .map(|entry| entry.tokens)
        .sum();
    assert!(exact_tokens > 0);
    let exact_config = SelectionConfig {
        lower_bound: exact_tokens as f64,
        ..probe_config
    };
    let mut exact_source = EagerSelectionSource::new(inputs);
    let exact = walk_arrangement(&mut exact_source, &exact_config).expect("exact walk");
    assert_eq!(
        exact
            .entries
            .iter()
            .filter(|entry| entry.band.as_str() == "smooth")
            .count(),
        2
    );
}

#[test]
fn starts_the_tail_at_an_open_turn_even_when_the_budget_crosses_inside_it() {
    let turns = vec![
        SelectionTurn {
            turn_id: "t1".into(),
            turn_order: 1,
            status: SelectionTurnStatus::Closed,
            opened_at: 1,
            closed_at: Some(3),
        },
        SelectionTurn {
            turn_id: "t2".into(),
            turn_order: 2,
            status: SelectionTurnStatus::Closed,
            opened_at: 4,
            closed_at: Some(6),
        },
        SelectionTurn {
            turn_id: "t3".into(),
            turn_order: 3,
            status: SelectionTurnStatus::Open,
            opened_at: 7,
            closed_at: None,
        },
    ];
    let messages = vec![
        sel_msg("m1", 1, 10, "t1", "assistant_text"),
        sel_msg("m2", 4, 10, "t2", "assistant_text"),
        sel_msg("m3-old", 7, 25, "t3", "assistant_text"),
        sel_msg("m3-mid", 8, 25, "t3", "assistant_text"),
        sel_msg("m3-new", 9, 25, "t3", "assistant_text"),
    ];

    let selection = select_arrangement(
        &selection_inputs(turns, messages),
        &SelectionConfig {
            lower_bound: 40.0,
            percentages: ViewProfilePercentages {
                full: 100.0,
                smooth: 0.0,
                detailed: 0.0,
                brief: 0.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: None,
        },
    )
    .expect("select_arrangement");

    assert_eq!(selection.compact_point, 6);
}

#[test]
fn evicts_a_straddling_turn_even_when_the_only_newer_message_is_a_runtime_note() {
    // Same mid-thread token layout as compact_point_at(60). A runtime_note is
    // not mappable, but emptiness no longer overrides the token split.
    let turns = vec![
        SelectionTurn {
            turn_id: "t1".into(),
            turn_order: 1,
            status: SelectionTurnStatus::Closed,
            opened_at: 1,
            closed_at: Some(3),
        },
        SelectionTurn {
            turn_id: "t2".into(),
            turn_order: 2,
            status: SelectionTurnStatus::Closed,
            opened_at: 4,
            closed_at: Some(7),
        },
        SelectionTurn {
            turn_id: "t3".into(),
            turn_order: 3,
            status: SelectionTurnStatus::Open,
            opened_at: 8,
            closed_at: None,
        },
    ];
    let messages = vec![
        sel_msg("m1", 1, 10, "t1", "assistant_text"),
        sel_msg("m2-old", 4, 40, "t2", "assistant_text"),
        sel_msg("m2-mid", 5, 30, "t2", "assistant_text"),
        sel_msg("m2-new", 6, 30, "t2", "assistant_text"),
        sel_msg("m-note", 8, 20, "t3", "runtime_note"),
    ];

    let selection = select_arrangement(
        &selection_inputs(turns, messages),
        &SelectionConfig {
            lower_bound: 60.0,
            percentages: ViewProfilePercentages {
                full: 100.0,
                smooth: 0.0,
                detailed: 0.0,
                brief: 0.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: None,
        },
    )
    .expect("select_arrangement");

    assert_eq!(selection.compact_point, 7);
}

#[tokio::test]
async fn runtime_note_only_tail_leaves_first_kept_message_id_null_after_token_split_eviction() {
    let store = temp_store();
    let (sdk, file_path) = new_sdk(&store).await;
    // t1 small, t2 oversized (token-split evicts). Open turn holds only a
    // runtime_note — not mappable, so the preview tail has no PI anchor.
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "small first turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("done")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "large final turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("oversized ".repeat(1_000))),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::RUNTIME_NOTE,
                    RuntimeNoteOverrides {
                        payload: Some(RuntimeNotePayload {
                            text: "harness note only".into(),
                        }),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
    if !captured.is_ok() {
        let OpResult::Err { error } = captured else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }

    let preview = ok_preview(
        sdk.thread_view
            .preview_compact(
                ThreadRef::file_path(&file_path),
                CompactOpts {
                    profile: None,
                    params: Some(ViewCompactParams {
                        lower_bound: Some(120.0),
                        percentages: Some(PartialViewProfilePercentages {
                            full: Some(25.0),
                            smooth: Some(25.0),
                            detailed: Some(25.0),
                            brief: Some(25.0),
                        }),
                        newest_closed_protection: None,
                    }),
                    signal: None,
                    compact_point_upper_bound: None,
                },
            )
            .await,
    );

    assert_eq!(preview.compact_point, 6);
    assert!(preview.first_kept_message_id.is_none());
}

#[tokio::test]
async fn compact_continuation_marker_is_mappable_and_anchors_first_kept_message_id() {
    let store = temp_store();
    let (sdk, file_path) = new_sdk(&store).await;
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "small first turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("done")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "large final turn".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("oversized ".repeat(1_000))),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::COMPACT_CONTINUATION_MARKER,
                    CompactContinuationMarkerOverrides::default(),
                ),
            ],
        )
        .await;
    if !captured.is_ok() {
        let OpResult::Err { error } = captured else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }

    let preview = ok_preview(
        sdk.thread_view
            .preview_compact(
                ThreadRef::file_path(&file_path),
                CompactOpts {
                    profile: None,
                    params: Some(ViewCompactParams {
                        lower_bound: Some(120.0),
                        percentages: Some(PartialViewProfilePercentages {
                            full: Some(25.0),
                            smooth: Some(25.0),
                            detailed: Some(25.0),
                            brief: Some(25.0),
                        }),
                        newest_closed_protection: None,
                    }),
                    signal: None,
                    compact_point_upper_bound: None,
                },
            )
            .await,
    );

    assert_eq!(preview.compact_point, 6);
    assert!(preview.first_kept_message_id.is_some());
}
