//! Ported from packages/lhc/test/inspect-health.test.ts. Phase 1.
//!
//! Story 2 (Epic 04), default suite: TC-4.1–4.3 — the inspect health report.
//! 5 semantic tests.

mod fixtures;

use std::sync::Arc;

use fixtures::{
    PERMANENT_FAILURE_REASON, RATE_LIMIT_FAILURE_REASON, RuntimeNoteOverrides, RuntimeNotePayload,
    TempStore, create_inference_callbacks_double, expect_read_only, kind,
    mixed_state_variant_thread, mutation_in_flight_variant, temp_store, valid_event,
};
use lhc::messages::MessageReportOpts;
use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceResult, SdkConfig, SdkMode,
    SmoothPromptInput, SummarizeChunkBriefInput, SummarizeToolResultInput,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inspect::{
    HealthFailure, HealthOwner, HealthOwnerCounts, HealthOwnerEntry, HealthQueue,
    HealthRepairPreview, HealthReport,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::TurnReportOpts;
use lhc::{init_lhc, intake_stream, threads};

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

fn health_value(result: OpResult<HealthReport>) -> HealthReport {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => {
            panic!("expected ok health report: {:?}", error);
        }
    }
}

fn counts(ready: i64, pending: i64, failed: i64, blocked: i64) -> HealthOwnerCounts {
    HealthOwnerCounts {
        ready,
        pending,
        failed,
        blocked,
    }
}

async fn create_thread(store: &TempStore) -> String {
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    match threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { .. } => file_path,
        OpResult::Err { error } => {
            panic!("fixture thread creation failed: {}", error.reason)
        }
    }
}

fn refuse_callbacks() -> InferenceCallbacks {
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

#[tokio::test]
async fn the_mixed_state_fixture_reports_exact_counts_and_a_queue_section_consistent_with_them() {
    let ctx = setup();
    let fixture = mixed_state_variant_thread(&ctx.store).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;

    let health = expect_read_only(&file_path, || {
        sdk.inspect.health(ThreadRef::file_path(&file_path))
    })
    .await;
    assert!(health.is_ok());
    let OpResult::Ok { value: report } = health else {
        return;
    };

    assert_eq!(
        report.owners,
        vec![
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "smoothed_prompt".into(),
                counts: counts(13, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "tool_result_summary".into(),
                counts: counts(6, 0, 2, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_brief".into(),
                counts: counts(3, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_detailed".into(),
                counts: counts(3, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "detailed_turn_compression".into(),
                counts: counts(12, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "pre_detailed_assembly".into(),
                counts: counts(12, 0, 0, 1),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "turn_rendering".into(),
                counts: counts(12, 0, 0, 1),
            },
        ]
    );

    assert_eq!(
        report.queue,
        HealthQueue {
            queued: 1,
            claimed: 0
        }
    );
    let pending_total: i64 = report.owners.iter().map(|row| row.counts.pending).sum();
    assert_eq!(report.queue.queued + report.queue.claimed, pending_total);
}

#[tokio::test]
async fn failed_entries_carry_exact_detail_the_preview_is_exactly_the_failed_not_blocked_set() {
    let ctx = setup();
    let fixture = mixed_state_variant_thread(&ctx.store).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;
    let report = health_value(sdk.inspect.health(ThreadRef::file_path(&file_path)).await);

    let failed: Vec<_> = report
        .failures
        .iter()
        .filter(|e| e.reason.starts_with("rate_limit") || e.reason.starts_with("content_refusal"))
        .cloned()
        .collect();
    let transient = fixture
        .failed_transient_message_id
        .clone()
        .expect("fixture");
    let permanent = fixture
        .failed_permanent_message_id
        .clone()
        .expect("fixture");
    assert_eq!(
        failed,
        vec![
            HealthFailure {
                owner: "messages".into(),
                subject_kind: "message".into(),
                subject_id: transient.clone(),
                derivation_type: "tool_result_summary".into(),
                reason: RATE_LIMIT_FAILURE_REASON.into(),
            },
            HealthFailure {
                owner: "messages".into(),
                subject_kind: "message".into(),
                subject_id: permanent.clone(),
                derivation_type: "tool_result_summary".into(),
                reason: PERMANENT_FAILURE_REASON.into(),
            },
        ]
    );

    let blocked: Vec<_> = report
        .failures
        .iter()
        .filter(|e| !failed.contains(e))
        .cloned()
        .collect();
    assert_eq!(
        blocked
            .iter()
            .map(|e| (
                e.owner.as_str(),
                e.subject_kind.as_str(),
                e.subject_id.as_str(),
                e.derivation_type.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                "turns",
                "turn",
                fixture.blocked_turn_id.as_str(),
                "pre_detailed_assembly"
            ),
            (
                "turns",
                "turn",
                fixture.blocked_turn_id.as_str(),
                "turn_rendering"
            ),
        ]
    );
    for entry in &blocked {
        assert!(!entry.reason.is_empty());
    }

    assert_eq!(
        report.repair_preview,
        vec![
            HealthRepairPreview {
                owner: "messages".into(),
                subject_kind: "message".into(),
                subject_id: transient,
                derivation_type: "tool_result_summary".into(),
            },
            HealthRepairPreview {
                owner: "messages".into(),
                subject_kind: "message".into(),
                subject_id: permanent,
                derivation_type: "tool_result_summary".into(),
            },
        ]
    );

    let again = health_value(sdk.inspect.health(ThreadRef::file_path(&file_path)).await);
    assert_eq!(again, report);
}

#[tokio::test]
async fn reports_durable_capture_gap_runtime_note_markers_as_capture_health_failures() {
    let ctx = setup();
    let file_path = create_thread(&ctx.store).await;
    let gap_text = "capture gap: 1 event(s) rejected - payload mismatch";
    let gap = valid_event(
        kind::RUNTIME_NOTE,
        RuntimeNoteOverrides {
            idempotency_key: Some("gap-1".into()),
            actor: Some("system".into()),
            harness: Some("pi".into()),
            payload: Some(RuntimeNotePayload {
                text: gap_text.into(),
            }),
        },
    );
    let recorded = intake_stream::message_events(ThreadRef::file_path(&file_path), &[gap]).await;
    assert!(recorded.is_ok());

    let reader = init_lhc(SdkConfig {
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
    let report = health_value(
        expect_read_only(&file_path, || {
            reader.inspect.health(ThreadRef::file_path(&file_path))
        })
        .await,
    );
    assert!(report.owners.contains(&HealthOwnerEntry {
        owner: HealthOwner::Capture,
        kind: "capture_gap".into(),
        counts: counts(0, 0, 1, 0),
    }));
    assert!(report.failures.contains(&HealthFailure {
        owner: "capture".into(),
        subject_kind: "event".into(),
        subject_id: "1".into(),
        derivation_type: "capture_gap".into(),
        reason: gap_text.into(),
    }));
    assert_eq!(report.repair_preview, Vec::<HealthRepairPreview>::new());
}

#[tokio::test]
async fn after_an_edit_the_cascades_cleared_set_is_pending_with_queued_work_after_the_drain_the_same_set_is_ready_nothing_else_moved()
 {
    let ctx = setup();
    let fixture = mutation_in_flight_variant(&ctx.store).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;

    let mut cleared_keys: Vec<String> = fixture
        .mutation
        .cleared
        .iter()
        .map(|t| {
            format!(
                "{}:{}:{}",
                t.subject_kind.as_str(),
                t.subject_id,
                t.derivation_type
            )
        })
        .collect();
    cleared_keys.sort();
    let mut expected = vec![
        format!("message:{}:smoothed_prompt", fixture.edited_message_id),
        "turn:t2:turn_rendering".into(),
        "turn:t2:pre_detailed_assembly".into(),
        "turn:t2:detailed_turn_compression".into(),
        "chunk:c1:chunk_summary_detailed".into(),
        "chunk:c1:chunk_summary_brief".into(),
    ];
    expected.sort();
    assert_eq!(cleared_keys, expected);

    let before = health_value(
        expect_read_only(&file_path, || {
            sdk.inspect.health(ThreadRef::file_path(&file_path))
        })
        .await,
    );
    assert_eq!(
        before.owners,
        vec![
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "smoothed_prompt".into(),
                counts: counts(11, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "tool_result_summary".into(),
                counts: counts(8, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_brief".into(),
                counts: counts(2, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_detailed".into(),
                counts: counts(2, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "detailed_turn_compression".into(),
                counts: counts(11, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "pre_detailed_assembly".into(),
                counts: counts(11, 1, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "turn_rendering".into(),
                counts: counts(11, 1, 0, 0),
            },
        ]
    );
    assert_eq!(
        before.queue,
        HealthQueue {
            queued: 6,
            claimed: 0
        }
    );
    assert_eq!(before.failures, Vec::<HealthFailure>::new());
    assert_eq!(before.repair_preview, Vec::<HealthRepairPreview>::new());

    let messages_pending = sdk
        .messages
        .report(
            ThreadRef::file_path(&file_path),
            Some(MessageReportOpts {
                not_ready: Some(true),
                message_id: None,
            }),
        )
        .await;
    let turns_pending = sdk
        .turns
        .report(
            ThreadRef::file_path(&file_path),
            Some(&TurnReportOpts {
                not_ready: Some(true),
                turn_id: None,
                chunk_id: None,
            }),
        )
        .await;
    assert!(messages_pending.is_ok() && turns_pending.is_ok());
    let OpResult::Ok {
        value: messages_pending,
    } = messages_pending
    else {
        return;
    };
    let OpResult::Ok {
        value: turns_pending,
    } = turns_pending
    else {
        return;
    };
    let mut pending_keys: Vec<String> = messages_pending
        .iter()
        .chain(turns_pending.iter())
        .filter(|e| e.state.as_str() == "pending")
        .map(|e| {
            format!(
                "{}:{}:{}",
                e.subject_kind.as_str(),
                e.subject_id,
                e.derivation_type
            )
        })
        .collect();
    pending_keys.sort();
    assert_eq!(pending_keys, cleared_keys);

    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());
    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;

    let after = health_value(sdk.inspect.health(ThreadRef::file_path(&file_path)).await);
    assert_eq!(
        after.owners,
        vec![
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "smoothed_prompt".into(),
                counts: counts(12, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Messages,
                kind: "tool_result_summary".into(),
                counts: counts(8, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_brief".into(),
                counts: counts(3, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "chunk_summary_detailed".into(),
                counts: counts(3, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "detailed_turn_compression".into(),
                counts: counts(12, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "pre_detailed_assembly".into(),
                counts: counts(12, 0, 0, 0),
            },
            HealthOwnerEntry {
                owner: HealthOwner::Turns,
                kind: "turn_rendering".into(),
                counts: counts(12, 0, 0, 0),
            },
        ]
    );
    assert_eq!(
        after.queue,
        HealthQueue {
            queued: 0,
            claimed: 0
        }
    );
    assert_eq!(after.failures, Vec::<HealthFailure>::new());
}

#[tokio::test]
async fn health_succeeds_under_a_throwing_inference_callback_and_calls_no_model_on_the_fixture_sdk()
{
    let ctx = setup();
    let fixture = mixed_state_variant_thread(&ctx.store).await;
    let captured = fixture.double.capture_inputs();

    let reader = init_lhc(SdkConfig {
        inference_callbacks: Some(refuse_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let health = expect_read_only(&fixture.file_path, || {
        reader
            .inspect
            .health(ThreadRef::file_path(&fixture.file_path))
    })
    .await;
    assert!(health.is_ok());
    assert_eq!(captured.len(), 0);
}
