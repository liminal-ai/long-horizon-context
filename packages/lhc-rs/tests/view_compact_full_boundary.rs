//! Ported from packages/lhc/test/view-compact-full-boundary.test.ts. Phase 1.
//!
//! Compact full-band boundary rounding.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, RuntimeNoteOverrides, RuntimeNotePayload,
    TempStore, TurnEndOverrides, UserPromptOverrides, UserPromptPayload, kind, open_raw,
    temp_store, valid_event,
};
use indexmap::IndexMap;
use lhc::create_deterministic_inference_callbacks;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, PreviewCompactOutcome, PreviewCompactResult, ViewCompactParams,
    ViewProfilePercentages,
};
use lhc::thread_view::CompactOpts;
use lhc::thread_view::internal::select::{
    SelectionConfig, SelectionInputs, SelectionMessage, SelectionResult, SelectionTurn,
    SelectionTurnStatus, select_arrangement,
};
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
    let SelectionResult { compact_point, .. } = select_arrangement(
        &selection_inputs(mid_thread_turns(), mid_thread_messages()),
        &SelectionConfig {
            lower_bound: full_budget as f64,
            percentages: ViewProfilePercentages {
                full: 100.0,
                smooth: 0.0,
                detailed: 0.0,
                brief: 0.0,
            },
        },
    )
    .expect("select_arrangement");
    compact_point
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
                    }),
                    signal: None,
                },
            )
            .await,
    )
}

#[tokio::test]
async fn keeps_an_oversized_newest_closed_turn_ahead_of_an_empty_open_turn() {
    let preview = oversized_final_turn(false).await;
    assert_eq!(preview.compact_point, 3);
    assert_eq!(preview.first_kept_message_id.as_deref(), Some("m4"));
}

#[tokio::test]
async fn keeps_an_oversized_newest_closed_turn_when_there_is_no_open_turn() {
    let preview = oversized_final_turn(true).await;
    assert_eq!(preview.compact_point, 3);
    assert_eq!(preview.first_kept_message_id.as_deref(), Some("m4"));
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
fn keeps_a_mid_thread_straddling_turn_on_an_exact_50_50_split() {
    assert_eq!(compact_point_at(70), 3);
}

#[test]
fn keeps_an_exactly_covered_closed_turn_in_full() {
    assert_eq!(compact_point_at(120), 3);
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
        },
    )
    .expect("select_arrangement");

    assert_eq!(selection.compact_point, 6);
}

#[test]
fn treats_a_runtime_note_only_post_eviction_tail_as_empty_and_keeps_the_straddling_turn() {
    // Same mid-thread token layout as compact_point_at(60) (would evict t2 on
    // token split alone), but the only newer message is a runtime_note — not
    // mappable, so the emptiness override keeps t2 in full.
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
        },
    )
    .expect("select_arrangement");

    assert_eq!(selection.compact_point, 3);
}

#[tokio::test]
async fn runtime_note_only_tail_keeps_straddling_turn_preview_anchor_is_non_null() {
    let store = temp_store();
    let (sdk, file_path) = new_sdk(&store).await;
    // t1 small, t2 oversized (token-split would want eviction), open turn holds
    // only a runtime_note — not mappable, so emptiness override keeps t2 in full.
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
                    }),
                    signal: None,
                },
            )
            .await,
    );

    // Override keeps t2 in full (compact point at t1 close); anchor is t2's
    // first mappable message — never null solely because of a runtime_note tail.
    assert_eq!(preview.compact_point, 3);
    assert_eq!(preview.first_kept_message_id.as_deref(), Some("m4"));
    assert!(preview.first_kept_message_id.is_some());
}
