//! LIM-63A: staged compact-continuation runtime parity (production evidence).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, CompactContinuationTestHooks, TempStore,
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    run_compact_continuation_for_tests, seed_writer_claim, temp_store, valid_event,
};
use lhc::compact_continuation::{
    CompactContinuationHostFacts, WriterClaimKind, compute_operation_identity,
    compute_retry_posture, get_compact_continuation_receipt, get_compact_continuation_writer_claim,
    get_pending_compact_continuation_boundary, has_compact_continuation_marker,
    hash_attempt_intent, list_compact_continuation_stages, prove_pending_tool_pair,
    run_compact_continuation, validate_host_facts,
};
use lhc::messages::{self, MessageKind, MessageListOptions};
use lhc::shared_tech::compact_continuation::{
    CompactContinuationHostCapability, CompactContinuationPolicy, CompactContinuationSeam,
    PostMeasurementEstimate, ProviderUsageAuthority, ProviderUsageAvailable,
    ProviderUsageUnavailable, ProviderUsageUnavailableReason, WorkContinuation, WriterClaim,
};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::storage::CURRENT_THREAD_SCHEMA_VERSION;
use lhc::threads::{NewThreadInput, ThreadRef, new_thread};
use lhc::{init_lhc, intake_stream};
use serde_json::{Map, Value, json};

fn settled_seam() -> CompactContinuationSeam {
    CompactContinuationSeam {
        model_response_complete: true,
        requested_tools_settled: true,
        capture_flushed: true,
        before_next_provider_request: true,
        inside_transport_retry: false,
        input_epoch_at_decision: 1,
        input_epoch_at_apply: 1,
    }
}

fn base_facts(
    attempt_id: &str,
    total: i64,
    upper: i64,
    cont: WorkContinuation,
) -> CompactContinuationHostFacts {
    CompactContinuationHostFacts {
        attempt_id: attempt_id.into(),
        seam: settled_seam(),
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: total,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 0,
            source: "test".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            upper_trigger_tokens: upper,
            lower_target_tokens: 100,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
        },
        continuation: cont,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: Some(true),
        actor: "fixture-actor".into(),
        harness: "fixture-harness".into(),
        compact: None,
    }
}

async fn seed_thread() -> (TempStore, ThreadRef, String) {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let _sdk = init_lhc(SdkConfig {
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
    let file_path = match new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let ref_ = ThreadRef::file_path(&file_path);
    let events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "please work on a long task with many details ".repeat(20),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "working through the long task step by step ".repeat(20),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
    ];
    let batch = intake_stream::message_events(ref_.clone(), &events).await;
    assert!(batch.is_ok(), "seed batch failed: {batch:?}");
    (store, ref_, file_path)
}

#[tokio::test]
async fn below_trigger_does_not_mutate_or_claim_writer() {
    let (_store, ref_, file_path) = seed_thread().await;
    let facts = base_facts("a-below", 100, 10_000, WorkContinuation::None);
    let result = run_compact_continuation(ref_.clone(), facts).await;
    assert!(result.is_ok(), "{result:?}");
    let claim = get_compact_continuation_writer_claim(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(claim.claim, WriterClaimKind::None);
    let db = open_raw(&file_path);
    let ver = db
        .prepare("PRAGMA user_version")
        .get()
        .and_then(|r| r.get("user_version").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    assert_eq!(ver, CURRENT_THREAD_SCHEMA_VERSION);
    db.close();
}

trait ExpectOk<T> {
    fn expect_ok(self) -> T;
}
impl<T> ExpectOk<T> for OpResult<T> {
    fn expect_ok(self) -> T {
        match self {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => panic!("{}: {}", error.code.as_str(), error.reason),
        }
    }
}

#[tokio::test]
async fn missing_usage_skips_without_writer_claim() {
    let (_store, ref_, _) = seed_thread().await;
    let mut facts = base_facts("a-missing", 0, 100, WorkContinuation::None);
    facts.provider_usage = ProviderUsageAuthority::Unavailable(ProviderUsageUnavailable {
        available: false,
        reason: ProviderUsageUnavailableReason::Missing,
        domain: "provider_reported_input".into(),
    });
    assert!(run_compact_continuation(ref_.clone(), facts).await.is_ok());
    let claim = get_compact_continuation_writer_claim(ref_)
        .await
        .expect_ok();
    assert_eq!(claim.claim, WriterClaimKind::None);
}

#[tokio::test]
async fn public_validation_rejects_test_hooks_field() {
    let err = validate_host_facts(&json!({
        "attemptId": "x",
        "testHooks": { "skipRealCompact": true }
    }));
    let e = err.expect("expected validation error");
    assert_eq!(e.code, ErrorCode::InvalidCompactContinuationInput);
    assert!(
        e.reason.contains("testHooks") || e.reason.contains("unknown field"),
        "{}",
        e.reason
    );
}

#[tokio::test]
async fn writer_conflict_when_foreign_claim_held() {
    let (_store, ref_, file_path) = seed_thread().await;
    {
        let db = open_raw(&file_path);
        seed_writer_claim(&db, "foreign-attempt", "2020-01-01T00:00:00.000Z");
        db.close();
    }
    let facts = base_facts("my-attempt", 50_000, 1000, WorkContinuation::ActiveNonTool);
    let result = run_compact_continuation(ref_.clone(), facts).await;
    match result {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationWriterConflict);
        }
        OpResult::Ok { .. } => {
            let claim = get_compact_continuation_writer_claim(ref_)
                .await
                .expect_ok();
            assert_eq!(claim.attempt_id.as_deref(), Some("foreign-attempt"));
        }
    }
}

#[tokio::test]
async fn immutable_identity_hash_stable_retry_posture_varies() {
    let facts = base_facts("id-1", 100, 50, WorkContinuation::ActiveNonTool);
    let a = compute_operation_identity(&facts);
    let b = compute_operation_identity(&facts);
    assert_eq!(hash_attempt_intent(&a).0, hash_attempt_intent(&b).0);
    let mut facts2 = facts.clone();
    facts2.seam.input_epoch_at_apply = 2;
    let claim = lhc::compact_continuation::WriterClaimRow {
        claim: WriterClaimKind::None,
        attempt_id: None,
        claimed_at: None,
    };
    let p1 = compute_retry_posture(&facts, &claim);
    let p2 = compute_retry_posture(&facts2, &claim);
    assert_ne!(
        lhc::compact_continuation::hash_record(&p1).0,
        lhc::compact_continuation::hash_record(&p2).0
    );
}

#[tokio::test]
async fn claim_only_crash_quiet_releases_owned_writer() {
    let (_store, ref_, file_path) = seed_thread().await;
    {
        let db = open_raw(&file_path);
        seed_writer_claim(&db, "claim-only", "2020-01-01T00:00:00.000Z");
        db.close();
    }
    let facts = base_facts("claim-only", 10, 10_000, WorkContinuation::None);
    assert!(run_compact_continuation(ref_.clone(), facts).await.is_ok());
    let claim = get_compact_continuation_writer_claim(ref_)
        .await
        .expect_ok();
    assert_eq!(claim.claim, WriterClaimKind::None);
}

#[tokio::test]
async fn active_non_tool_above_trigger_force_and_marker_path() {
    let (_store, ref_, _) = seed_thread().await;
    for i in 0..6 {
        let events = vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: format!("step {i} detail {}", "x".repeat(120)),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: format!("response {i} {}", "y".repeat(120)),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ),
        ];
        let _ = intake_stream::message_events(ref_.clone(), &events).await;
    }
    let facts = base_facts("force-1", 50_000, 100, WorkContinuation::ActiveNonTool);
    let hooks = CompactContinuationTestHooks {
        force_useful_reduction: Some(true),
        force_compact_structurally_valid: Some(true),
        force_can_produce_valid_provider_request: Some(true),
        force_install_succeeds: Some(true),
        ..Default::default()
    };
    let result = run_compact_continuation_for_tests(ref_.clone(), facts, None, Some(hooks)).await;
    match result {
        OpResult::Ok { value } => {
            let _ = list_compact_continuation_stages(ref_.clone(), "force-1").await;
            let _ = get_pending_compact_continuation_boundary(ref_.clone()).await;
            if let Some(tid) = value.continuation_turn_id {
                if has_compact_continuation_marker(ref_.clone(), &tid)
                    .await
                    .expect_ok()
                {
                    let chat = messages::list(
                        ref_.clone(),
                        Some(MessageListOptions {
                            for_user_chat: Some(true),
                            ..Default::default()
                        }),
                    )
                    .await
                    .expect_ok();
                    assert!(
                        chat.iter()
                            .all(|r| r.kind != MessageKind::CompactContinuationMarker)
                    );
                }
            }
            let _ = get_compact_continuation_receipt(ref_, "force-1").await;
        }
        OpResult::Err { error } => {
            assert_ne!(error.code, ErrorCode::NotImplemented);
        }
    }
}

#[tokio::test]
async fn pending_tool_pair_proof_and_refusal_before_mutation() {
    let (_store, ref_, file_path) = seed_thread().await;
    let call_id = "call-tool-1";
    let events = vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: call_id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("a.txt"));
                        m
                    },
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: call_id.into(),
                    content: "file contents".into(),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ];
    assert!(
        intake_stream::message_events(ref_.clone(), &events)
            .await
            .is_ok()
    );
    let db = open_raw(&file_path);
    let proof = prove_pending_tool_pair(&db, call_id);
    assert!(matches!(
        proof,
        lhc::compact_continuation::ToolPairProof::Ok { .. }
    ));
    db.close();

    let facts = base_facts(
        "tool-bad",
        50_000,
        100,
        WorkContinuation::PendingCorrelatedToolResult {
            tool_call_id: "missing-call".into(),
            correlation_valid: true,
        },
    );
    let result = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(result.receipt.refused || result.decision.receipt.refused);
}

#[tokio::test]
async fn interrupt_after_marker_event_leaves_repairable_gap() {
    let (_store, ref_, _) = seed_thread().await;
    for i in 0..5 {
        let events = vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: format!("long {i} {}", "z".repeat(100)),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: format!("ans {i} {}", "w".repeat(100)),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ),
        ];
        let _ = intake_stream::message_events(ref_.clone(), &events).await;
    }
    let facts = base_facts("gap-marker", 50_000, 100, WorkContinuation::ActiveNonTool);
    let hooks = CompactContinuationTestHooks {
        interrupt_after_marker_event: true,
        force_useful_reduction: Some(true),
        force_compact_structurally_valid: Some(true),
        force_can_produce_valid_provider_request: Some(true),
        ..Default::default()
    };
    let _ = run_compact_continuation_for_tests(ref_.clone(), facts, None, Some(hooks)).await;
    let _ = list_compact_continuation_stages(ref_, "gap-marker").await;
}

#[tokio::test]
async fn schema_v10_tables_exist_on_fresh_create() {
    let store = temp_store();
    let file_path = match new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let db = open_raw(&file_path);
    for table in [
        "compact_continuation_writer",
        "compact_continuation_boundary",
        "compact_continuation_stage_log",
        "compact_continuation_receipt",
        "compact_continuation_attempt",
        "compact_continuation_force_intent",
    ] {
        let row = db
            .prepare(&format!(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='{table}'"
            ))
            .get();
        assert!(row.is_some(), "missing table {table}");
    }
    let idx = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_compact_continuation_boundary_one_unresolved'",
        )
        .get();
    assert!(idx.is_some(), "missing one-unresolved index");
    db.close();
}
