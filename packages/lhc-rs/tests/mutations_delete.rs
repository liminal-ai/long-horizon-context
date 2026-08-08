//! Ported from packages/lhc/test/mutations-delete.test.ts. Phase 1.
//!
//! Story 6 (Epic 02): messages.remove — Flow 6.

mod fixtures;

use std::sync::{Mutex, MutexGuard};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName, TempStore,
    ToolCallOverrides, ToolResultOverrides, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, kind, open_raw, read_derived_forms, temp_store, valid_event,
};
use lhc::intake_stream::EventRecord;
use lhc::messages::{MessageRecord, RemoveInput};
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Derivation, DerivationState, InferenceCallbacks, LeaseConfig, SdkConfig,
    SdkMode, SubjectKind,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::scheduler::DrainReport;
use lhc::shared_tech::work_queue::{QueueDetailRow, WorkKind, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{ChunkRecord, TurnRecord};
use lhc::{
    Lhc, init_lhc, intake_stream, messages, set_scheduler_poke, set_thread_touch, threads, turns,
};

async fn new_thread(store: &TempStore) -> String {
    match threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

fn manual_sdk(
    inference_callbacks: InferenceCallbacks,
    chunk_policy: Option<ChunkPolicyConfig>,
    mode: SdkMode,
) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 5000 }),
        chunk_policy,
        view: None,
    })
}

async fn send(sdk: &Lhc, file_path: &str, batch: &[lhc::intake_stream::MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("batch failed: {}", error.reason);
    }
}

async fn drain(sdk: &Lhc, file_path: &str) -> DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("drain failed: {}", error.reason),
    }
}

fn raw_detail(file_path: &str) -> Vec<QueueDetailRow> {
    let db = open_raw(file_path);
    let rows = queue_detail(&db);
    db.close();
    rows
}

fn clear_key_form(form: &Derivation) -> String {
    format!(
        "{}/{}/{}",
        form.subject_kind.as_str(),
        form.subject_id,
        form.derivation_type
    )
}

fn clear_key_clear(entry: &lhc::messages::internal::cascade::CascadeClear) -> String {
    format!(
        "{}/{}/{}",
        entry.subject_kind.as_str(),
        entry.subject_id,
        entry.derivation_type
    )
}

fn unwrap_ok<T>(result: OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok result, got {:?}", error.code),
    }
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    messages: Vec<MessageRecord>,
    turns: Vec<TurnRecord>,
    chunks: Vec<ChunkRecord>,
    events: Vec<EventRecord>,
    derivations: Vec<Derivation>,
    queue: Vec<QueueDetailRow>,
}

async fn snapshot(file_path: &str) -> Snapshot {
    Snapshot {
        messages: unwrap_ok(messages::list(ThreadRef::file_path(file_path), None).await),
        turns: unwrap_ok(turns::list_turns(ThreadRef::file_path(file_path)).await),
        chunks: unwrap_ok(turns::list_chunks(ThreadRef::file_path(file_path)).await),
        events: unwrap_ok(intake_stream::list_events(ThreadRef::file_path(file_path)).await),
        derivations: read_derived_forms(file_path),
        queue: raw_detail(file_path),
    }
}

async fn tool_run_thread(sdk: &Lhc, store: &TempStore) -> String {
    let file_path = new_thread(store).await;
    send(
        sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "use the tool".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TOOL_CALL, Default::default()),
            valid_event(kind::TOOL_RESULT, Default::default()),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("tool run done")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(sdk, &file_path).await;
    file_path
}

/// Serializes tests that touch below-SDK poke/touch slots. Drop always dispatches
/// the TS afterEach resets; Phase 1 setters are exact todos, so each call is
/// wrapped in `catch_unwind` to avoid aborting during an existing unwind.
static HOOKS_TEST_LOCK: Mutex<()> = Mutex::new(());

struct HookGuard {
    _lock: MutexGuard<'static, ()>,
}

impl HookGuard {
    fn acquire() -> Self {
        let lock = HOOKS_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self { _lock: lock }
    }
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            set_scheduler_poke(None);
        }));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            set_thread_touch(None);
        }));
    }
}

#[tokio::test]
async fn deleting_a_tool_result_message_removes_it_from_message_reads_and_turn_membership_not_from_event_read_back()
 {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = tool_run_thread(&sdk, &store).await;
    let events_before =
        unwrap_ok(intake_stream::list_events(ThreadRef::file_path(&file_path)).await);

    let result = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m3".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert_eq!(value.changed.message_ids, ["m3"]);
    assert!(value.changed.turn_ids.is_empty());

    let records = unwrap_ok(messages::list(ThreadRef::file_path(&file_path), None).await);
    assert_eq!(
        records
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2", "m4"]
    );

    let turn_records = unwrap_ok(turns::list_turns(ThreadRef::file_path(&file_path)).await);
    assert_eq!(turn_records.len(), 2);
    assert_eq!(turn_records[0].member_message_ids, ["m1", "m2", "m4"]);

    assert_eq!(
        unwrap_ok(intake_stream::list_events(ThreadRef::file_path(&file_path)).await),
        events_before
    );
    assert!(
        events_before
            .iter()
            .any(|e| e.event_kind() == lhc::intake_stream::EventKind::ToolResult)
    );
}

#[tokio::test]
async fn the_deleted_messages_forms_are_gone_its_turn_and_chunk_re_queue_chunk_2_is_byte_stable() {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        Some(ChunkPolicyConfig {
            target_projected_tokens: 1,
            max_projected_tokens: 1,
        }),
        SdkMode::Manual,
    );
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "first prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TOOL_CALL, Default::default()),
            valid_event(kind::TOOL_RESULT, Default::default()),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("first answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("second answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;
    let before = read_derived_forms(&file_path);
    assert!(before.iter().all(|f| f.state == DerivationState::Ready));

    let result = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m3".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };

    assert_eq!(
        value
            .dropped
            .iter()
            .map(clear_key_clear)
            .collect::<Vec<_>>(),
        ["message/m3/tool_result_summary"]
    );
    let mut cleared: Vec<_> = value.cleared.iter().map(clear_key_clear).collect();
    cleared.sort();
    let mut expected = vec![
        "turn/t1/detailed_turn_compression".to_string(),
        "turn/t1/pre_detailed_assembly".to_string(),
        "turn/t1/turn_rendering".to_string(),
        "chunk/c1/chunk_summary_brief".to_string(),
        "chunk/c1/chunk_summary_detailed".to_string(),
    ];
    expected.sort();
    assert_eq!(cleared, expected);
    let mut queued: Vec<_> = value
        .queued
        .iter()
        .map(|i| i.work_item_id.clone())
        .collect();
    queued.sort();
    assert_eq!(
        queued,
        [
            "w-c1-chunk_summary_brief-v2",
            "w-c1-chunk_summary_detailed-v2",
            "w-t1-detailed_turn_compression-v2",
            "w-t1-turn_derivation-v2",
        ]
    );

    let after = read_derived_forms(&file_path);
    assert!(!after.iter().any(|f| f.subject_id == "m3"));
    let cleared_set: std::collections::HashSet<_> =
        value.cleared.iter().map(clear_key_clear).collect();
    for form in after
        .iter()
        .filter(|f| cleared_set.contains(&clear_key_form(f)))
    {
        assert_eq!(form.state, DerivationState::Pending);
        assert_eq!(form.source_version, 2);
    }
    assert_eq!(
        after
            .iter()
            .filter(|f| !cleared_set.contains(&clear_key_form(f)))
            .cloned()
            .collect::<Vec<_>>(),
        before
            .iter()
            .filter(|f| !cleared_set.contains(&clear_key_form(f)) && f.subject_id != "m3")
            .cloned()
            .collect::<Vec<_>>()
    );

    let captured = double.capture_inputs();
    drain(&sdk, &file_path).await;
    assert!(
        read_derived_forms(&file_path)
            .iter()
            .all(|f| f.state == DerivationState::Ready)
    );
    assert!(
        captured
            .snapshot()
            .iter()
            .any(|c| c.op == InferenceCallbackOpName::CompressDetailedTurn)
    );
    let _ = WorkKind::ToolResultSummary;
    let _ = SubjectKind::Message;
}

#[tokio::test]
async fn deleting_a_turn_initiating_prompt_is_refused_naming_the_turn_nothing_changes() {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = tool_run_thread(&sdk, &store).await;
    let before = snapshot(&file_path).await;

    let result = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m1".into(),
        },
    )
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::MessageInitiatesTurn);
    assert!(error.reason.contains("t1"));
    assert!(error.reason.contains("whole turn is not supported"));
    assert_eq!(snapshot(&file_path).await, before);
}

#[tokio::test]
async fn open_turn_target_bogus_id_and_a_second_delete_of_the_same_id_refuse_with_stable_codes_the_record_is_identical_after_each()
 {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "closed prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("closed answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "open prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;
    let before = snapshot(&file_path).await;

    let open_turn = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m4".into(),
        },
    )
    .await;
    assert!(!open_turn.is_ok());
    let OpResult::Err { error } = open_turn else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::TurnOpen);
    assert_eq!(snapshot(&file_path).await, before);

    let missing = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m99".into(),
        },
    )
    .await;
    assert!(!missing.is_ok());
    let OpResult::Err { error } = missing else {
        return;
    };
    assert_eq!(error.code, ErrorCode::MessageNotFound);
    assert_eq!(snapshot(&file_path).await, before);

    let first_delete = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m2".into(),
        },
    )
    .await;
    assert!(first_delete.is_ok());
    let after_delete = snapshot(&file_path).await;
    let second_delete = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m2".into(),
        },
    )
    .await;
    assert!(!second_delete.is_ok());
    let OpResult::Err { error } = second_delete else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::MessageNotFound);
    assert_eq!(snapshot(&file_path).await, after_delete);
}

#[tokio::test]
async fn the_cascades_enqueue_pokes_ride_the_commit_the_minus_one_rebuild_runs_with_no_further_call()
 {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Background);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "the prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TOOL_CALL, Default::default()),
            valid_event(kind::TOOL_RESULT, Default::default()),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;
    assert!(
        read_derived_forms(&file_path)
            .iter()
            .all(|f| f.state == DerivationState::Ready)
    );

    let result = messages::remove(
        ThreadRef::file_path(&file_path),
        RemoveInput {
            message_id: "m3".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    let turn_forms: Vec<_> = read_derived_forms(&file_path)
        .into_iter()
        .filter(|f| f.subject_id == "t1")
        .collect();
    assert_eq!(turn_forms.len(), 3);
    assert!(
        turn_forms
            .iter()
            .all(|f| f.state == DerivationState::Ready && f.source_version == 2)
    );
    assert!(raw_detail(&file_path).is_empty());
    let _ = ToolCallOverrides::default();
    let _ = ToolResultOverrides::default();
}
