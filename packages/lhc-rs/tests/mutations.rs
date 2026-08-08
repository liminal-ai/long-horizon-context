//! Ported from packages/lhc/test/mutations.test.ts. Phase 1.
//!
//! Story 5 (Epic 02): messages.edit and the mutation cascade — Flow 5's edit
//! half.

mod fixtures;

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName, RuntimeNoteOverrides,
    RuntimeNotePayload, TempStore, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, kind, open_raw, read_derived_forms, temp_store, valid_event,
};
use lhc::messages::{
    Block, BlockType, EditInput, MessageRecord, MutationQueuedWork, MutationResult,
};
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Derivation, DerivationState, InferenceCallbacks, LeaseConfig, SdkConfig,
    SdkMode, SubjectKind,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::{QueueDetailRow, QueueLiveStatus, WorkKind, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, messages, set_scheduler_poke, set_thread_touch, threads};
use serde_json::{Map, json};

async fn new_thread(store: &TempStore) -> String {
    let created = threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
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
        guards: None,
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

fn clear_key_subject(subject_kind: SubjectKind, subject_id: &str, derivation_type: &str) -> String {
    format!(
        "{}/{}/{}",
        subject_kind.as_str(),
        subject_id,
        derivation_type
    )
}

fn clear_key_form(form: &Derivation) -> String {
    clear_key_subject(form.subject_kind, &form.subject_id, &form.derivation_type)
}

fn clear_key_clear(entry: &lhc::messages::internal::cascade::CascadeClear) -> String {
    clear_key_subject(
        entry.subject_kind,
        &entry.subject_id,
        &entry.derivation_type,
    )
}

fn unwrap_list(result: OpResult<Vec<MessageRecord>>) -> Vec<MessageRecord> {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok result, got {:?}", error.code),
    }
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    messages: Vec<MessageRecord>,
    derivations: Vec<Derivation>,
    queue: Vec<QueueDetailRow>,
}

async fn snapshot(file_path: &str) -> Snapshot {
    Snapshot {
        messages: unwrap_list(messages::list(ThreadRef::file_path(file_path), None).await),
        derivations: read_derived_forms(file_path),
        queue: raw_detail(file_path),
    }
}

async fn ready_turn_thread(sdk: &Lhc, store: &TempStore) -> String {
    let file_path = new_thread(store).await;
    send(
        sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "original prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("the original answer")),
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
async fn changes_the_record_in_the_edits_transaction_and_names_cleared_forms_and_queued_items() {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = ready_turn_thread(&sdk, &store).await;

    let result = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "edited prompt".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert_eq!(value.changed.message_ids, ["m1"]);
    assert!(value.changed.turn_ids.is_empty());
    assert!(value.dropped.is_empty());
    let mut cleared: Vec<_> = value.cleared.iter().map(clear_key_clear).collect();
    cleared.sort();
    let mut expected = vec![
        "message/m1/smoothed_prompt".to_string(),
        "turn/t1/detailed_turn_compression".to_string(),
        "turn/t1/pre_detailed_assembly".to_string(),
        "turn/t1/turn_rendering".to_string(),
    ];
    expected.sort();
    assert_eq!(cleared, expected);
    let mut queued = value.queued.clone();
    queued.sort_by(|a, b| a.work_item_id.cmp(&b.work_item_id));
    assert_eq!(
        queued,
        [
            MutationQueuedWork {
                work_item_id: "w-m1-prompt_smoothing-v2".into(),
                kind: WorkKind::PromptSmoothing,
            },
            MutationQueuedWork {
                work_item_id: "w-t1-detailed_turn_compression-v2".into(),
                kind: WorkKind::DetailedTurnCompression,
            },
            MutationQueuedWork {
                work_item_id: "w-t1-turn_derivation-v2".into(),
                kind: WorkKind::TurnDerivation,
            },
        ]
    );
    assert!(value.superseded.is_empty());

    let listed = unwrap_list(messages::list(ThreadRef::file_path(&file_path), None).await);
    let m1 = listed.iter().find(|r| r.message_id == "m1").expect("m1");
    let mut content = Map::new();
    content.insert("text".into(), json!("edited prompt"));
    assert_eq!(
        m1.blocks,
        [Block {
            block_type: BlockType::Text,
            content,
        }]
    );
    assert_eq!(m1.token_estimate, estimate_tokens("edited prompt"));

    drain(&sdk, &file_path).await;
    let smoothing = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt");
    let smoothing = smoothing.expect("smoothing");
    assert_eq!(smoothing.state, DerivationState::Ready);
    assert_eq!(
        smoothing.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": "edited prompt" }),
                "edited prompt"
            )
            .as_str()
        )
    );
}

#[tokio::test]
async fn induced_cascade_failure_rolls_back_the_content_change_too_atomicity_architecture_risk() {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = ready_turn_thread(&sdk, &store).await;

    let db = open_raw(&file_path);
    let source_ref = js_json_stringify(&json!({ "messageId": "m1" }));
    let payload = js_json_stringify(&json!({ "sourceVersion": 2, "derivations": [] }));
    db.prepare(
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES (?, 'messages', 'prompt_smoothing', ?, 'claimed', ?, ?)",
    )
    .run(&[
        SqlParam::from("w-m1-prompt_smoothing-v2"),
        SqlParam::from(source_ref.as_str()),
        SqlParam::from("2026-06-11T00:00:00.000Z"),
        SqlParam::from(payload.as_str()),
    ]);
    db.close();

    let before = snapshot(&file_path).await;
    let result = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "edited prompt".into(),
        },
    )
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.code, ErrorCode::StorageFailure);
    assert_eq!(snapshot(&file_path).await, before);
}

#[tokio::test]
async fn clears_exactly_the_edited_messages_chain_the_second_chunks_forms_are_byte_stable() {
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
    let mut keys: Vec<_> = before.iter().map(clear_key_form).collect();
    keys.sort();
    let mut expected = vec![
        "message/m1/smoothed_prompt",
        "message/m4/smoothed_prompt",
        "turn/t1/detailed_turn_compression",
        "turn/t1/pre_detailed_assembly",
        "turn/t1/turn_rendering",
        "turn/t2/detailed_turn_compression",
        "turn/t2/pre_detailed_assembly",
        "turn/t2/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
        "chunk/c2/chunk_summary_brief",
        "chunk/c2/chunk_summary_detailed",
    ];
    expected.sort();
    assert_eq!(keys, expected);
    assert!(before.iter().all(|f| f.state == DerivationState::Ready));

    let result = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "rewritten first prompt".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };

    let mut cleared: Vec<_> = value.cleared.iter().map(clear_key_clear).collect();
    cleared.sort();
    let mut expected_cleared = vec![
        "message/m1/smoothed_prompt".to_string(),
        "turn/t1/detailed_turn_compression".to_string(),
        "turn/t1/pre_detailed_assembly".to_string(),
        "turn/t1/turn_rendering".to_string(),
        "chunk/c1/chunk_summary_brief".to_string(),
        "chunk/c1/chunk_summary_detailed".to_string(),
    ];
    expected_cleared.sort();
    assert_eq!(cleared, expected_cleared);

    let cleared_set: std::collections::HashSet<_> =
        value.cleared.iter().map(clear_key_clear).collect();
    let after = read_derived_forms(&file_path);
    assert_eq!(
        after
            .iter()
            .filter(|f| !cleared_set.contains(&clear_key_form(f)))
            .cloned()
            .collect::<Vec<_>>(),
        before
            .iter()
            .filter(|f| !cleared_set.contains(&clear_key_form(f)))
            .cloned()
            .collect::<Vec<_>>()
    );
    for form in after
        .iter()
        .filter(|f| cleared_set.contains(&clear_key_form(f)))
    {
        assert_eq!(form.state, DerivationState::Pending);
        assert_eq!(form.source_version, 2);
        assert!(form.content.is_none());
    }
}

#[tokio::test]
async fn clears_to_pending_with_version_scoped_replacement_ids_and_a_second_edit_supersedes_the_still_queued_first_wave()
 {
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
                        text: "original prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("the answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;
    assert!(
        read_derived_forms(&file_path)
            .iter()
            .all(|f| f.state == DerivationState::Ready)
    );

    let first_wave_ids = [
        "w-c1-chunk_summary_brief-v2",
        "w-c1-chunk_summary_detailed-v2",
        "w-m1-prompt_smoothing-v2",
        "w-t1-detailed_turn_compression-v2",
        "w-t1-turn_derivation-v2",
    ];

    let first = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "first edit".into(),
        },
    )
    .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first_value } = first else {
        return;
    };
    assert!(first_value.superseded.is_empty());
    let mut queued_ids: Vec<_> = first_value
        .queued
        .iter()
        .map(|i| i.work_item_id.clone())
        .collect();
    queued_ids.sort();
    assert_eq!(queued_ids, first_wave_ids);
    let forms_after_first = read_derived_forms(&file_path);
    assert!(
        forms_after_first
            .iter()
            .all(|f| f.state == DerivationState::Pending)
    );
    assert!(forms_after_first.iter().all(|f| f.source_version == 2));
    let queue_after_first = raw_detail(&file_path);
    let mut qids: Vec<_> = queue_after_first
        .iter()
        .map(|r| r.work_item_id.clone())
        .collect();
    qids.sort();
    assert_eq!(qids, first_wave_ids);
    assert!(
        queue_after_first
            .iter()
            .all(|r| { r.status == QueueLiveStatus::Queued && r.source_version == 2 })
    );

    let second = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "second edit".into(),
        },
    )
    .await;
    assert!(second.is_ok());
    let OpResult::Ok {
        value: second_value,
    } = second
    else {
        return;
    };
    let mut superseded = second_value.superseded.clone();
    superseded.sort();
    assert_eq!(superseded, first_wave_ids);
    let queue_after_second = raw_detail(&file_path);
    let mut qids2: Vec<_> = queue_after_second
        .iter()
        .map(|r| r.work_item_id.clone())
        .collect();
    qids2.sort();
    assert_eq!(
        qids2,
        [
            "w-c1-chunk_summary_brief-v3",
            "w-c1-chunk_summary_detailed-v3",
            "w-m1-prompt_smoothing-v3",
            "w-t1-detailed_turn_compression-v3",
            "w-t1-turn_derivation-v3",
        ]
    );
    assert!(
        read_derived_forms(&file_path)
            .iter()
            .all(|f| f.state == DerivationState::Pending && f.source_version == 3)
    );

    drain(&sdk, &file_path).await;
    let smoothing = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt")
        .expect("smoothing");
    assert_eq!(smoothing.state, DerivationState::Ready);
    assert_eq!(
        smoothing.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": "second edit" }),
                "second edit"
            )
            .as_str()
        )
    );
}

#[tokio::test]
async fn a_claimed_pre_edit_item_completing_after_the_edit_discards_as_stale_discarded_the_post_edit_artifact_wins()
 {
    // TS it(..., 15000) — outer timeout covers the 5s polling window.
    let _hooks = HookGuard::acquire();
    tokio::time::timeout(Duration::from_secs(15), async {
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
                            text: "original prompt".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, Default::default()),
            ],
        )
        .await;

        double.delay_kind("prompt_smoothing", 400);
        let captured = double.capture_inputs();
        let drain_fut = sdk.work.drain(ThreadRef::file_path(&file_path), None);
        tokio::pin!(drain_fut);
        let start = Instant::now();
        loop {
            if captured
                .snapshot()
                .iter()
                .any(|c| c.op == InferenceCallbackOpName::SmoothPrompt)
            {
                break;
            }
            if start.elapsed() > Duration::from_millis(5000) {
                panic!(
                    "timed out waiting for the old-content smoothing to be claimed and in-handler"
                );
            }
            tokio::select! {
                biased;
                drained = &mut drain_fut => {
                    panic!("drain finished before smoothPrompt capture: {drained:?}");
                }
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }

        let edited = messages::edit(
            ThreadRef::file_path(&file_path),
            EditInput {
                message_id: "m1".into(),
                content: "edited prompt".into(),
            },
        )
        .await;
        assert!(edited.is_ok());
        let OpResult::Ok {
            value: edited_value,
        } = edited
        else {
            return;
        };
        assert_eq!(edited_value.superseded, ["w-t1-turn_derivation-v1"]);

        let mid = raw_detail(&file_path);
        assert_eq!(
            mid.iter()
                .map(|r| (r.work_item_id.as_str(), r.status))
                .collect::<Vec<_>>(),
            [
                ("w-m1-prompt_smoothing-v1", QueueLiveStatus::Claimed),
                ("w-m1-prompt_smoothing-v2", QueueLiveStatus::Queued),
                ("w-t1-turn_derivation-v2", QueueLiveStatus::Queued),
            ]
        );

        let drained = drain_fut.await;
        assert!(drained.is_ok());
        let OpResult::Ok {
            value: drained_value,
        } = drained
        else {
            return;
        };
        assert_eq!(
            drained_value
                .ran
                .iter()
                .map(|e| (e.work_item_id.as_str(), e.disposition))
                .collect::<Vec<_>>(),
            [
                ("w-m1-prompt_smoothing-v1", DrainDisposition::StaleDiscarded),
                ("w-m1-prompt_smoothing-v2", DrainDisposition::Done),
                ("w-t1-turn_derivation-v2", DrainDisposition::Done),
                ("w-t1-detailed_turn_compression-v2", DrainDisposition::Done),
            ]
        );

        let rows: Vec<_> = read_derived_forms(&file_path)
            .into_iter()
            .filter(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt")
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, DerivationState::Ready);
        assert_eq!(rows[0].source_version, 2);
        assert_eq!(
            rows[0].content.as_deref(),
            Some(
                deterministic_text(
                    DeterministicOpName::SmoothPrompt,
                    &json!({ "text": "edited prompt" }),
                    "edited prompt"
                )
                .as_str()
            )
        );
        assert!(raw_detail(&file_path).is_empty());
    })
    .await
    .expect("TC-5.4 timed out");
}

#[tokio::test]
async fn refuses_open_turn_missing_and_deleted_targets_read_back_identical_after_each() {
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
    let before = snapshot(&file_path).await;

    let open_turn = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m3".into(),
            content: "nope".into(),
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

    let missing = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m99".into(),
            content: "nope".into(),
        },
    )
    .await;
    assert!(!missing.is_ok());
    let OpResult::Err { error } = missing else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::MessageNotFound);
    assert_eq!(snapshot(&file_path).await, before);

    let db = open_raw(&file_path);
    db.prepare("UPDATE message SET deleted_at = ? WHERE message_id = 'm1'")
        .run(&[SqlParam::from("2026-06-11T00:00:00.000Z")]);
    db.close();
    let after_stamp = snapshot(&file_path).await;
    let deleted = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "nope".into(),
        },
    )
    .await;
    assert!(!deleted.is_ok());
    let OpResult::Err { error } = deleted else {
        return;
    };
    assert_eq!(error.code, ErrorCode::MessageNotFound);
    assert_eq!(snapshot(&file_path).await, after_stamp);
}

#[tokio::test]
async fn refuses_an_open_turn_target_under_the_closed_turn_boundary_read_back_unchanged() {
    let _hooks = HookGuard::acquire();
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), None, SdkMode::Manual);
    let file_path = new_thread(&store).await;
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::RUNTIME_NOTE,
            RuntimeNoteOverrides {
                payload: Some(RuntimeNotePayload {
                    text: "a note before any turn".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    let listed = unwrap_list(messages::list(ThreadRef::file_path(&file_path), None).await);
    let m1 = listed.iter().find(|r| r.message_id == "m1").expect("m1");
    assert_eq!(m1.turn_id, "t1");

    let before = snapshot(&file_path).await;
    let open_turn = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "nope".into(),
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
}

#[tokio::test]
async fn the_cascades_enqueue_pokes_ride_the_commit_rebuilds_run_with_no_further_call() {
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
                        text: "original prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("the answer")),
                    ..Default::default()
                },
            ),
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

    let result: OpResult<MutationResult> = messages::edit(
        ThreadRef::file_path(&file_path),
        EditInput {
            message_id: "m1".into(),
            content: "edited prompt".into(),
        },
    )
    .await;
    assert!(result.is_ok());
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    let smoothing = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt")
        .expect("smoothing");
    assert_eq!(smoothing.state, DerivationState::Ready);
    assert_eq!(smoothing.source_version, 2);
    assert_eq!(
        smoothing.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": "edited prompt" }),
                "edited prompt"
            )
            .as_str()
        )
    );
    assert!(raw_detail(&file_path).is_empty());
}
