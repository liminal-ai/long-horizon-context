//! Ported from packages/lhc/test/messages-read.test.ts. Phase 1.
//!
//! Story 1 (Epic 04), default suite: TC-3.1–3.3 — the message read surface.
//! Bounded listing in source-event-order coordinates (DD-3), show returning
//! the canonical record (full blocks, never view-shortened) composed with the
//! owner report's form entries (DD-2), and the deleted-audit contract
//! (excluded by default, listable flagged on request, show never not-found).
//! Plus the architecture-risk legs: every read leaves observable state
//! unchanged (read-only delta, DD-6) and calls no model.

mod fixtures;

use std::time::Duration;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, ClosingDb, InferenceCallbacksDouble, TempStore,
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    poison_message_block_json, poison_message_form_json, read_derived_forms, temp_store,
    valid_event,
};
use lhc::intake_stream::EventRecord;
use lhc::messages::{
    MessageKind, MessageListOptions, MessageRecord, MessageReportOpts, RemoveInput,
};
use lhc::retrieval::RetrievedTurnSource;
use lhc::shared_tech::derivation::{Derivation, DerivationState, SdkConfig, SdkMode, ToolOutcome};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::PreviewCompactOutcome;
use lhc::shared_tech::view::ViewStatus;
use lhc::shared_tech::work_queue::{WorkItemRecord, WorkOwner, list_items};
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, intake_stream, messages, thread_view};
use serde_json::{Map, Value};

/// Long enough that any view-form shortening would be visible: show must
/// return this verbatim (AC-3.2's record-not-view contract).
fn tool_result_content() -> String {
    [
        "contents of notes.txt — full record content:",
        "line 1: the quick brown fox jumps over the lazy dog",
        "line 2: detailed tool output that a boundary-shortened form would drop",
        "line 3: trailing detail proving the record came back complete",
    ]
    .join("\n")
}

struct ReadFixture {
    file_path: String,
    sdk: Lhc,
    double: InferenceCallbacksDouble,
}

/// Two closed turns through real intake, fully drained against the
/// deterministic double so m1's smoothing and m3/m4's tool summaries sit
/// ready with mechanically stamped outcome metadata. Messages: m1 prompt,
/// m2 text, m3 call, m4 result (turn 1; turn_end is event 5, no message);
/// m6 prompt, m7 text (turn 2). Source event orders 1,2,3,4,6,7.
async fn read_fixture(store: &TempStore) -> ReadFixture {
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
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("fixture thread creation failed: {}", error.reason);
    }
    let mut tool_args = Map::new();
    tool_args.insert("path".into(), Value::String("notes.txt".into()));
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
                        tool_call_id: "call-read-1".into(),
                        tool_name: "read_file".into(),
                        arguments: tool_args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-read-1".into(),
                        content: tool_result_content(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
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
            valid_event(kind::TURN_END, Default::default()),
        ],
    ];
    for batch in &batches {
        let sent = sdk
            .intake_stream
            .message_events(ThreadRef::file_path(&file_path), batch)
            .await;
        if !sent.is_ok() {
            let OpResult::Err { error } = sent else {
                unreachable!()
            };
            panic!("fixture batch failed: {}", error.reason);
        }
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    match drained {
        OpResult::Ok { value } => {
            if value.remaining != 0 {
                panic!("fixture drain left {} items behind", value.remaining);
            }
        }
        OpResult::Err { error } => panic!("fixture drain failed: {}", error.reason),
    }
    ReadFixture {
        file_path,
        sdk,
        double,
    }
}

fn ids_of(result: &OpResult<Vec<MessageRecord>>) -> Vec<String> {
    match result {
        OpResult::Ok { value } => value.iter().map(|r| r.message_id.clone()).collect(),
        OpResult::Err { .. } => panic!("expected an ok list result"),
    }
}

fn queued_for(file_path: &str, owner: WorkOwner) -> Vec<WorkItemRecord> {
    let db = open_raw(file_path);
    let items = list_items(&db, owner);
    db.close();
    items
}

/// The DD-6 observable-state snapshot: queued work through both owners, view
/// boundary/zone through status, derived-form rows, and the event log. A read
/// that mutates any of these fails the before/after deep-equal.
async fn observable_state(file_path: &str) -> ObservableSnapshot {
    // TS stores the full OpResult wrappers from listEvents / status (not unwrapped values).
    ObservableSnapshot {
        events: intake_stream::list_events(ThreadRef::file_path(file_path)).await,
        message_work: queued_for(file_path, WorkOwner::Messages),
        turn_work: queued_for(file_path, WorkOwner::Turns),
        view_status: thread_view::status(ThreadRef::file_path(file_path)).await,
        derivations: read_derived_forms(file_path),
    }
}

#[derive(Debug, PartialEq)]
struct ObservableSnapshot {
    events: OpResult<Vec<EventRecord>>,
    message_work: Vec<WorkItemRecord>,
    turn_work: Vec<WorkItemRecord>,
    view_status: OpResult<ViewStatus>,
    derivations: Vec<Derivation>,
}

/// A thread with live, undrained work: one tool turn through a manual SDK
/// (its no-op seam never drains), leaving three pending forms and their queue
/// rows. The background read-only proof needs the pending state the manual
/// read-only proof above cannot manufacture.
async fn pending_work_thread(store: &TempStore) -> String {
    let seeder = init_lhc(SdkConfig {
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
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = seeder
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("pending fixture thread creation failed: {}", error.reason);
    }
    let mut tool_args = Map::new();
    tool_args.insert("path".into(), Value::String("bg.txt".into()));
    let sent = seeder
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "background prompt".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "call-bg-1".into(),
                            tool_name: "read_file".into(),
                            arguments: tool_args,
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: "call-bg-1".into(),
                            content: "background output".into(),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("background answer")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, Default::default()),
            ],
        )
        .await;
    if !sent.is_ok() {
        let OpResult::Err { error } = sent else {
            unreachable!()
        };
        panic!("pending fixture intake failed: {}", error.reason);
    }
    file_path
}

/// Below-SDK raw snapshot of everything a wrongly-scheduled catch-up drain
/// would move: work-item rows and derived-form states. Read through a raw
/// handle (openRaw), never the SDK ops — those would fire their own touch and
/// pollute the very state under test.
fn raw_work_and_forms(file_path: &str) -> (Vec<Map<String, Value>>, Vec<Map<String, Value>>) {
    let db = open_raw(file_path);
    let work_items = db
        .prepare("SELECT work_item_id, status FROM work_item ORDER BY work_item_id")
        .all(&[]);
    let derivations = db
        .prepare(
            "SELECT subject_id, derivation_type, state, source_version FROM derivation
           ORDER BY subject_id, derivation_type",
        )
        .all(&[]);
    db.close();
    (work_items, derivations)
}

#[tokio::test]
async fn returns_messages_in_record_order_with_kind_token_estimate_and_turn_membership() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let listed = messages::list(ThreadRef::file_path(&fixture.file_path), None).await;
    assert!(listed.is_ok());
    let OpResult::Ok { value } = listed else {
        return;
    };
    assert_eq!(
        value
            .iter()
            .map(|m| m.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2", "m3", "m4", "m6", "m7"]
    );
    assert_eq!(
        value
            .iter()
            .map(|m| m.source_event_order)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 6, 7]
    );
    assert_eq!(
        value.iter().map(|m| m.kind).collect::<Vec<_>>(),
        [
            MessageKind::UserPrompt,
            MessageKind::AssistantText,
            MessageKind::ToolCall,
            MessageKind::ToolResult,
            MessageKind::UserPrompt,
            MessageKind::AssistantText,
        ]
    );
    assert_eq!(
        value.iter().map(|m| m.turn_id.as_str()).collect::<Vec<_>>(),
        ["t1", "t1", "t1", "t1", "t2", "t2"]
    );
    for record in &value {
        assert!(record.token_estimate > 0);
        assert_eq!(record.deleted, None);
    }
}

#[tokio::test]
async fn honors_from_to_limit_windows_exactly_in_source_event_order_coordinates() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let windows: Vec<(MessageListOptions, &[&str])> = vec![
        (
            MessageListOptions {
                from: Some(2),
                to: Some(4),
                for_user_chat: None,
                ..Default::default()
            },
            &["m2", "m3", "m4"],
        ),
        (
            MessageListOptions {
                from: Some(6),
                for_user_chat: None,
                ..Default::default()
            },
            &["m6", "m7"],
        ),
        (
            MessageListOptions {
                to: Some(2),
                for_user_chat: None,
                ..Default::default()
            },
            &["m1", "m2"],
        ),
        (
            MessageListOptions {
                limit: Some(3),
                for_user_chat: None,
                ..Default::default()
            },
            &["m1", "m2", "m3"],
        ),
        (
            MessageListOptions {
                from: Some(2),
                limit: Some(2),
                for_user_chat: None,
                ..Default::default()
            },
            &["m2", "m3"],
        ),
        (
            MessageListOptions {
                from: Some(4),
                to: Some(4),
                for_user_chat: None,
                ..Default::default()
            },
            &["m4"],
        ),
        (
            MessageListOptions {
                from: Some(5),
                to: Some(5),
                for_user_chat: None,
                ..Default::default()
            },
            &[], // the turn_end order: an event, never a message
        ),
    ];
    for (opts, expected) in windows {
        let ids =
            ids_of(&messages::list(ThreadRef::file_path(&fixture.file_path), Some(opts)).await);
        assert_eq!(ids, expected);
    }
}

#[tokio::test]
async fn refuses_bad_bounds_as_caller_errors_and_returns_no_partial_window() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    // TS also probes `{ from: 1.5 }` — statically unrepresentable at the i64
    // MessageListOptions boundary; omitted here (comment only).
    let bad_bounds = [
        MessageListOptions {
            from: Some(5),
            to: Some(2),
            for_user_chat: None,
            ..Default::default()
        },
        MessageListOptions {
            limit: Some(0),
            for_user_chat: None,
            ..Default::default()
        },
        MessageListOptions {
            limit: Some(-1),
            for_user_chat: None,
            ..Default::default()
        },
    ];
    for opts in bad_bounds {
        let refused = messages::list(ThreadRef::file_path(&fixture.file_path), Some(opts)).await;
        assert!(!refused.is_ok());
        let OpResult::Err { error } = refused else {
            continue;
        };
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::InvalidBounds);
    }
}

#[tokio::test]
async fn a_drained_tool_result_message_comes_back_with_full_content_form_states_and_outcome_metadata()
 {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let shown = messages::show(ThreadRef::file_path(&fixture.file_path), "m4").await;
    assert!(shown.is_ok());
    let OpResult::Ok { value: detail } = shown else {
        return;
    };
    assert_eq!(detail.message_id, "m4");
    assert_eq!(detail.kind, MessageKind::ToolResult);
    assert_eq!(detail.turn_id, "t1");
    assert!(!detail.deleted);
    assert!(detail.token_estimate > 0);
    // The record, not the view: the complete original tool result verbatim.
    assert_eq!(detail.blocks.len(), 1);
    assert_eq!(detail.blocks[0].block_type.as_str(), "tool_result");
    assert_eq!(
        detail.blocks[0]
            .content
            .get("content")
            .and_then(|v| v.as_str()),
        Some(tool_result_content().as_str())
    );
    assert_eq!(
        detail.blocks[0]
            .content
            .get("toolCallId")
            .and_then(|v| v.as_str()),
        Some("call-read-1")
    );
    // Forms with states and tool-outcome metadata, joined from the owner.
    assert_eq!(detail.derivations.len(), 1);
    let summary = &detail.derivations[0];
    assert_eq!(summary.derivation_type, "tool_result_summary");
    assert_eq!(summary.state, DerivationState::Ready);
    assert!(summary.content.is_some());
    assert_eq!(
        summary.metadata.as_ref().and_then(|m| m.outcome),
        Some(ToolOutcome::Succeeded)
    );
    // Anti-shim: the forms ARE the owner report's entries for this message,
    // never a synthesized join (DD-2).
    let report = messages::report(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageReportOpts {
            message_id: Some("m4".into()),
            not_ready: None,
        }),
    )
    .await;
    assert!(report.is_ok());
    let OpResult::Ok {
        value: report_value,
    } = report
    else {
        return;
    };
    assert_eq!(detail.derivations, report_value);
}

#[tokio::test]
async fn a_drained_prompt_shows_its_smoothing_form_alongside_the_full_record() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let shown = messages::show(ThreadRef::file_path(&fixture.file_path), "m1").await;
    assert!(shown.is_ok());
    let OpResult::Ok { value } = shown else {
        return;
    };
    assert_eq!(
        value.blocks[0].content.get("text").and_then(|v| v.as_str()),
        Some("please read notes.txt")
    );
    assert_eq!(
        value
            .derivations
            .iter()
            .map(|form| (form.derivation_type.as_str(), form.state))
            .collect::<Vec<_>>(),
        [("smoothed_prompt", DerivationState::Ready)]
    );
}

#[tokio::test]
async fn default_list_excludes_a_deleted_message_include_deleted_lists_it_marked_show_returns_it_flagged()
 {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let deleted = messages::remove(
        ThreadRef::file_path(&fixture.file_path),
        RemoveInput {
            message_id: "m2".into(),
        },
    )
    .await;
    assert!(deleted.is_ok());

    let default_list = messages::list(ThreadRef::file_path(&fixture.file_path), None).await;
    assert_eq!(ids_of(&default_list), ["m1", "m3", "m4", "m6", "m7"]);

    let audited = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            include_deleted: Some(true),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await;
    assert!(audited.is_ok());
    let OpResult::Ok { value } = audited else {
        return;
    };
    assert_eq!(
        value
            .iter()
            .map(|m| m.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2", "m3", "m4", "m6", "m7"]
    );
    for record in &value {
        if record.message_id == "m2" {
            assert_eq!(record.deleted, Some(true));
        } else {
            assert_eq!(record.deleted, None);
        }
    }

    // Show on the deleted message is the audit read: the record, flagged —
    // never a not-found.
    let shown = messages::show(ThreadRef::file_path(&fixture.file_path), "m2").await;
    assert!(shown.is_ok());
    let OpResult::Ok { value } = shown else {
        return;
    };
    assert!(value.deleted);
    assert_eq!(
        value.blocks[0].content.get("text").and_then(|v| v.as_str()),
        Some("reading it now")
    );
}

#[tokio::test]
async fn show_on_a_missing_id_is_message_not_found() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let missing = messages::show(ThreadRef::file_path(&fixture.file_path), "m99").await;
    assert!(!missing.is_ok());
    let OpResult::Err { error } = missing else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::MessageNotFound);
}

#[tokio::test]
async fn list_and_show_in_every_mode_leave_observable_state_unchanged_and_call_no_model() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    let captured = fixture.double.capture_inputs();
    let before = observable_state(&fixture.file_path).await;

    let _ = messages::list(ThreadRef::file_path(&fixture.file_path), None).await;
    let _ = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            from: Some(2),
            to: Some(4),
            limit: Some(2),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await;
    let _ = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            include_deleted: Some(true),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await;
    let _ = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            from: Some(9),
            to: Some(1),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await; // refused, must not write either
    let _ = messages::show(ThreadRef::file_path(&fixture.file_path), "m4").await;
    let _ = messages::show(ThreadRef::file_path(&fixture.file_path), "m99").await; // not-found

    let after = observable_state(&fixture.file_path).await;
    assert_eq!(after, before);
    assert_eq!(captured.len(), 0);
    let _ = fixture.sdk;
}

#[tokio::test]
async fn list_and_show_through_a_background_sdk_with_pending_work_call_no_model_and_advance_no_form()
 {
    let store = temp_store();
    let file_path = pending_work_thread(&store).await;

    // A fresh background SDK whose scheduler WOULD hang a first-touch catch-up
    // drain — and the model call that drain makes — off the open
    // announcement (openThreadDatabase → fireThreadTouch → scheduler.touch) if
    // list or show fired it. The touch-suppressed read scope is what stops it;
    // this is the production-path proof a manual-mode no-op seam cannot give.
    let bg_double = create_inference_callbacks_double();
    let bg = init_lhc(SdkConfig {
        inference_callbacks: Some(bg_double.to_callbacks()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let captured = bg_double.capture_inputs();
    let before = raw_work_and_forms(&file_path);

    let listed = bg
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let _ = bg
        .messages
        .list(
            ThreadRef::file_path(&file_path),
            Some(MessageListOptions {
                limit: Some(1),
                for_user_chat: None,
                ..Default::default()
            }),
        )
        .await;
    let shown = bg
        .messages
        .show(ThreadRef::file_path(&file_path), "m1")
        .await;
    assert!(listed.is_ok() && shown.is_ok());
    let (
        OpResult::Ok {
            value: listed_value,
        },
        OpResult::Ok { value: shown_value },
    ) = (listed, shown)
    else {
        return;
    };

    // The reads ran against the live, undrained queue — the records carry
    // their pending forms — so this is no vacuous pass on an empty thread.
    let listed_forms: Vec<_> = listed_value
        .iter()
        .flat_map(|m| m.derivations.iter().flatten())
        .collect();
    assert!(!listed_forms.is_empty());
    assert!(
        listed_forms
            .iter()
            .all(|form| form.state == DerivationState::Pending)
    );
    assert_eq!(
        shown_value
            .derivations
            .iter()
            .map(|form| form.state)
            .collect::<Vec<_>>(),
        [DerivationState::Pending]
    );

    // Give any wrongly-scheduled catch-up drain room to surface, then wait the
    // scheduler out before asserting nothing moved underneath the reads.
    tokio::time::sleep(Duration::from_millis(25)).await;
    bg.drain_settled(ThreadRef::file_path(&file_path)).await;

    // Reads only: every work-item and form row is exactly as before, and the
    // background inference callbacks observed zero calls — no first-touch drain fired.
    assert_eq!(raw_work_and_forms(&file_path), before);
    assert_eq!(captured.len(), 0);
}

#[tokio::test]
async fn a_bounded_list_excluding_out_of_window_rows_never_loads_their_blocks_or_forms() {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    // Corrupt content the bounds must exclude: m7's block (an out-of-window
    // message) and m4's tool-result-summary metadata (an out-of-window form).
    // Any read that loads either row throws on JSON.parse, so a bounded list
    // that still succeeds proves it never read outside its window.
    poison_message_block_json(&fixture.file_path, "m7");
    poison_message_form_json(&fixture.file_path, "m4");

    // In-window reads succeed and return exactly the window — the poisoned
    // rows are sourced neither as blocks nor as forms.
    for opts in [
        MessageListOptions {
            to: Some(1),
            for_user_chat: None,
            ..Default::default()
        },
        MessageListOptions {
            limit: Some(1),
            for_user_chat: None,
            ..Default::default()
        },
    ] {
        let bounded = messages::list(ThreadRef::file_path(&fixture.file_path), Some(opts)).await;
        assert!(bounded.is_ok());
        let OpResult::Ok { value } = bounded else {
            return;
        };
        assert_eq!(
            value
                .iter()
                .map(|m| m.message_id.as_str())
                .collect::<Vec<_>>(),
            ["m1"]
        );
        assert_eq!(
            value[0].blocks[0]
                .content
                .get("text")
                .and_then(|v| v.as_str()),
            Some("please read notes.txt")
        );
    }

    // Positive controls: a window that *includes* a poisoned row does load it
    // and fails on parse — proof the pills are real, so the passes above are
    // genuine no-loads, not silently-dropped output.
    let hits_block = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            from: Some(7),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await;
    assert!(!hits_block.is_ok());
    let hits_form = messages::list(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageListOptions {
            from: Some(4),
            to: Some(4),
            for_user_chat: None,
            ..Default::default()
        }),
    )
    .await;
    assert!(!hits_form.is_ok());
}

// Large unbounded message reads: a mature thread holds more messages than
// SQLite accepts as one bound-parameter list, so every id-scoped read must
// batch. Pre-fix this fails at prepare/bind with "too many SQL variables".
//
// One fixture proves all three id-scoped readers: list (block loading),
// preview (message-derivation attachment), and — once t2's ready rendering is
// withheld — retrieval's live-compose fallback, the production path that hands
// a whole turn's member ids to the turn-domain derivation-row reader.
#[tokio::test]
async fn lists_previews_and_live_composes_more_messages_than_sqlite_accepts_as_one_bound_parameter_list()
 {
    let store = temp_store();
    let fixture = read_fixture(&store).await;
    {
        // ClosingDb is the Rust stand-in for the TS try/finally around
        // db.close(); one transaction keeps 34k inserts bounded and atomic.
        let handle = ClosingDb::open(&fixture.file_path);
        let db = handle.db();
        db.exec("BEGIN IMMEDIATE;");
        for index in 0..34_000i64 {
            let id = format!("large-{index}");
            let order = 10_000 + index;
            let content = js_json_stringify(&serde_json::json!({
                "text": format!("large read {index}"),
            }));
            db.prepare(
                r#"INSERT INTO event
                     (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
                   VALUES (?, 'assistant_text', ?, 'assistant', 'test', ?, '2026-01-01T00:00:00.000Z')"#,
            )
            .run(&[
                SqlParam::from(order),
                SqlParam::from(id.as_str()),
                SqlParam::from(content.as_str()),
            ]);
            db.prepare(
                r#"INSERT INTO message
                     (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
                   VALUES (?, ?, 'assistant_text', 1, 'assistant', 'test', 't2')"#,
            )
            .run(&[SqlParam::from(id.as_str()), SqlParam::from(order)]);
            db.prepare(
                r#"INSERT INTO message_block (message_id, block_index, block_type, content)
                   VALUES (?, 0, 'text', ?)"#,
            )
            .run(&[
                SqlParam::from(id.as_str()),
                SqlParam::from(content.as_str()),
            ]);
        }
        db.exec("COMMIT;");
    }

    let listed = messages::list(ThreadRef::file_path(&fixture.file_path), None).await;
    let OpResult::Ok { value } = &listed else {
        let OpResult::Err { error } = &listed else {
            unreachable!()
        };
        panic!("{:?}: {}", error.code, error.reason);
    };
    assert_eq!(value.len(), 34_006);
    assert_eq!(
        value
            .last()
            .and_then(|record| record.blocks.first())
            .and_then(|block| block.content.get("text"))
            .and_then(|text| text.as_str()),
        Some("large read 33999")
    );

    let preview = fixture
        .sdk
        .thread_view
        .preview_compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: None,
                params: None,
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    let OpResult::Ok { value } = &preview else {
        let OpResult::Err { error } = &preview else {
            unreachable!()
        };
        panic!("{:?}: {}", error.code, error.reason);
    };
    assert!(matches!(value, PreviewCompactOutcome::Ok { .. }));

    // Withhold t2's ready turn_rendering: retrieval accepts a stored labeled
    // rendering when it exists, so removing it is what forces the live-compose
    // fallback to walk every one of the turn's 34,002 members.
    {
        let handle = ClosingDb::open(&fixture.file_path);
        handle
            .db()
            .prepare(
                r#"DELETE FROM derivation
                   WHERE subject_kind = 'turn' AND subject_id = 't2'
                     AND derivation_type = 'turn_rendering'"#,
            )
            .run(&[]);
    }

    let turns = fixture
        .sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&fixture.file_path),
            &["t2".to_string()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = &turns else {
        let OpResult::Err { error } = &turns else {
            unreachable!()
        };
        panic!("{:?}: {}", error.code, error.reason);
    };
    let turn = receipt.served.first().expect("t2 served");
    assert_eq!(turn.source, RetrievedTurnSource::Composed);
    assert!(turn.text.starts_with("<t2>"));
    // The composition is far past the 8k serving budget, so the receipt is a
    // slice whose total covers the whole live-composed turn — proof the
    // fallback rendered every member rather than a truncated prefix.
    let slice = turn.slice.as_ref().expect("over-budget composition slices");
    assert_eq!(slice.from_token, 0);
    assert!(slice.total_tokens > 34_000, "{}", slice.total_tokens);
}
