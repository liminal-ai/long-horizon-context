//! Ported from packages/lhc/test/report-repair.test.ts. Phase 1.
//!
//! Story 4 (Epic 02): derivation state, report, and repair — Flow 4.
//! 10 semantic tests.

mod fixtures;

use std::panic::AssertUnwindSafe;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, GAPPED_SMOOTHING_REASON, TempStore,
    UserPromptOverrides, UserPromptPayload, corrupt_two_open_turns,
    create_inference_callbacks_double, damaged_source_thread, gapped_rendering_thread, kind,
    open_raw, read_derived_forms, temp_store, valid_event,
};
use lhc::intake_stream::{BatchResult, MessageEventInput};
use lhc::messages::{MessageDeriveDerivationType, MessageDeriveResult, MessageReportOpts};
use lhc::sdk::DrainOpts;
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Clock, Derivation, DerivationReportEntry, DerivationState,
    InferenceCallbacks, LeaseConfig, SdkConfig, SdkMode, SubjectKind,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport, DrainStoppedBecause};
use lhc::shared_tech::work_queue::{QueueDetailRow, queue_detail};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{TurnDeriveResult, TurnReportOpts};
use lhc::{Lhc, count_live_items, init_lhc, set_scheduler_poke, set_thread_touch, threads};

/// TS `Partial<Pick<SdkConfig, "chunkPolicy" | "clock">>`.
#[derive(Default)]
struct ManualSdkOverrides {
    chunk_policy: Option<ChunkPolicyConfig>,
    clock: Option<Clock>,
}

/// Panic-safe global-seam + store cleanup (TS afterEach).
struct ReportRepairCleanup {
    store: TempStore,
}

impl Drop for ReportRepairCleanup {
    fn drop(&mut self) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_scheduler_poke(None);
        }));
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_thread_touch(None);
        }));
        self.store.cleanup();
    }
}

fn setup() -> ReportRepairCleanup {
    ReportRepairCleanup {
        store: temp_store(),
    }
}

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

fn manual_sdk(inference_callbacks: InferenceCallbacks, overrides: ManualSdkOverrides) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: overrides.clock,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: overrides.chunk_policy,
        view: None,
    })
}

async fn send(sdk: &Lhc, file_path: &str, batch: &[MessageEventInput]) -> BatchResult {
    match sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("batch failed: {}", error.reason),
    }
}

async fn drain(sdk: &Lhc, file_path: &str, opts: Option<DrainOpts>) -> DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), opts).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("drain failed: {}", error.reason),
    }
}

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn raw_detail(file_path: &str) -> Vec<QueueDetailRow> {
    let db = open_raw(file_path);
    let rows = queue_detail(&db);
    db.close();
    rows
}

fn entry_of<'a>(
    entries: &'a [DerivationReportEntry],
    subject_id: &str,
    derivation_type: &str,
) -> Option<&'a DerivationReportEntry> {
    entries
        .iter()
        .find(|e| e.subject_id == subject_id && e.derivation_type == derivation_type)
}

async fn report_of(
    sdk: &Lhc,
    file_path: &str,
    owner: &str,
    opts_messages: Option<MessageReportOpts>,
    opts_turns: Option<&TurnReportOpts>,
) -> Vec<DerivationReportEntry> {
    let result = if owner == "messages" {
        sdk.messages
            .report(ThreadRef::file_path(file_path), opts_messages)
            .await
    } else {
        sdk.turns
            .report(ThreadRef::file_path(file_path), opts_turns)
            .await
    };
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{owner} report failed: {}", error.reason),
    }
}

const MIXED_FAILED_REASON: &str = "provider_failure: scripted failure";

struct MixedStateThread {
    sdk: Lhc,
    file_path: String,
    drain_report: DrainReport,
}

async fn mixed_state_thread(store: &TempStore) -> MixedStateThread {
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let file_path = new_thread(store).await;
    double.fail_kind("prompt_smoothing", 1, Some(MIXED_FAILED_REASON));
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
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "third prompt, left open".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    corrupt_two_open_turns(&file_path);
    let drain_report = drain(&sdk, &file_path, Some(DrainOpts { max_items: Some(4) })).await;
    MixedStateThread {
        sdk,
        file_path,
        drain_report,
    }
}

// ── TC-4.1 ────────────────────────────────────────────────────────

#[tokio::test]
async fn ready_failed_via_attempt_pending_via_unprocessed_queue_and_blocked_via_damage_land_and_read_back_failed_carries_the_stable_reason()
 {
    let ctx = setup();
    let mixed = mixed_state_thread(&ctx.store).await;
    let sdk = &mixed.sdk;
    let file_path = &mixed.file_path;
    let drain_report = &mixed.drain_report;

    assert_eq!(
        drain_report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        vec![
            ("w-m1-prompt_smoothing-v1", DrainDisposition::FailedTerminal),
            ("w-t1-turn_derivation-v1", DrainDisposition::FailedTerminal),
            ("w-m3-prompt_smoothing-v1", DrainDisposition::Done),
            ("w-t2-turn_derivation-v1", DrainDisposition::FailedTerminal),
        ]
    );
    assert_eq!(drain_report.stopped_because, DrainStoppedBecause::MaxItems);
    assert_eq!(drain_report.remaining, 1);

    let message_entries = report_of(sdk, file_path, "messages", None, None).await;
    let turn_entries = report_of(sdk, file_path, "turns", None, None).await;

    let failed = entry_of(&message_entries, "m1", "smoothed_prompt");
    assert_eq!(failed.map(|e| e.state), Some(DerivationState::Failed));
    assert_eq!(
        failed.and_then(|e| e.reason.as_deref()),
        Some(MIXED_FAILED_REASON)
    );
    assert!(failed.and_then(|e| e.metadata.as_ref()).is_none());

    assert_eq!(
        entry_of(&message_entries, "m3", "smoothed_prompt").map(|e| e.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(
        entry_of(&message_entries, "m5", "smoothed_prompt").map(|e| e.state),
        Some(DerivationState::Pending)
    );
    let rendering = entry_of(&turn_entries, "t1", "turn_rendering");
    assert_eq!(rendering.map(|e| e.state), Some(DerivationState::Blocked));
    assert!(
        rendering
            .and_then(|e| e.reason.as_ref())
            .is_some_and(|r| r.contains("source_damaged"))
    );

    for entry in message_entries.iter().chain(turn_entries.iter()) {
        assert!(matches!(
            entry.state,
            DerivationState::Pending
                | DerivationState::Ready
                | DerivationState::Failed
                | DerivationState::Blocked
        ));
    }
}

// ── TC-4.3 ────────────────────────────────────────────────────────

#[tokio::test]
async fn each_owner_reports_only_its_own_forms_not_ready_returns_exactly_the_failed_pending_blocked_set()
 {
    let ctx = setup();
    let mixed = mixed_state_thread(&ctx.store).await;
    let sdk = &mixed.sdk;
    let file_path = &mixed.file_path;

    let message_entries = report_of(sdk, file_path, "messages", None, None).await;
    assert!(
        message_entries
            .iter()
            .all(|e| e.subject_kind == SubjectKind::Message)
    );
    assert_eq!(
        message_entries
            .iter()
            .map(|e| (e.subject_id.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![
            ("m1", DerivationState::Failed),
            ("m3", DerivationState::Ready),
            ("m5", DerivationState::Pending),
        ]
    );

    let turn_entries = report_of(sdk, file_path, "turns", None, None).await;
    assert!(
        turn_entries.iter().all(|e| {
            e.subject_kind == SubjectKind::Turn || e.subject_kind == SubjectKind::Chunk
        })
    );
    assert_eq!(
        turn_entries
            .iter()
            .map(|e| (e.subject_id.as_str(), e.derivation_type.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![
            ("t1", "pre_detailed_assembly", DerivationState::Blocked),
            ("t1", "turn_rendering", DerivationState::Blocked),
            ("t2", "pre_detailed_assembly", DerivationState::Blocked),
            ("t2", "turn_rendering", DerivationState::Blocked),
        ]
    );

    let not_ready_messages = report_of(
        sdk,
        file_path,
        "messages",
        Some(MessageReportOpts {
            not_ready: Some(true),
            message_id: None,
        }),
        None,
    )
    .await;
    assert_eq!(
        not_ready_messages
            .iter()
            .map(|e| (e.subject_id.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![
            ("m1", DerivationState::Failed),
            ("m5", DerivationState::Pending),
        ]
    );
    let not_ready_turns = report_of(
        sdk,
        file_path,
        "turns",
        None,
        Some(&TurnReportOpts {
            not_ready: Some(true),
            turn_id: None,
            chunk_id: None,
        }),
    )
    .await;
    assert_eq!(not_ready_turns.len(), 4);
    assert!(
        not_ready_turns
            .iter()
            .all(|e| e.state == DerivationState::Blocked)
    );

    let one_message = sdk
        .messages
        .report(
            ThreadRef::file_path(file_path),
            Some(MessageReportOpts {
                not_ready: None,
                message_id: Some("m1".into()),
            }),
        )
        .await;
    assert!(one_message.is_ok());
    if let OpResult::Ok { value } = one_message {
        assert_eq!(
            value
                .iter()
                .map(|e| e.subject_id.as_str())
                .collect::<Vec<_>>(),
            vec!["m1"]
        );
    }
    let one_turn = sdk
        .turns
        .report(
            ThreadRef::file_path(file_path),
            Some(&TurnReportOpts {
                not_ready: None,
                turn_id: Some("t2".into()),
                chunk_id: None,
            }),
        )
        .await;
    assert!(one_turn.is_ok());
    if let OpResult::Ok { value } = one_turn {
        assert_eq!(
            value
                .iter()
                .map(|e| e.subject_id.as_str())
                .collect::<Vec<_>>(),
            vec!["t2", "t2"]
        );
    }
}

#[tokio::test]
async fn chunk_summaries_report_under_the_turns_owner_never_under_messages() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        ManualSdkOverrides {
            chunk_policy: Some(ChunkPolicyConfig {
                target_projected_tokens: 1,
                max_projected_tokens: 1,
            }),
            ..Default::default()
        },
    );
    let file_path = new_thread(&ctx.store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "chunk one prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "chunk one answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;
    double.fail_kind(
        "chunk_summary_brief",
        1,
        Some("provider_failure: scripted brief failure"),
    );
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "chunk two prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "chunk two answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let turn_entries = report_of(&sdk, &file_path, "turns", None, None).await;
    let chunk_entries: Vec<_> = turn_entries
        .iter()
        .filter(|e| e.subject_kind == SubjectKind::Chunk)
        .collect();
    assert_eq!(
        chunk_entries
            .iter()
            .map(|e| (e.subject_id.as_str(), e.derivation_type.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![
            ("c1", "chunk_summary_brief", DerivationState::Ready),
            ("c1", "chunk_summary_detailed", DerivationState::Ready),
            ("c2", "chunk_summary_brief", DerivationState::Failed),
            ("c2", "chunk_summary_detailed", DerivationState::Ready),
        ]
    );

    let not_ready = report_of(
        &sdk,
        &file_path,
        "turns",
        None,
        Some(&TurnReportOpts {
            not_ready: Some(true),
            turn_id: None,
            chunk_id: None,
        }),
    )
    .await;
    assert_eq!(
        not_ready
            .iter()
            .map(|e| (e.subject_id.as_str(), e.derivation_type.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![("c2", "chunk_summary_brief", DerivationState::Failed)]
    );

    let message_entries = report_of(&sdk, &file_path, "messages", None, None).await;
    assert!(
        message_entries
            .iter()
            .all(|e| e.subject_kind == SubjectKind::Message)
    );
    assert!(
        !turn_entries
            .iter()
            .any(|e| e.subject_kind == SubjectKind::Message)
    );

    let one_chunk = sdk
        .turns
        .report(
            ThreadRef::file_path(&file_path),
            Some(&TurnReportOpts {
                not_ready: None,
                turn_id: None,
                chunk_id: Some("c2".into()),
            }),
        )
        .await;
    assert!(one_chunk.is_ok());
    if let OpResult::Ok { value } = one_chunk {
        assert_eq!(
            value
                .iter()
                .map(|e| (e.subject_id.as_str(), e.derivation_type.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("c2", "chunk_summary_brief"),
                ("c2", "chunk_summary_detailed"),
            ]
        );
    }
}

// ── TC-4.4 ────────────────────────────────────────────────────────

#[tokio::test]
async fn messages_derive_repairs_a_failed_smoothing_synchronously() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let gapped = gapped_rendering_thread(&ctx.store, &sdk, &double).await;
    let file_path = &gapped.file_path;
    let message_id = &gapped.message_id;

    assert_eq!(live_count(file_path), 0);
    let before = form_of(file_path, message_id, "smoothed_prompt");
    assert_eq!(
        before.as_ref().map(|f| f.state),
        Some(DerivationState::Failed)
    );
    assert_eq!(
        before.as_ref().and_then(|f| f.reason.as_deref()),
        Some(GAPPED_SMOOTHING_REASON)
    );

    let derived = sdk
        .messages
        .derive(ThreadRef::file_path(file_path), &[message_id.clone()])
        .await;
    assert!(derived.is_ok());
    let OpResult::Ok { value: derived } = derived else {
        return;
    };
    assert_eq!(
        derived,
        vec![MessageDeriveResult::Derived {
            message_id: message_id.clone(),
            derivation_type: MessageDeriveDerivationType::SmoothedPrompt,
            source_version: 2,
        }]
    );

    let repaired = form_of(file_path, message_id, "smoothed_prompt");
    assert_eq!(
        repaired.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(repaired.as_ref().map(|f| f.source_version), Some(2));
    assert!(
        repaired
            .as_ref()
            .and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains("smoothed("))
    );
    assert!(repaired.as_ref().and_then(|f| f.reason.as_ref()).is_none());
    let meta = repaired.as_ref().and_then(|f| f.metadata.as_ref());
    assert_eq!(meta.and_then(|m| m.inference_attempted), Some(true));
    assert_eq!(meta.and_then(|m| m.inference_succeeded), Some(true));
    assert_eq!(live_count(file_path), 0);

    let entries = report_of(&sdk, file_path, "messages", None, None).await;
    let entry = entry_of(&entries, message_id, "smoothed_prompt");
    assert_eq!(entry.map(|e| e.state), Some(DerivationState::Ready));
    assert_eq!(entry.map(|e| e.source_version), Some(2));
}

#[tokio::test]
async fn turns_derive_turn_rebuilds_a_fallback_composed_rendering_at_the_next_source_version() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let gapped = gapped_rendering_thread(&ctx.store, &sdk, &double).await;
    let file_path = &gapped.file_path;
    let message_id = &gapped.message_id;
    let turn_id = &gapped.turn_id;
    let before_repair = form_of(file_path, turn_id, "turn_rendering");

    let repair_smoothing = sdk
        .messages
        .derive(ThreadRef::file_path(file_path), &[message_id.clone()])
        .await;
    assert!(repair_smoothing.is_ok());
    assert_eq!(
        form_of(file_path, message_id, "smoothed_prompt").map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(form_of(file_path, turn_id, "turn_rendering"), before_repair);

    let rebuild = sdk
        .turns
        .derive_turn(ThreadRef::file_path(file_path), turn_id)
        .await;
    assert!(rebuild.is_ok());
    let OpResult::Ok { value: rebuild } = rebuild else {
        return;
    };
    assert_eq!(
        rebuild,
        TurnDeriveResult::Derived {
            turn_id: turn_id.clone(),
            source_version: 2,
        }
    );
    assert_eq!(live_count(file_path), 0);
    let rebuilt = form_of(file_path, turn_id, "turn_rendering");
    assert_eq!(
        rebuilt.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(rebuilt.as_ref().map(|f| f.source_version), Some(2));
    assert!(rebuilt.as_ref().and_then(|f| f.gaps.as_ref()).is_none());
    let compression = form_of(file_path, turn_id, "detailed_turn_compression");
    assert_eq!(
        compression.as_ref().map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(compression.as_ref().map(|f| f.source_version), Some(2));
}

// ── TC-4.5 ────────────────────────────────────────────────────────

#[tokio::test]
async fn derives_derivable_messages_and_reports_non_derivable_messages_without_queue_exposure() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let gapped = gapped_rendering_thread(&ctx.store, &sdk, &double).await;
    let file_path = &gapped.file_path;
    let message_id = &gapped.message_id;

    let derived = sdk
        .messages
        .derive(
            ThreadRef::file_path(file_path),
            &[message_id.clone(), "m2".into()],
        )
        .await;
    assert!(derived.is_ok());
    let OpResult::Ok { value: derived } = derived else {
        return;
    };
    assert_eq!(
        derived,
        vec![
            MessageDeriveResult::Derived {
                message_id: message_id.clone(),
                derivation_type: MessageDeriveDerivationType::SmoothedPrompt,
                source_version: 2,
            },
            MessageDeriveResult::NotDerivable {
                message_id: "m2".into(),
            },
        ]
    );
    assert_eq!(
        form_of(file_path, message_id, "smoothed_prompt").map(|f| f.state),
        Some(DerivationState::Ready)
    );
    assert_eq!(raw_detail(file_path), Vec::<QueueDetailRow>::new());
    let smoothings: Vec<_> = read_derived_forms(file_path)
        .into_iter()
        .filter(|form| form.subject_id == *message_id && form.derivation_type == "smoothed_prompt")
        .collect();
    assert_eq!(smoothings.len(), 1);
}

// ── TC-4.6 ────────────────────────────────────────────────────────

#[tokio::test]
async fn turns_derive_turn_lands_synchronous_source_damage_as_blocked_rather_than_failed() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let file_path = new_thread(&ctx.store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    corrupt_two_open_turns(&file_path);
    let result = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;
    assert!(result.is_ok());
    let OpResult::Ok { value: result } = result else {
        return;
    };
    match &result {
        TurnDeriveResult::Failed { turn_id, error } => {
            assert_eq!(turn_id, "t1");
            assert_eq!(error.code, ErrorCode::ProviderFailure);
            assert!(error.reason.contains("source_damaged"));
        }
        other => panic!("expected failed derive result, got {other:?}"),
    }

    let rendering = form_of(&file_path, "t1", "turn_rendering");
    assert_eq!(
        rendering.as_ref().map(|f| f.state),
        Some(DerivationState::Blocked)
    );
    assert_eq!(rendering.as_ref().map(|f| f.source_version), Some(2));
    assert!(
        rendering
            .as_ref()
            .and_then(|f| f.reason.as_ref())
            .is_some_and(|r| r.contains("source_damaged"))
    );
    let assembly = form_of(&file_path, "t1", "pre_detailed_assembly");
    assert_eq!(
        assembly.as_ref().map(|f| f.state),
        Some(DerivationState::Blocked)
    );
    assert_eq!(assembly.as_ref().map(|f| f.source_version), Some(2));
    assert!(
        assembly
            .as_ref()
            .and_then(|f| f.reason.as_ref())
            .is_some_and(|r| r.contains("source_damaged"))
    );
    assert_eq!(live_count(&file_path), 0);
}

#[tokio::test]
async fn a_turn_derivation_over_the_two_open_turns_corruption_blocks_naming_the_damage_blocked_is_not_failed_derive_is_refused()
 {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(double.to_callbacks(), ManualSdkOverrides::default());
    let damaged = damaged_source_thread(&ctx.store).await;
    let file_path = &damaged.file_path;
    let turn_id = &damaged.turn_id;

    let report = drain(&sdk, file_path, None).await;
    assert_eq!(
        report
            .ran
            .iter()
            .map(|e| (e.work_item_id.as_str(), e.disposition))
            .collect::<Vec<_>>(),
        vec![
            ("w-m1-prompt_smoothing-v1", DrainDisposition::Done),
            ("w-t1-turn_derivation-v1", DrainDisposition::FailedTerminal),
            ("w-m4-prompt_smoothing-v1", DrainDisposition::Done),
        ]
    );
    assert!(
        report
            .ran
            .get(1)
            .and_then(|e| e.reason.as_ref())
            .is_some_and(|r| r.contains("source_damaged"))
    );
    assert_eq!(live_count(file_path), 0);

    let rendering = form_of(file_path, turn_id, "turn_rendering");
    assert_eq!(
        rendering.as_ref().map(|f| f.state),
        Some(DerivationState::Blocked)
    );
    let reason = rendering.as_ref().and_then(|f| f.reason.clone());
    assert!(
        reason
            .as_ref()
            .is_some_and(|r| r.contains("source_damaged"))
    );
    assert!(reason.as_ref().is_some_and(|r| r.contains("open")));
    assert_eq!(
        form_of(file_path, turn_id, "pre_detailed_assembly").map(|f| f.state),
        Some(DerivationState::Blocked)
    );
    assert!(form_of(file_path, turn_id, "detailed_turn_compression").is_none());

    let not_ready = report_of(
        &sdk,
        file_path,
        "turns",
        None,
        Some(&TurnReportOpts {
            not_ready: Some(true),
            turn_id: None,
            chunk_id: None,
        }),
    )
    .await;
    assert_eq!(
        not_ready
            .iter()
            .map(|e| (e.subject_id.as_str(), e.derivation_type.as_str(), e.state))
            .collect::<Vec<_>>(),
        vec![
            ("t1", "pre_detailed_assembly", DerivationState::Blocked),
            ("t1", "turn_rendering", DerivationState::Blocked),
        ]
    );

    let refused = sdk
        .turns
        .derive_turn(ThreadRef::file_path(file_path), turn_id)
        .await;
    assert!(refused.is_ok());
    let OpResult::Ok { value: refused } = refused else {
        return;
    };
    assert_eq!(
        refused,
        TurnDeriveResult::Failed {
            turn_id: turn_id.clone(),
            error: ErrorResult {
                code: ErrorCode::SourceDamaged,
                error_class: ErrorClass::StateCorruption,
                reason: reason.clone().unwrap_or_default(),
                event_index: None,
            },
        }
    );

    assert_eq!(live_count(file_path), 0);
    assert_eq!(form_of(file_path, turn_id, "turn_rendering"), rendering);
}

// ── TC-4.7 ────────────────────────────────────────────────────────

#[tokio::test]
async fn with_every_non_ready_state_present_at_once_message_and_turn_reads_return_full_records_with_states_attached_and_zero_errors()
 {
    let ctx = setup();
    let mixed = mixed_state_thread(&ctx.store).await;
    let sdk = &mixed.sdk;
    let file_path = &mixed.file_path;

    let messages_read = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    assert!(messages_read.is_ok());
    let OpResult::Ok {
        value: messages_read,
    } = messages_read
    else {
        return;
    };
    assert_eq!(
        messages_read
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["m1", "m3", "m5"]
    );
    let form_states: std::collections::HashMap<_, _> = messages_read
        .iter()
        .map(|record| {
            (
                record.message_id.as_str(),
                record
                    .derivations
                    .as_ref()
                    .map(|forms| forms.iter().map(|f| f.state).collect::<Vec<_>>()),
            )
        })
        .collect();
    assert_eq!(
        form_states.get("m1").cloned().flatten(),
        Some(vec![DerivationState::Failed])
    );
    assert_eq!(
        form_states.get("m3").cloned().flatten(),
        Some(vec![DerivationState::Ready])
    );
    assert_eq!(
        form_states.get("m5").cloned().flatten(),
        Some(vec![DerivationState::Pending])
    );

    let turns_read = sdk.turns.list_turns(ThreadRef::file_path(file_path)).await;
    assert!(turns_read.is_ok());
    let OpResult::Ok { value: turns_read } = turns_read else {
        return;
    };
    assert_eq!(
        turns_read
            .iter()
            .map(|r| r.turn_id.as_str())
            .collect::<Vec<_>>(),
        vec!["t1", "t2", "t3", "t4"]
    );
    let first = &turns_read[0];
    assert_eq!(first.turn_id, "t1");
    assert_eq!(first.status, lhc::turns::TurnStatus::Closed);
    assert_eq!(first.member_message_ids, vec!["m1".to_string()]);

    let turn_form_states: std::collections::HashMap<_, _> = turns_read
        .iter()
        .map(|record| {
            (
                record.turn_id.as_str(),
                record.derivations.as_ref().map(|forms| {
                    forms
                        .iter()
                        .map(|f| (f.derivation_type.as_str(), f.state))
                        .collect::<Vec<_>>()
                }),
            )
        })
        .collect();
    assert_eq!(
        turn_form_states.get("t1").cloned().flatten(),
        Some(vec![
            ("pre_detailed_assembly", DerivationState::Blocked),
            ("turn_rendering", DerivationState::Blocked),
        ])
    );
    assert_eq!(
        turn_form_states.get("t2").cloned().flatten(),
        Some(vec![
            ("pre_detailed_assembly", DerivationState::Blocked),
            ("turn_rendering", DerivationState::Blocked),
        ])
    );
    assert!(turn_form_states.get("t3").cloned().flatten().is_none());
    assert!(turn_form_states.get("t4").cloned().flatten().is_none());

    let events_read = sdk
        .intake_stream
        .list_events(ThreadRef::file_path(file_path))
        .await;
    assert!(events_read.is_ok());
}

#[tokio::test]
async fn chunk_reads_return_records_with_summary_form_states_attached_including_non_ready_ones() {
    let ctx = setup();
    let double = create_inference_callbacks_double();
    let sdk = manual_sdk(
        double.to_callbacks(),
        ManualSdkOverrides {
            chunk_policy: Some(ChunkPolicyConfig {
                target_projected_tokens: 1,
                max_projected_tokens: 1,
            }),
            ..Default::default()
        },
    );
    let file_path = new_thread(&ctx.store).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "chunk read prompt one".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;
    double.fail_kind(
        "chunk_summary_brief",
        1,
        Some("provider_failure: scripted brief failure"),
    );
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "chunk read prompt two".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, Default::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path, None).await;

    let chunks_read = sdk
        .turns
        .list_chunks(ThreadRef::file_path(&file_path))
        .await;
    assert!(chunks_read.is_ok());
    let OpResult::Ok { value: chunks_read } = chunks_read else {
        return;
    };
    assert_eq!(
        chunks_read
            .iter()
            .map(|r| (r.chunk_id.as_str(), r.status))
            .collect::<Vec<_>>(),
        vec![
            ("c1", lhc::turns::TurnStatus::Closed),
            ("c2", lhc::turns::TurnStatus::Closed),
        ]
    );
    assert_eq!(chunks_read[0].member_turn_ids, vec!["t1".to_string()]);
    let chunk_form_states: Vec<_> = chunks_read
        .iter()
        .map(|record| {
            record.derivations.as_ref().map(|forms| {
                forms
                    .iter()
                    .map(|f| (f.derivation_type.as_str(), f.state))
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    assert_eq!(
        chunk_form_states,
        vec![
            Some(vec![
                ("chunk_summary_brief", DerivationState::Ready),
                ("chunk_summary_detailed", DerivationState::Ready),
            ]),
            Some(vec![
                ("chunk_summary_brief", DerivationState::Failed),
                ("chunk_summary_detailed", DerivationState::Ready),
            ]),
        ]
    );
    let failed_brief = chunks_read
        .get(1)
        .and_then(|r| r.derivations.as_ref())
        .and_then(|forms| {
            forms
                .iter()
                .find(|f| f.derivation_type == "chunk_summary_brief")
        });
    assert_eq!(
        failed_brief.and_then(|f| f.reason.as_deref()),
        Some("provider_failure: scripted brief failure")
    );
}
