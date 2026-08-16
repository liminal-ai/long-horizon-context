//! Ported from packages/lhc/test/inspect-overview.test.ts. Phase 1.
//!
//! Story 2 (Epic 04), default suite: TC-1.1–1.3 — the inspect overview.
//! 9 semantic tests.

mod fixtures;

use std::sync::Arc;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, DerivedThreadOptions, TempStore, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, derived_thread_fixture, expect_read_only,
    kind, mutation_in_flight_variant, open_raw, temp_store, valid_event,
};
use indexmap::IndexMap;
use lhc::messages::{MessageListOptions, RemoveInput};
use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceResult, SdkConfig, SdkMode,
    SmoothPromptInput, SummarizeChunkBriefInput, SummarizeToolResultInput,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::inspect::{
    InspectOverview, InspectOverviewChunks, InspectOverviewDerivation, InspectOverviewEvents,
    InspectOverviewEventsSpan, InspectOverviewMessages, InspectOverviewTurns,
    InspectOverviewVisibility,
};
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};

struct Cleanup {
    store: TempStore,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.store.cleanup();
    }
}

fn setup() -> Cleanup {
    Cleanup {
        store: temp_store(),
    }
}

fn throwing_provider() -> InferenceCallbacks {
    let refuse = || -> BoxFuture<InferenceResult> {
        Box::pin(async {
            panic!("inference callbacks must never be called by a read operation");
        })
    };
    InferenceCallbacks {
        smooth_prompt: Arc::new(move |_i: SmoothPromptInput| refuse()),
        summarize_tool_result: Arc::new(move |_i: SummarizeToolResultInput| refuse()),
        compress_detailed_turn: Arc::new(move |_i: CompressDetailedTurnInput| refuse()),
        summarize_chunk_brief: Arc::new(move |_i: SummarizeChunkBriefInput| refuse()),
    }
}

struct SmallThread {
    file_path: String,
    thread_id: String,
    sdk: Lhc,
    #[allow(dead_code)] // TS SmallThread.double retained for fixture parity
    double: fixtures::InferenceCallbacksDouble,
}

async fn two_turn_thread(store: &TempStore) -> SmallThread {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
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
            title: Some("overview fixture".into()),
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    let OpResult::Ok { value: created } = created else {
        panic!("fixture thread creation failed");
    };
    let batches = [
        vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "please read notes.txt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("reading it now")),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-ov-1".into(),
                        tool_name: "read_file".into(),
                        arguments: serde_json::json!({"path": "notes.txt"})
                            .as_object()
                            .unwrap()
                            .clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-ov-1".into(),
                        content: "contents of notes.txt".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
        vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize what you read".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("here is the summary")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    ];
    for batch in &batches {
        let sent = sdk
            .intake_stream
            .message_events(ThreadRef::file_path(&file_path), batch)
            .await;
        if !sent.is_ok() {
            panic!("fixture batch failed");
        }
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    match &drained {
        OpResult::Ok { value } if value.remaining == 0 => {}
        _ => panic!("fixture drain left work behind"),
    }
    SmallThread {
        file_path,
        thread_id: created.thread_id,
        sdk,
        double,
    }
}

fn overview_value(result: OpResult<InspectOverview>) -> InspectOverview {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok overview: {:?}", error),
    }
}

fn zero_derivation() -> InspectOverviewDerivation {
    InspectOverviewDerivation {
        ready: 0,
        pending: 0,
        failed: 0,
        blocked: 0,
    }
}

#[tokio::test]
async fn fresh_empty_full_shape_with_zeros_and_nulls_never_omitted_fields() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = ctx.store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(ctx.store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    let OpResult::Ok { value: created } = created else {
        return;
    };

    let overview = overview_value(sdk.inspect.overview(ThreadRef::file_path(&file_path)).await);
    assert_eq!(overview.thread.id, created.thread_id);
    let _: &str = overview.thread.created_at.as_str();
    assert_eq!(
        overview.events,
        InspectOverviewEvents {
            count: 0,
            span: None
        }
    );
    assert_eq!(
        overview.messages,
        InspectOverviewMessages {
            visible: 0,
            by_kind: IndexMap::new(),
            deleted: 0,
            visible_tokens: 0,
        }
    );
    assert_eq!(overview.turns, InspectOverviewTurns { open: 1, closed: 0 });
    assert_eq!(
        overview.chunks,
        InspectOverviewChunks {
            count: 0,
            unchunked_turns: 0
        }
    );
    assert_eq!(overview.derivation, zero_derivation());
    assert!(overview.view.is_none());
    assert_eq!(
        overview.visibility,
        InspectOverviewVisibility {
            boundary_position: 0,
            zone_tokens: 0
        }
    );
}

#[tokio::test]
async fn mid_first_turn_open_turn_queued_derivation_no_view_full_shape() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = ctx.store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(ctx.store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    let sent = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "first prompt, turn still open".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload::new("thinking about it")),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
    assert!(sent.is_ok());

    let overview = overview_value(sdk.inspect.overview(ThreadRef::file_path(&file_path)).await);
    assert_eq!(
        overview.events,
        InspectOverviewEvents {
            count: 2,
            span: Some(InspectOverviewEventsSpan { first: 1, last: 2 }),
        }
    );
    assert_eq!(overview.messages.visible, 2);
    assert_eq!(
        overview.messages.by_kind,
        IndexMap::from([("user_prompt".into(), 1), ("assistant_thinking".into(), 1),])
    );
    assert_eq!(overview.messages.deleted, 0);
    assert!(overview.messages.visible_tokens > 0);
    assert_eq!(overview.turns, InspectOverviewTurns { open: 1, closed: 0 });
    assert_eq!(
        overview.chunks,
        InspectOverviewChunks {
            count: 0,
            unchunked_turns: 0
        }
    );
    assert_eq!(
        overview.derivation,
        InspectOverviewDerivation {
            ready: 0,
            pending: 1,
            failed: 0,
            blocked: 0,
        }
    );
    assert!(overview.view.is_none());
    assert_eq!(overview.visibility.boundary_position, 0);
}

#[tokio::test]
async fn never_compacted_with_record_real_counts_view_null() {
    let ctx = setup();
    let small = two_turn_thread(&ctx.store).await;
    let overview = overview_value(
        small
            .sdk
            .inspect
            .overview(ThreadRef::file_path(&small.file_path))
            .await,
    );
    assert_eq!(overview.thread.id, small.thread_id);
    assert_eq!(
        overview.events,
        InspectOverviewEvents {
            count: 8,
            span: Some(InspectOverviewEventsSpan { first: 1, last: 8 }),
        }
    );
    assert_eq!(overview.messages.visible, 6);
    assert_eq!(
        overview.messages.by_kind,
        IndexMap::from([
            ("user_prompt".into(), 2),
            ("assistant_text".into(), 2),
            ("tool_call".into(), 1),
            ("tool_result".into(), 1),
        ])
    );
    assert_eq!(overview.messages.deleted, 0);
    assert_eq!(overview.turns, InspectOverviewTurns { open: 1, closed: 2 });
    assert_eq!(
        overview.chunks,
        InspectOverviewChunks {
            count: 1,
            unchunked_turns: 0
        }
    );
    assert_eq!(
        overview.derivation,
        InspectOverviewDerivation {
            ready: 9,
            pending: 0,
            failed: 0,
            blocked: 0,
        }
    );
    assert!(overview.view.is_none());
}

#[tokio::test]
async fn compacted_tool_heavy_fixture_exact_counts_in_every_section() {
    let ctx = setup();
    let fixture = derived_thread_fixture(&ctx.store, DerivedThreadOptions { failures: None }).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;
    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: None,
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    assert!(compacted.is_ok());
    let OpResult::Ok { value: compacted } = compacted else {
        return;
    };

    let overview = overview_value(sdk.inspect.overview(ThreadRef::file_path(&file_path)).await);
    assert_eq!(
        overview.events,
        InspectOverviewEvents {
            count: 64,
            span: Some(InspectOverviewEventsSpan { first: 1, last: 64 }),
        }
    );
    assert_eq!(overview.messages.visible, 52);
    assert_eq!(
        overview.messages.by_kind,
        IndexMap::from([
            ("user_prompt".into(), 12),
            ("assistant_thinking".into(), 12),
            ("assistant_text".into(), 12),
            ("tool_call".into(), 8),
            ("tool_result".into(), 8),
        ])
    );
    assert_eq!(overview.messages.deleted, 0);
    assert!(overview.messages.visible_tokens > 0);
    assert_eq!(
        overview.turns,
        InspectOverviewTurns {
            open: 1,
            closed: 12
        }
    );
    assert_eq!(
        overview.chunks,
        InspectOverviewChunks {
            count: 4,
            unchunked_turns: 0
        }
    );
    assert_eq!(
        overview.derivation,
        InspectOverviewDerivation {
            ready: 60,
            pending: 0,
            failed: 2,
            blocked: 0,
        }
    );
    let view = overview.view.expect("view");
    assert_eq!(view.view_id, compacted.view_id);
    let _: &str = view.created_at.as_str();
    assert_eq!(view.compact_point, compacted.compact_point);
    assert_eq!(view.covered_from, compacted.covered_from);

    let db = open_raw(&file_path);
    let boundary = db
        .prepare("SELECT position FROM view_boundary")
        .get()
        .expect("boundary row")
        .get("position")
        .and_then(|v| v.as_i64())
        .expect("position");
    db.close();
    let status = sdk
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    assert_eq!(
        overview.visibility,
        InspectOverviewVisibility {
            boundary_position: boundary,
            zone_tokens: status.visibility.zone_tokens,
        }
    );
}

#[tokio::test]
async fn mid_rebuild_cleared_cascade_pending_view_summary_intact_full_shape() {
    let ctx = setup();
    let fixture = mutation_in_flight_variant(&ctx.store).await;
    let overview = overview_value(
        fixture
            .sdk
            .inspect
            .overview(ThreadRef::file_path(&fixture.file_path))
            .await,
    );
    assert_eq!(fixture.mutation.cleared.len(), 6);
    assert_eq!(
        overview.derivation,
        InspectOverviewDerivation {
            ready: 56,
            pending: 6,
            failed: 0,
            blocked: 0,
        }
    );
    assert_eq!(
        overview.turns,
        InspectOverviewTurns {
            open: 1,
            closed: 12
        }
    );
    assert_eq!(
        overview.chunks,
        InspectOverviewChunks {
            count: 4,
            unchunked_turns: 0
        }
    );
    let view = overview.view.expect("view");
    assert_eq!(view.view_id, fixture.compact_receipt.view_id);
    let _: &str = view.created_at.as_str();
    assert_eq!(view.compact_point, fixture.compact_receipt.compact_point);
    assert_eq!(view.covered_from, fixture.compact_receipt.covered_from);
    assert_eq!(overview.events.count, 64);
    assert_eq!(overview.messages.visible, 52);
}

#[tokio::test]
async fn deleting_one_message_drops_visible_kind_token_counts_raises_deleted_leaves_events_alone() {
    let ctx = setup();
    let small = two_turn_thread(&ctx.store).await;
    let file_path = &small.file_path;
    let sdk = &small.sdk;
    let before = overview_value(sdk.inspect.overview(ThreadRef::file_path(file_path)).await);

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let target = listed.iter().find(|r| r.message_id == "m2");
    assert_eq!(target.map(|t| t.kind.as_str()), Some("assistant_text"));
    let Some(target) = target else {
        return;
    };

    let deleted = sdk
        .messages
        .remove(
            ThreadRef::file_path(file_path),
            RemoveInput {
                message_id: "m2".into(),
            },
        )
        .await;
    assert!(deleted.is_ok());

    let after = overview_value(sdk.inspect.overview(ThreadRef::file_path(file_path)).await);
    assert_eq!(after.messages.visible, before.messages.visible - 1);
    assert_eq!(after.messages.deleted, 1);
    let mut expected_by_kind = before.messages.by_kind.clone();
    let prev = expected_by_kind.get("assistant_text").copied().unwrap_or(0);
    // TS `?? 0` — Option selection, not truthiness.
    expected_by_kind.insert("assistant_text".into(), prev - 1);
    assert_eq!(after.messages.by_kind, expected_by_kind);
    assert_eq!(
        after.messages.visible_tokens,
        before.messages.visible_tokens - target.token_estimate
    );
    assert_eq!(after.events, before.events);
}

#[tokio::test]
async fn repeated_calls_are_deep_equal_leave_no_delta_create_no_work_call_no_model() {
    let ctx = setup();
    let fixture = mutation_in_flight_variant(&ctx.store).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;
    let captured = fixture.double.capture_inputs();

    let first = expect_read_only(&file_path, || {
        sdk.inspect.overview(ThreadRef::file_path(&file_path))
    })
    .await;
    let second = expect_read_only(&file_path, || {
        sdk.inspect.overview(ThreadRef::file_path(&file_path))
    })
    .await;
    assert!(first.is_ok() && second.is_ok());
    assert_eq!(second, first);
    assert_eq!(captured.len(), 0);
}

#[tokio::test]
async fn overview_succeeds_under_a_throwing_inference_callback_and_wraps_story_1_reads_in_the_delta_assert()
 {
    let ctx = setup();
    let small = two_turn_thread(&ctx.store).await;
    let file_path = small.file_path.clone();
    let reader = init_lhc(SdkConfig {
        inference_callbacks: Some(throwing_provider()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });

    let overview = expect_read_only(&file_path, || {
        reader.inspect.overview(ThreadRef::file_path(&file_path))
    })
    .await;
    assert!(overview.is_ok());
    let listed = expect_read_only(&file_path, || {
        reader.messages.list(
            ThreadRef::file_path(&file_path),
            Some(MessageListOptions {
                include_deleted: Some(true),
                for_user_chat: None,
                ..Default::default()
            }),
        )
    })
    .await;
    let shown = expect_read_only(&file_path, || {
        reader.messages.show(ThreadRef::file_path(&file_path), "m1")
    })
    .await;
    assert!(listed.is_ok() && shown.is_ok());
}

#[tokio::test]
async fn overview_on_a_missing_thread_is_thread_not_found_not_a_shape_error() {
    let ctx = setup();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let missing = sdk
        .inspect
        .overview(ThreadRef::file_path(
            ctx.store
                .thread_path(Some("missing"))
                .to_string_lossy()
                .as_ref(),
        ))
        .await;
    assert!(!missing.is_ok());
    let OpResult::Err { error } = missing else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
}
