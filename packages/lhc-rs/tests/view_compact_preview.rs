//! Ported from packages/lhc/test/view-compact-preview.test.ts. Phase 1.
//!
//! Story 0 / TC-5.1c: previewCompact shares computeArrangement with compact;
//! compactPoint agrees exactly; preview is read-only.
//!
//! Judgment: Rust has no async beforeAll — each test builds its own
//! `temp_store` / `derived_thread_fixture` (same approach as lifecycle.rs).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, DerivedThreadOptions, TempStore,
    ToolCallOverrides, ToolCallPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, derived_thread_fixture, event_batch, kind, temp_store,
    valid_event,
};
use lhc::count_live_items;
use lhc::create_deterministic_inference_callbacks;
use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    Band, CompactReceipt, CompactReceiptBands, PartialViewProfilePercentages,
    PreviewCompactOutcome, PreviewCompactResult, ViewCompactParams,
};
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};
use regex::Regex;
use serde_json::Value;

fn target_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25),
            smooth: Some(25),
            detailed: Some(25),
            brief: Some(25),
        }),
    }
}

fn gradient_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25),
            smooth: Some(16),
            detailed: Some(10),
            brief: Some(49),
        }),
    }
}

fn all_fits_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(1_000_000),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25),
            smooth: Some(25),
            detailed: Some(25),
            brief: Some(25),
        }),
    }
}

fn near_no_op_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(50),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(10),
            smooth: Some(10),
            detailed: Some(10),
            brief: Some(70),
        }),
    }
}

fn view_row_count(file_path: &str) -> i64 {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM thread_view")
        .get()
        .expect("thread_view count row");
    row.get("n")
        .and_then(|v| v.as_i64())
        .expect("thread_view count n")
}

fn live_count(file_path: &str) -> i64 {
    let closing = fixtures::ClosingDb::open(file_path);
    count_live_items(closing.db())
}

fn stored_arrangement_subject_ids(file_path: &str) -> Vec<String> {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare("SELECT arrangement_json FROM thread_view WHERE singleton = 1")
        .get()
        .expect("thread_view arrangement row");
    let raw = row
        .get("arrangement_json")
        .and_then(|v| v.as_str())
        .expect("arrangement_json");
    let arrangement: Vec<Value> = serde_json::from_str(raw).expect("arrangement_json parse");
    arrangement
        .iter()
        .filter_map(|entry| {
            entry
                .get("subjectId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect()
}

async fn preview_and_compact(
    target: &Lhc,
    file_path: &str,
    params: ViewCompactParams,
) -> (OpResult<PreviewCompactOutcome>, OpResult<CompactReceipt>) {
    let preview = target
        .thread_view
        .preview_compact(
            ThreadRef::file_path(file_path),
            CompactOpts {
                profile: None,
                params: Some(params.clone()),
                signal: None,
            },
        )
        .await;
    let compact = target
        .thread_view
        .compact(
            ThreadRef::file_path(file_path),
            CompactOpts {
                profile: None,
                params: Some(params),
                signal: None,
            },
        )
        .await;
    (preview, compact)
}

async fn new_manual_sdk(store: &TempStore) -> (Lhc, String) {
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

fn expect_ok_preview(preview: OpResult<PreviewCompactOutcome>) -> PreviewCompactResult {
    assert!(preview.is_ok());
    let OpResult::Ok { value } = preview else {
        panic!("expected ok preview OpResult");
    };
    match value {
        PreviewCompactOutcome::Ok { preview } => preview,
        PreviewCompactOutcome::Error { .. } => panic!("expected ok preview"),
    }
}

fn band_stats(
    bands: &CompactReceiptBands,
    band: Band,
) -> &lhc::shared_tech::view::CompactBandStats {
    match band {
        Band::Brief => &bands.brief,
        Band::Detailed => &bands.detailed,
        Band::Smooth => &bands.smooth,
    }
}

#[tokio::test]
async fn all_fits_three_closed_turns_under_full_budget_compact_point_0() {
    let store = temp_store();
    let (sdk, file_path) = new_manual_sdk(&store).await;
    for _turn in 0..3 {
        let captured = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &event_batch(&[
                    EventKind::UserPrompt,
                    EventKind::AssistantText,
                    EventKind::TurnEnd,
                ]),
            )
            .await;
        assert!(captured.is_ok());
    }

    let (preview, compact) = preview_and_compact(&sdk, &file_path, all_fits_params()).await;
    let preview_result = expect_ok_preview(preview);
    assert!(compact.is_ok());
    let OpResult::Ok { value: compact } = compact else {
        return;
    };

    assert_eq!(preview_result.compact_point, 0);
    assert!(!preview_result.would_produce_bands);
    // Point 0: anchor is the thread's first mappable message, not null.
    assert_eq!(preview_result.first_kept_message_id.as_deref(), Some("m1"));
    assert_eq!(compact.compact_point, 0);
    assert_eq!(compact.first_kept_message_id.as_deref(), Some("m1"));
    assert_eq!(preview_result.compact_point, compact.compact_point);
}

#[tokio::test]
async fn over_budget_derived_fixture_compact_point_snaps_to_turn_t8_close_event_order_48() {
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let (preview, compact) =
        preview_and_compact(&local.sdk, &local.file_path, target_params()).await;
    let preview_result = expect_ok_preview(preview);
    assert!(compact.is_ok());
    let OpResult::Ok { value: compact } = compact else {
        return;
    };

    assert_eq!(preview_result.compact_point, 48);
    assert!(preview_result.would_produce_bands);
    assert_eq!(compact.compact_point, 48);
    assert_eq!(preview_result.compact_point, compact.compact_point);

    let closing = fixtures::ClosingDb::open(&local.file_path);
    let turn = closing
        .db()
        .prepare("SELECT closed_at_event_order FROM turns WHERE turn_id = 't8'")
        .get()
        .expect("t8 turn row");
    let closed_at = turn
        .get("closed_at_event_order")
        .and_then(|v| v.as_i64())
        .expect("t8 closed_at_event_order");
    assert_eq!(preview_result.compact_point, closed_at);
}

#[tokio::test]
async fn near_no_op_one_small_brief_band_compact_point_9_at_turn_t3_close() {
    let store = temp_store();
    let (sdk, file_path) = new_manual_sdk(&store).await;
    let mut batch: Vec<MessageEventInput> = Vec::new();
    for turn in 1..=4 {
        batch.push(valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: format!("brief turn {turn}"),
                }),
                ..Default::default()
            },
        ));
        batch.push(valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: format!("ok {turn}"),
                }),
                ..Default::default()
            },
        ));
        batch.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    }
    let captured = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &batch)
        .await;
    assert!(captured.is_ok());
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());

    let (preview, compact) = preview_and_compact(&sdk, &file_path, near_no_op_params()).await;
    let preview_result = expect_ok_preview(preview);
    assert!(compact.is_ok());
    let OpResult::Ok { value: compact } = compact else {
        return;
    };

    assert_eq!(preview_result.compact_point, 9);
    assert!(preview_result.would_produce_bands);
    assert_eq!(preview_result.first_kept_message_id.as_deref(), Some("m10"));
    assert_eq!(compact.compact_point, 9);
    assert_eq!(preview_result.compact_point, compact.compact_point);

    let closing = fixtures::ClosingDb::open(&file_path);
    let turn = closing
        .db()
        .prepare("SELECT closed_at_event_order FROM turns WHERE turn_id = 't3'")
        .get()
        .expect("t3 turn row");
    let closed_at = turn
        .get("closed_at_event_order")
        .and_then(|v| v.as_i64())
        .expect("t3 closed_at_event_order");
    assert_eq!(preview_result.compact_point, closed_at);
}

#[tokio::test]
async fn tc_5_1c_preview_compact_point_matches_compact_on_the_derived_fixture() {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let (preview, compact) =
        preview_and_compact(&fixture.sdk, &fixture.file_path, target_params()).await;
    assert!(preview.is_ok());
    assert!(compact.is_ok());
    let (OpResult::Ok { value: preview }, OpResult::Ok { value: compact }) = (preview, compact)
    else {
        return;
    };
    let PreviewCompactOutcome::Ok {
        preview: preview_result,
    } = preview
    else {
        return;
    };
    assert_eq!(preview_result.compact_point, compact.compact_point);
    assert_eq!(
        preview_result.would_produce_bands,
        compact.compact_point > 0
    );
    assert_eq!(
        preview_result.first_kept_message_id,
        compact.first_kept_message_id
    );
}

#[tokio::test]
async fn tc_5_6b_re_compact_may_move_compact_point_backward_preview_and_compact_stay_coherent() {
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let first = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first } = first else {
        return;
    };
    assert_eq!(first.compact_point, 48);

    let preview = local
        .sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(all_fits_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    let OpResult::Ok { value: preview } = preview else {
        return;
    };
    let PreviewCompactOutcome::Ok {
        preview: preview_result,
    } = preview
    else {
        return;
    };
    assert_eq!(preview_result.compact_point, 0);
    assert!(!preview_result.would_produce_bands);
    // Point 0 still anchors on the first mappable message.
    assert_eq!(preview_result.first_kept_message_id.as_deref(), Some("m1"));

    let second = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(all_fits_params()),
                signal: None,
            },
        )
        .await;
    assert!(second.is_ok());
    let OpResult::Ok { value: second } = second else {
        return;
    };
    assert_eq!(second.compact_point, 0);
    assert_eq!(second.first_kept_message_id.as_deref(), Some("m1"));

    let described = local
        .sdk
        .thread_view
        .describe(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(described.is_ok());
    let OpResult::Ok { value: described } = described else {
        return;
    };
    assert_eq!(described.as_ref().map(|v| v.compact_point), Some(0));
}

#[tokio::test]
async fn same_point_preview_reports_bands_when_recomputed_arrangement_repairs_the_stored_snapshot()
{
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let first = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first } = first else {
        return;
    };
    assert_eq!(first.compact_point, 48);
    assert!(stored_arrangement_subject_ids(&local.file_path).contains(&"t7".to_string()));
    assert_eq!(first.gaps, vec![]);

    {
        let closing = fixtures::ClosingDb::open(&local.file_path);
        let db = closing.db();
        let row = db
            .prepare("SELECT arrangement_json FROM thread_view WHERE singleton = 1")
            .get()
            .expect("thread_view arrangement row");
        let raw = row
            .get("arrangement_json")
            .and_then(|v| v.as_str())
            .expect("arrangement_json")
            .to_string();
        let arrangement: Vec<Value> = serde_json::from_str(&raw).expect("parse arrangement");
        let filtered: Vec<Value> = arrangement
            .into_iter()
            .filter(|entry| entry.get("subjectId").and_then(|v| v.as_str()) != Some("t7"))
            .collect();
        let filtered_json = js_json_stringify(&Value::Array(filtered));
        db.prepare(
            "UPDATE thread_view SET arrangement_json = ?, gaps_json = ? WHERE singleton = 1",
        )
        .run(&[SqlParam::from(filtered_json.as_str()), SqlParam::from("[]")]);
    }

    let preview = local
        .sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    let OpResult::Ok { value: preview } = &preview else {
        return;
    };
    let PreviewCompactOutcome::Ok {
        preview: preview_result,
    } = preview
    else {
        return;
    };
    assert_eq!(preview_result.compact_point, 48);
    assert!(preview_result.would_produce_bands);

    let repaired = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(repaired.is_ok());
    let OpResult::Ok { value: repaired } = repaired else {
        return;
    };
    assert_eq!(repaired.compact_point, 48);
    assert!(stored_arrangement_subject_ids(&local.file_path).contains(&"t7".to_string()));
    assert_eq!(repaired.gaps, vec![]);
}

#[tokio::test]
async fn exactness_golden_corpus_sizes_agree_on_compact_point_no_op_banded_re_compact() {
    let cases: [(&str, ViewCompactParams); 3] = [
        (
            "no-op-small",
            ViewCompactParams {
                lower_bound: Some(500_000),
                percentages: Some(PartialViewProfilePercentages {
                    full: Some(25),
                    smooth: Some(25),
                    detailed: Some(25),
                    brief: Some(25),
                }),
            },
        ),
        ("banded-target", target_params()),
        ("banded-gradient", gradient_params()),
    ];

    for (label, params) in cases {
        let store = temp_store();
        let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
        let (preview, compact) =
            preview_and_compact(&local.sdk, &local.file_path, params.clone()).await;
        assert!(preview.is_ok(), "{label}");
        assert!(compact.is_ok(), "{label}");
        let (OpResult::Ok { value: preview }, OpResult::Ok { value: compact }) = (preview, compact)
        else {
            continue;
        };
        let PreviewCompactOutcome::Ok {
            preview: preview_result,
        } = preview
        else {
            continue;
        };
        assert_eq!(
            preview_result.compact_point, compact.compact_point,
            "{label}"
        );
        assert_eq!(
            preview_result.would_produce_bands,
            compact.compact_point > 0,
            "{label}"
        );

        let (second_preview, second_compact) =
            preview_and_compact(&local.sdk, &local.file_path, params).await;
        assert!(second_preview.is_ok());
        let OpResult::Ok {
            value: second_preview,
        } = second_preview
        else {
            continue;
        };
        let PreviewCompactOutcome::Ok {
            preview: second_preview_result,
        } = second_preview
        else {
            continue;
        };
        assert!(second_compact.is_ok(), "{label}");
        let OpResult::Ok {
            value: second_compact,
        } = second_compact
        else {
            continue;
        };
        // Same params re-compact always writes; point is free to stay or move.
        assert_eq!(
            second_preview_result.compact_point, second_compact.compact_point,
            "{label}"
        );
    }
}

#[tokio::test]
async fn near_no_op_with_one_small_brief_entry_still_reports_would_produce_bands_true() {
    let store = temp_store();
    let (sdk, file_path) = new_manual_sdk(&store).await;
    let mut batch: Vec<MessageEventInput> = Vec::new();
    for turn in 1..=4 {
        batch.push(valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: format!("brief turn {turn}"),
                }),
                ..Default::default()
            },
        ));
        batch.push(valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: format!("ok {turn}"),
                }),
                ..Default::default()
            },
        ));
        batch.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    }
    let captured = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &batch)
        .await;
    assert!(captured.is_ok());
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());

    let preview = sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(near_no_op_params()),
                signal: None,
            },
        )
        .await;
    let preview_result = expect_ok_preview(preview);
    assert!(preview_result.would_produce_bands);
    assert_eq!(preview_result.compact_point, 9);
}

#[tokio::test]
async fn preview_never_writes_a_thread_view_row() {
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let before = view_row_count(&local.file_path);
    let preview = local
        .sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    assert_eq!(view_row_count(&local.file_path), before);
}

#[tokio::test]
async fn latest_open_turn_with_a_dangling_tool_call_previews_ok_and_stays_after_compact_point() {
    let store = temp_store();
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let local_sdk = init_lhc(SdkConfig {
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
    let created = local_sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("{}", error.reason),
    }

    for turn in 1..=3 {
        let closed = local_sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&path),
                &[
                    valid_event(
                        kind::USER_PROMPT,
                        UserPromptOverrides {
                            payload: Some(UserPromptPayload {
                                text: format!("closed turn {turn}"),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(
                        kind::ASSISTANT_TEXT,
                        AssistantTextOverrides {
                            payload: Some(AssistantTextPayload {
                                text: format!("closed answer {turn}"),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(kind::TURN_END, TurnEndOverrides::default()),
                ],
            )
            .await;
        assert!(closed.is_ok());
    }
    let drained = local_sdk
        .work
        .drain(ThreadRef::file_path(&path), None)
        .await;
    assert!(drained.is_ok());

    let mut args = serde_json::Map::new();
    args.insert(
        "command".into(),
        serde_json::Value::String(format!(
            "npx @agent-native/core@latest plan local serve {}",
            " --verbose".repeat(200)
        )),
    );
    let captured = local_sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "render the plan locally".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "Lint passed. Now let me serve it.".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "call-open-serve".into(),
                            tool_name: "bash".into(),
                            arguments: args,
                        }),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
    assert!(captured.is_ok());

    let before = view_row_count(&path);
    let preview = local_sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    if !preview.is_ok() {
        return;
    }
    let preview_result = expect_ok_preview(preview);
    assert_eq!(preview_result.compact_point, 9);
    assert!(preview_result.would_produce_bands);
    assert_eq!(preview_result.first_kept_message_id.as_deref(), Some("m10"));
    let full_budget = (TARGET_FULL_BUDGET) as f64;
    assert!(preview_result.tail_tokens as f64 > full_budget);
    assert_eq!(view_row_count(&path), before);
}

/// `(TARGET_PARAMS.lowerBound * TARGET_PARAMS.percentages.full) / 100`
const TARGET_FULL_BUDGET: i64 = (400 * 25) / 100;

#[tokio::test]
async fn empty_open_turn_proceeds_to_ok_preview() {
    let store = temp_store();
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let local_sdk = init_lhc(SdkConfig {
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
    let created = local_sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("{}", error.reason),
    }

    let preview = local_sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&path),
            CompactOpts {
                profile: None,
                params: Some(target_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    let OpResult::Ok { value: preview } = preview else {
        return;
    };
    let PreviewCompactOutcome::Ok {
        preview: preview_result,
    } = preview
    else {
        return;
    };
    assert_eq!(preview_result.compact_point, 0);
    assert!(!preview_result.would_produce_bands);
}

#[tokio::test]
async fn compact_receipt_carries_rendered_bands_and_first_kept_message_id() {
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let compact = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(gradient_params()),
                signal: None,
            },
        )
        .await;
    assert!(compact.is_ok());
    let OpResult::Ok { value: compact } = compact else {
        return;
    };
    assert!(!compact.rendered_bands.is_empty());
    assert!(
        compact
            .rendered_bands
            .first()
            .map(|b| !b.text.is_empty())
            .unwrap_or(false)
    );
    let id_re = Regex::new(r"^m\d+$").expect("regex");
    let first_kept = compact
        .first_kept_message_id
        .as_deref()
        .expect("first_kept_message_id");
    assert!(id_re.is_match(first_kept));
    for band in &compact.rendered_bands {
        let stored = band_stats(&compact.bands, band.band);
        assert!(stored.entries > 0);
        assert!(!band.text.is_empty());
    }
}

#[tokio::test]
async fn background_mode_preview_does_not_schedule_drain_with_pending_work() {
    let store = temp_store();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Background,
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
    let thread_id = match created {
        OpResult::Ok { value } => value.thread_id,
        OpResult::Err { error } => panic!("{}", error.reason),
    };

    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &event_batch(&[EventKind::UserPrompt]),
        )
        .await;
    assert!(captured.is_ok());
    assert!(live_count(&file_path) > 0);

    let passes_before = sdk.scheduler.test_pass_count(&thread_id);
    let preview = sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(all_fits_params()),
                signal: None,
            },
        )
        .await;
    assert!(preview.is_ok());
    assert_eq!(sdk.scheduler.test_pass_count(&thread_id), passes_before);
    assert!(live_count(&file_path) > 0);
}
