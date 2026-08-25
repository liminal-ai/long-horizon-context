//! LIM-63A: staged compact-continuation runtime parity (production evidence).
//! Maps certified TS cases from compact-continuation-runtime.test.ts.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, CompactContinuationTestHooks,
    DerivedThreadOptions, TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double,
    derived_thread_fixture, kind, open_raw, run_compact_continuation_for_tests, seed_writer_claim,
    temp_store, valid_event,
};
use lhc::compact_continuation::{
    BoundaryStatus, CompactContinuationHostFacts, HostValidationStatus, WriterClaimKind,
    WriterOwnershipQuery, compute_operation_identity, compute_retry_posture,
    get_compact_continuation_attempt_intent, get_compact_continuation_host_validation,
    get_compact_continuation_receipt, get_compact_continuation_writer_claim,
    get_pending_compact_continuation_boundary, has_compact_continuation_marker,
    hash_attempt_intent, list_compact_continuation_stages, prove_pending_tool_pair,
    record_compact_continuation_host_validation, run_compact_continuation,
    run_compact_continuation_with_ownership, validate_host_facts,
};
use lhc::messages::{self, MessageKind, MessageListOptions};
use lhc::shared_tech::compact_continuation::{
    CONTEXT_COMPACT_CONTINUE_REASON, CompactContinuationEffect, CompactContinuationEffectType,
    CompactContinuationHostCapability, CompactContinuationOutcomeKind, CompactContinuationPolicy,
    CompactContinuationReliefPath, CompactContinuationSeam, PostMeasurementEstimate,
    ProviderUsageAuthority, ProviderUsageAvailable, ProviderUsageUnavailable,
    ProviderUsageUnavailableReason, ReclaimHostAuthority, ReclaimPriorClaim, WorkContinuation,
    WriterClaim, compact_continuation_marker_idempotency_key,
};
use lhc::shared_tech::derivation::{Clock, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::storage::{CURRENT_THREAD_SCHEMA_VERSION, SqlParam};
use lhc::shared_tech::view::{PartialViewProfilePercentages, ViewCompactParams};
use lhc::thread_view::{self, CompactOpts, InstallPreparedOptions};
use lhc::threads::{self, NewThreadInput, ThreadRef, new_thread};
use lhc::turns;
use lhc::{init_lhc, intake_stream};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

// ── helpers ───────────────────────────────────────────────────────────────

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

fn default_compact_opts() -> lhc::compact_continuation::HostCompactOpts {
    lhc::compact_continuation::HostCompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(400.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(25.0),
                smooth: Some(25.0),
                detailed: Some(25.0),
                brief: Some(25.0),
            }),
            newest_closed_protection: None,
        }),
    }
}

fn base_facts(attempt_id: &str, cont: WorkContinuation) -> CompactContinuationHostFacts {
    CompactContinuationHostFacts {
        attempt_id: attempt_id.into(),
        seam: settled_seam(),
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: 90_000,
            cache_creation_tokens: 5_000,
            cache_read_tokens: 10_000,
            total: 105_000,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 2_000,
            source: "lhc_token_estimate".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            safe_runway_threshold_tokens: Some(200_000),
            safe_runway_threshold_source: Some("host_safe_runway".into()),
            upper_trigger_tokens: 100_000,
            lower_target_tokens: 400,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
            compact_retry_budget: None,
        },
        continuation: cont,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: None,
        actor: "fixture-actor".into(),
        harness: "fixture-harness".into(),
        compact: Some(default_compact_opts()),
    }
}

fn below_usage_facts(attempt_id: &str) -> CompactContinuationHostFacts {
    let mut f = base_facts(attempt_id, WorkContinuation::ActiveNonTool);
    f.provider_usage = ProviderUsageAuthority::Available(ProviderUsageAvailable {
        available: true,
        input_tokens: 1_000,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total: 1_000,
        domain: "provider_reported_input".into(),
    });
    f.post_measurement_estimate = PostMeasurementEstimate {
        tokens: 0,
        source: "lhc_token_estimate".into(),
        domain: "source_labelled_estimate".into(),
    };
    f
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalSnap {
    event_count: i64,
    turn_count: i64,
    marker_count: i64,
    view_id: Option<String>,
    max_event_order: i64,
}

fn snapshot_canonical(file_path: &str) -> CanonicalSnap {
    let db = open_raw(file_path);
    let event_count = db
        .prepare("SELECT COUNT(*) AS n FROM event")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let turn_count = db
        .prepare("SELECT COUNT(*) AS n FROM turns")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let marker_count = db
        .prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'compact_continuation_marker'")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let view_id = db
        .prepare("SELECT view_id FROM thread_view WHERE singleton = 1")
        .get()
        .and_then(|r| {
            r.get("view_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let max_event_order = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    CanonicalSnap {
        event_count,
        turn_count,
        marker_count,
        view_id,
        max_event_order,
    }
}

fn writer_claim_of(file_path: &str) -> (WriterClaimKind, Option<String>) {
    let db = open_raw(file_path);
    let row = db
        .prepare("SELECT claim, attempt_id FROM compact_continuation_writer WHERE singleton = 1")
        .get()
        .expect("writer singleton");
    let claim = match row.get("claim").and_then(|v| v.as_str()) {
        Some("lhc") => WriterClaimKind::Lhc,
        _ => WriterClaimKind::None,
    };
    let attempt_id = row
        .get("attempt_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    db.close();
    (claim, attempt_id)
}

fn seed_held_writer(file_path: &str, attempt_id: &str) {
    let db = open_raw(file_path);
    seed_writer_claim(&db, attempt_id, "2020-01-01T00:00:00.000Z");
    db.close();
}

async fn seed_open_agentic_turn(ref_: &ThreadRef) {
    let events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "continue the investigation with more context".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "working on it with more detail ".repeat(20),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "call-active-1".into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("x.txt"));
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
                    tool_call_id: "call-active-1".into(),
                    content: "result body ".repeat(30),
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
}

async fn seed_pending_tool_turn(ref_: &ThreadRef, tool_call_id: &str) {
    let events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "use tools".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "calling tool".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("notes.txt"));
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
                    tool_call_id: tool_call_id.into(),
                    content: "tool result verbatim payload that must survive".into(),
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
}

async fn fixture_thread() -> (TempStore, ThreadRef, String) {
    let store = temp_store();
    let f = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let ref_ = ThreadRef::file_path(&f.file_path);
    let path = f.file_path.clone();
    (store, ref_, path)
}

fn has_effect(
    receipt: &lhc::shared_tech::compact_continuation::CompactContinuationReceipt,
    ty: CompactContinuationEffectType,
) -> bool {
    receipt.effects.iter().any(|e| e.effect_type() == ty)
}

/// Ordered receipt warning codes — the CX-S5 read-out for a degraded seam.
fn warning_codes(
    receipt: &lhc::shared_tech::compact_continuation::CompactContinuationReceipt,
) -> Vec<&'static str> {
    receipt.warnings.iter().map(|w| w.code.as_str()).collect()
}

fn success_outcomes(o: CompactContinuationOutcomeKind) -> bool {
    matches!(
        o,
        CompactContinuationOutcomeKind::CompactContinueTurn
            | CompactContinuationOutcomeKind::DegradedCompact
            | CompactContinuationOutcomeKind::NoReduction
    )
}

fn preserve_outcomes(o: CompactContinuationOutcomeKind) -> bool {
    matches!(
        o,
        CompactContinuationOutcomeKind::CompactPreserveTool
            | CompactContinuationOutcomeKind::DegradedCompact
            | CompactContinuationOutcomeKind::NoReduction
    )
}

fn compact_params() -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(400.0),
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
    }
}

// ── tests ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn compact_continuation_persists_canonical_fixed_clock_timestamps() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let fixed_time = UNIX_EPOCH + Duration::from_secs(1_709_251_199) + Duration::from_millis(123);
    let clock: Clock = Arc::new(move || fixed_time);
    let expected = "2024-02-29T23:59:59.123Z";

    run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("timestamp-1", WorkContinuation::ActiveNonTool),
        Some(clock.clone()),
        /*hooks*/ None,
    )
    .await
    .expect_ok();
    record_compact_continuation_host_validation(
        ref_,
        "timestamp-1",
        HostValidationStatus::Ok,
        /*reason*/ None,
        Some(clock),
    )
    .await
    .expect_ok();

    let db = open_raw(&path);
    let summary = db
        .prepare(
            "SELECT a.created_at, r.recorded_at, b.forced_at, b.completed_at, \
                    h.recorded_at AS host_recorded_at, h.updated_at AS host_updated_at \
             FROM compact_continuation_attempt a \
             JOIN compact_continuation_receipt r USING (attempt_id) \
             JOIN compact_continuation_boundary b USING (attempt_id) \
             JOIN compact_continuation_host_validation h USING (attempt_id) \
             WHERE a.attempt_id = ?",
        )
        .get_params(&[SqlParam::from("timestamp-1")])
        .expect("timestamp persistence rows");
    assert_eq!(
        summary.get("created_at").and_then(Value::as_str),
        Some(expected)
    );
    assert_eq!(
        summary.get("recorded_at").and_then(Value::as_str),
        Some(expected)
    );
    assert_eq!(
        summary.get("forced_at").and_then(Value::as_str),
        Some(expected)
    );
    assert_eq!(
        summary.get("completed_at").and_then(Value::as_str),
        Some(expected)
    );
    assert_eq!(
        summary.get("host_recorded_at").and_then(Value::as_str),
        Some(expected)
    );
    assert_eq!(
        summary.get("host_updated_at").and_then(Value::as_str),
        Some(expected)
    );
    let stages = db
        .prepare("SELECT recorded_at FROM compact_continuation_stage_log WHERE attempt_id = ?")
        .all(&[SqlParam::from("timestamp-1")]);
    assert!(!stages.is_empty(), "stage log must be durable");
    assert!(
        stages
            .iter()
            .all(|row| { row.get("recorded_at").and_then(Value::as_str) == Some(expected) })
    );
    db.close();
}

#[tokio::test]
async fn below_trigger_and_missing_usage_no_mutation() {
    let (_store, ref_, path) = fixture_thread().await;
    let before = snapshot_canonical(&path);

    let below = run_compact_continuation(ref_.clone(), below_usage_facts("below-1"))
        .await
        .expect_ok();
    assert_eq!(
        below.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueNormal
    );
    assert!(!has_effect(
        &below.receipt,
        CompactContinuationEffectType::ClaimWriter
    ));
    assert_eq!(snapshot_canonical(&path), before);

    let mut missing = base_facts("no-usage-1", WorkContinuation::ActiveNonTool);
    missing.provider_usage = ProviderUsageAuthority::Unavailable(ProviderUsageUnavailable {
        available: false,
        reason: ProviderUsageUnavailableReason::Missing,
        domain: "provider_reported_input".into(),
    });
    let no_usage = run_compact_continuation(ref_.clone(), missing)
        .await
        .expect_ok();
    assert_eq!(
        no_usage.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueNormal
    );
    assert_eq!(snapshot_canonical(&path), before);
}

#[tokio::test]
async fn normal_completion_creates_no_continuation_turn() {
    let (_store, ref_, path) = fixture_thread().await;
    let before = snapshot_canonical(&path);
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("complete-1", WorkContinuation::None),
    )
    .await
    .expect_ok();
    assert_eq!(
        result.receipt.outcome,
        CompactContinuationOutcomeKind::NormalComplete
    );
    assert!(!result.forced_boundary_this_attempt);
    assert_eq!(snapshot_canonical(&path).turn_count, before.turn_count);
}

#[tokio::test]
async fn b1_health_facts_warn_and_still_compact() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let _ = thread_view::compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let before = snapshot_canonical(&path);

    // Incomplete capture: warn + continue. Capture feeds derivation quality,
    // not compact capability, so the seam still forces, markers and installs.
    let mut capture = base_facts("health-capture", WorkContinuation::ActiveNonTool);
    capture.capture_complete = false;
    let cap = run_compact_continuation(ref_.clone(), capture)
        .await
        .expect_ok();
    assert!(!cap.receipt.refused);
    assert_eq!(cap.receipt.refuse_code, None);
    assert_eq!(warning_codes(&cap.receipt), vec!["capture_incomplete"]);
    assert!(has_effect(
        &cap.receipt,
        CompactContinuationEffectType::ClaimWriter
    ));
    assert!(has_effect(
        &cap.receipt,
        CompactContinuationEffectType::InstallServingView
    ));
    assert!(cap.receipt.residual.marker_persisted);
    assert!(cap.receipt.residual.marker_served);
    assert!(cap.receipt.residual.next_provider_request_allowed);
    let after_capture = snapshot_canonical(&path);
    assert_eq!(after_capture.turn_count, before.turn_count + 1);
    assert_eq!(after_capture.marker_count, before.marker_count + 1);
    assert_ne!(after_capture.view_id, before.view_id);

    // Unproven provider identity: omit signed reasoning, compact anyway.
    seed_open_agentic_turn(&ref_).await;
    let before_identity = snapshot_canonical(&path);
    let mut identity = base_facts("health-identity", WorkContinuation::ActiveNonTool);
    identity.provider_identity_valid = false;
    let id = run_compact_continuation(ref_.clone(), identity)
        .await
        .expect_ok();
    assert_eq!(id.receipt.refuse_code, None);
    assert_eq!(
        warning_codes(&id.receipt),
        vec!["provider_identity_unproven"]
    );
    assert!(has_effect(
        &id.receipt,
        CompactContinuationEffectType::OmitSignedReasoning
    ));
    assert!(has_effect(
        &id.receipt,
        CompactContinuationEffectType::InstallServingView
    ));
    let after_identity = snapshot_canonical(&path);
    assert_eq!(
        after_identity.marker_count,
        before_identity.marker_count + 1
    );
    assert_ne!(after_identity.view_id, before_identity.view_id);

    // Invalid tool correlation (host + durable) on preserve path: the pair
    // cannot be protected through compact, so the continuation machinery
    // declines into the host's ordinary settled-seam compact. No mutation here,
    // but the next provider request is authorized — declining is not a stop.
    seed_pending_tool_turn(&ref_, "call-bad-corr").await;
    let before_tool = snapshot_canonical(&path);
    let corr = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "health-corr",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["call-bad-corr".into()],
                correlation_valid: false,
            },
        ),
    )
    .await
    .expect_ok();
    assert_eq!(corr.receipt.refuse_code, None);
    assert_eq!(
        corr.receipt.outcome,
        CompactContinuationOutcomeKind::DeclineToOrdinaryCompact
    );
    assert_eq!(
        warning_codes(&corr.receipt),
        vec!["tool_correlation_unproven"]
    );
    assert!(corr.receipt.residual.prior_serving_view_intact);
    assert!(corr.receipt.residual.original_agentic_turn_still_open);
    assert!(corr.receipt.residual.next_provider_request_allowed);
    assert!(corr.next_provider_request_allowed);
    assert_eq!(snapshot_canonical(&path), before_tool);

    // Durable pair missing despite host correlationValid: same decline.
    let missing = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "health-pair-missing",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["call-does-not-exist".into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    assert_eq!(missing.receipt.refuse_code, None);
    assert_eq!(
        missing.receipt.outcome,
        CompactContinuationOutcomeKind::DeclineToOrdinaryCompact
    );
    assert_eq!(
        warning_codes(&missing.receipt),
        vec!["tool_correlation_unproven"]
    );
    assert!(missing.receipt.residual.next_provider_request_allowed);
    assert_eq!(snapshot_canonical(&path), before_tool);
}

#[tokio::test]
async fn active_non_tool_success_one_boundary_hidden_marker_install() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("active-success-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(
        success_outcomes(result.receipt.outcome),
        "{:?}",
        result.receipt.outcome
    );
    assert!(result.forced_boundary_this_attempt);
    let c_turn = result.continuation_turn_id.clone().expect("turn id");
    assert!(c_turn.starts_with('t'));
    assert!(result.marker_persisted);
    assert!(result.pending_boundary.is_none());

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
            .all(|m| m.kind != MessageKind::CompactContinuationMarker)
    );

    let all = messages::list(ref_.clone(), None).await.expect_ok();
    assert_eq!(
        all.iter()
            .filter(|m| m.kind == MessageKind::CompactContinuationMarker)
            .count(),
        1
    );

    let ctx = thread_view::get_llm_request_context(ref_.clone())
        .await
        .expect_ok();
    let joined: String = ctx
        .messages
        .iter()
        .flat_map(|m| m.content.iter().map(|c| c.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("[compact continuation]"), "{joined}");
    assert!(joined.contains(&format!("continuationTurnId={c_turn}")));

    let session = thread_view::get_session_thread_view(ref_.clone())
        .await
        .expect_ok();
    let session_text = format!("{:?}", session.entries);
    assert!(session_text.contains("[compact continuation]"));
    let _ = path;
}

#[tokio::test]
async fn b2_completed_boundary_not_repaired_on_below_trigger() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("complete-boundary-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(first.pending_boundary.is_none());
    let view_after = snapshot_canonical(&path);

    let below =
        run_compact_continuation(ref_.clone(), below_usage_facts("complete-boundary-below"))
            .await
            .expect_ok();
    assert_eq!(
        below.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueNormal
    );
    assert!(!below.forced_boundary_this_attempt);
    assert_eq!(snapshot_canonical(&path), view_after);
}

#[tokio::test]
async fn b2_completed_attempt_id_replays_without_remutation() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("replay-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let after = snapshot_canonical(&path);

    let second = run_compact_continuation(
        ref_.clone(),
        base_facts("replay-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(second.replayed_terminal_attempt);
    assert_eq!(second.receipt.outcome, first.receipt.outcome);
    assert_eq!(snapshot_canonical(&path), after);
}

#[tokio::test]
async fn later_above_trigger_creates_distinct_new_boundary() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("distinct-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let t_a = first.continuation_turn_id.expect("turn");

    seed_open_agentic_turn(&ref_).await;
    let second = run_compact_continuation(
        ref_.clone(),
        base_facts("distinct-2", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(second.forced_boundary_this_attempt);
    assert_ne!(second.continuation_turn_id.as_deref(), Some(t_a.as_str()));
}

#[tokio::test]
async fn tool_result_branch_preserves_pair_no_marker() {
    let (_store, ref_, _) = fixture_thread().await;
    let tool_call_id = "call-preserve-1";
    seed_pending_tool_turn(&ref_, tool_call_id).await;

    let result = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "tool-success-1",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec![tool_call_id.into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    assert!(
        preserve_outcomes(result.receipt.outcome),
        "{:?}",
        result.receipt.outcome
    );
    assert!(!result.forced_boundary_this_attempt);
    assert!(!has_effect(
        &result.receipt,
        CompactContinuationEffectType::InsertContinuationMarker
    ));

    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let pair: Vec<_> = listed
        .iter()
        .filter(|m| {
            (m.kind == MessageKind::ToolCall || m.kind == MessageKind::ToolResult)
                && m.blocks.iter().any(|b| {
                    b.content.get("toolCallId").and_then(|v| v.as_str()) == Some(tool_call_id)
                })
        })
        .collect();
    assert_eq!(pair.len(), 2);
    let result_msg = pair
        .iter()
        .find(|m| m.kind == MessageKind::ToolResult)
        .unwrap();
    assert_eq!(
        result_msg.blocks[0]
            .content
            .get("content")
            .and_then(|v| v.as_str()),
        Some("tool result verbatim payload that must survive")
    );
}

#[tokio::test]
async fn m8_durable_tool_pair_proof_rejects_orphaned() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_pending_tool_turn(&ref_, "call-ok").await;

    let db = open_raw(&path);
    assert!(matches!(
        prove_pending_tool_pair(&db, "call-ok"),
        lhc::compact_continuation::ToolPairProof::Ok { .. }
    ));
    match prove_pending_tool_pair(&db, "call-missing") {
        lhc::compact_continuation::ToolPairProof::Err { reason, .. } => {
            assert_eq!(reason.as_str(), "call_missing");
        }
        _ => panic!("expected missing"),
    }
    db.prepare(
        r#"UPDATE message SET deleted_at = ? WHERE message_id IN (
             SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE b.block_type = 'tool_result' AND json_extract(b.content, '$.toolCallId') = 'call-ok'
           )"#,
    )
    .run(&[SqlParam::from("2020-01-01T00:00:00.000Z")]);
    match prove_pending_tool_pair(&db, "call-ok") {
        lhc::compact_continuation::ToolPairProof::Err { reason, .. } => {
            assert_eq!(reason.as_str(), "orphaned_call");
        }
        _ => panic!("expected orphaned_call"),
    }
    db.close();
}

#[tokio::test]
async fn repair_after_boundary_idempotent() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("repair-boundary-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert!(interrupted.forced_boundary_this_attempt);
    let c_turn = interrupted.continuation_turn_id.clone().expect("turn");
    assert_eq!(
        interrupted.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::Pending)
    );
    assert!(!interrupted.replayed_terminal_attempt);

    let mut facts = base_facts("repair-boundary-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let repaired = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!repaired.forced_boundary_this_attempt);
    assert_eq!(
        repaired.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(!repaired.replayed_terminal_attempt);

    let turns = turns::list_turns(ref_.clone()).await.expect_ok();
    assert_eq!(
        turns
            .iter()
            .filter(|t| t.outcome_reason.as_deref() == Some(CONTEXT_COMPACT_CONTINUE_REASON))
            .count(),
        1
    );
}

#[tokio::test]
async fn repair_after_marker_idempotent() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("repair-marker-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_marker: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let c_turn = interrupted.continuation_turn_id.clone().expect("turn");
    assert!(interrupted.receipt.residual.marker_persisted);
    assert!(
        interrupted
            .pending_boundary
            .as_ref()
            .map(|b| b.marker_persisted)
            .unwrap_or(false)
    );

    let mut facts = base_facts("repair-marker-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let repaired = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!repaired.forced_boundary_this_attempt);
    assert!(!repaired.replayed_terminal_attempt);

    let events = intake_stream::list_events(ref_.clone()).await.expect_ok();
    let key = compact_continuation_marker_idempotency_key(&c_turn);
    assert_eq!(
        events.iter().filter(|e| e.idempotency_key() == key).count(),
        1
    );
}

#[tokio::test]
async fn b3_m6_crash_held_writer_pending_resumes_same_attempt() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("crash-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let c_turn = interrupted.continuation_turn_id.clone().expect("turn");

    let claim = get_compact_continuation_writer_claim(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(claim.claim, WriterClaimKind::Lhc);
    assert_eq!(claim.attempt_id.as_deref(), Some("crash-1"));

    let steal = run_compact_continuation(
        ref_.clone(),
        base_facts("crash-other", WorkContinuation::ActiveNonTool),
    )
    .await;
    match steal {
        OpResult::Err { error } => {
            assert!(
                error.code == ErrorCode::CompactContinuationAttemptConflict
                    || error.code == ErrorCode::CompactContinuationWriterConflict,
                "{}",
                error.code.as_str()
            );
        }
        OpResult::Ok { .. } => panic!("steal must fail"),
    }

    let mut facts = base_facts("crash-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let resumed = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!resumed.forced_boundary_this_attempt);
    assert_eq!(
        resumed.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(!resumed.replayed_terminal_attempt);

    let claim_after = get_compact_continuation_writer_claim(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(claim_after.claim, WriterClaimKind::None);
}

#[tokio::test]
async fn b3_finalize_write_failure_not_success_with_allowed_request() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let result = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("finalize-fail-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_finalize_write: true,
            ..Default::default()
        }),
    )
    .await;
    match result {
        OpResult::Ok { value } => assert!(!value.next_provider_request_allowed),
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::StorageFailure),
    }
}

#[tokio::test]
async fn m4_source_progress_after_prepare_does_not_block_activation() {
    let (_store, ref_, _) = fixture_thread().await;
    let prepared = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();

    let _ = intake_stream::message_events(
        ref_.clone(),
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "steering".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;

    let installed = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared,
        InstallPreparedOptions::default(),
    )
    .await;
    assert!(installed.is_ok(), "{installed:?}");

    let compact = thread_view::compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    assert!(compact.compact_point > 0);
}

#[tokio::test]
async fn m4_public_prepare_install_green_without_intervening_mutation() {
    let (_store, ref_, _) = fixture_thread().await;
    let compact = thread_view::compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    assert!(compact.compact_point > 0);
}

#[tokio::test]
async fn install_failure_after_marker_is_bounded_retry() {
    let (_store, ref_, path) = fixture_thread().await;
    let baseline = thread_view::compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    seed_open_agentic_turn(&ref_).await;

    let result = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("install-fail-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    // A failed install is bounded retry, not a stop (R23-S9/S10).
    assert!(!result.receipt.refused);
    assert_eq!(result.receipt.refuse_code, None);
    assert_eq!(
        result.receipt.outcome,
        CompactContinuationOutcomeKind::RetryCompact
    );
    assert_eq!(result.receipt.reason_code, "compact_retry_authorized");
    assert_eq!(
        warning_codes(&result.receipt),
        vec!["install_attempt_failed"]
    );
    assert_eq!(result.receipt.retry.attempt_index, 1);
    assert_eq!(result.receipt.retry.budget, 2);
    assert!(result.receipt.retry.retry_authorized);
    // Residual stays truthful about what actually happened.
    assert!(result.receipt.residual.marker_persisted);
    assert!(!result.receipt.residual.marker_served);
    assert!(result.receipt.residual.prior_serving_view_intact);
    assert_eq!(
        result.receipt.residual.relief_path,
        CompactContinuationReliefPath::CoreInstallFailed
    );
    // The session keeps working on its current body while the retry is pending.
    assert!(result.receipt.residual.next_provider_request_allowed);
    assert_eq!(
        result.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );

    let stored = get_compact_continuation_receipt(ref_.clone(), "install-fail-1")
        .await
        .expect_ok();
    assert_eq!(stored.as_ref().map(|s| s.terminal), Some(false));

    let described = thread_view::describe(ref_.clone()).await.expect_ok();
    assert_eq!(
        described.as_ref().map(|v| v.view_id.as_str()),
        Some(baseline.view_id.as_str())
    );

    // Budget spent: the second failure stops retrying and continues on the
    // current body. Still no refuse, still a next request.
    let exhausted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("install-fail-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(exhausted.receipt.refuse_code, None);
    assert_eq!(
        exhausted.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueCurrentBody
    );
    assert_eq!(
        exhausted.receipt.reason_code,
        "compact_retry_budget_exhausted"
    );
    assert_eq!(exhausted.receipt.retry.attempt_index, 2);
    assert_eq!(exhausted.receipt.retry.budget, 2);
    assert!(!exhausted.receipt.retry.retry_authorized);
    assert_eq!(
        warning_codes(&exhausted.receipt),
        vec!["install_attempt_failed", "compact_retry_budget_exhausted"]
    );
    assert!(exhausted.receipt.residual.prior_serving_view_intact);
    assert!(exhausted.receipt.residual.next_provider_request_allowed);
    let still_baseline = thread_view::describe(ref_.clone()).await.expect_ok();
    assert_eq!(
        still_baseline.as_ref().map(|v| v.view_id.as_str()),
        Some(baseline.view_id.as_str())
    );

    // Exhaustion TERMINALIZES (R23-S9/S10): bounded means bounded. The receipt
    // is terminal and the attempt's speculative boundary bookkeeping is
    // discarded — nothing remains to wedge a fresh attempt.
    let stored_exhausted = get_compact_continuation_receipt(ref_.clone(), "install-fail-1")
        .await
        .expect_ok();
    assert_eq!(stored_exhausted.as_ref().map(|s| s.terminal), Some(true));
    assert!(exhausted.pending_boundary.is_none());

    // Third same-attempt call is a terminal replay: zero added mutation.
    let stage_count = |file_path: &str| -> i64 {
        let db = open_raw(file_path);
        db.prepare("SELECT COUNT(*) AS n FROM compact_continuation_stage_log")
            .get()
            .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
            .unwrap_or(0)
    };
    let stages_before = stage_count(&path);
    let canonical_before = snapshot_canonical(&path);
    let third = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("install-fail-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert!(third.replayed_terminal_attempt);
    assert_eq!(
        third.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueCurrentBody
    );
    assert!(third.pending_boundary.is_none());
    assert_eq!(stage_count(&path), stages_before);
    assert_eq!(snapshot_canonical(&path), canonical_before);

    // A fresh later attempt proceeds normally — the dead attempt left no wedge.
    let fresh = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("install-fail-2", WorkContinuation::ActiveNonTool),
        None,
        None,
    )
    .await
    .expect_ok();
    assert_eq!(fresh.receipt.refuse_code, None);
    assert_eq!(fresh.receipt.retry.attempt_index, 1);
}

#[tokio::test]
async fn p1_install_fail_failed_repairable_same_attempt_repair() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let failed = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("repair-install-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    // Bounded retry, not a refuse: the attempt stays repairable and the session
    // keeps its current body in the meantime.
    assert_eq!(failed.receipt.refuse_code, None);
    assert_eq!(
        failed.receipt.outcome,
        CompactContinuationOutcomeKind::RetryCompact
    );
    assert!(failed.receipt.retry.retry_authorized);
    assert_eq!(
        warning_codes(&failed.receipt),
        vec!["install_attempt_failed"]
    );
    assert!(failed.receipt.residual.next_provider_request_allowed);
    assert_eq!(
        failed.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );
    assert_eq!(
        failed
            .pending_boundary
            .as_ref()
            .map(|b| b.attempt_id.as_str()),
        Some("repair-install-1")
    );
    let c_turn = failed.continuation_turn_id.clone().expect("turn");

    let stored_fail = get_compact_continuation_receipt(ref_.clone(), "repair-install-1")
        .await
        .expect_ok();
    assert_eq!(stored_fail.as_ref().map(|s| s.terminal), Some(false));

    let repaired = run_compact_continuation(
        ref_.clone(),
        base_facts("repair-install-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(!repaired.forced_boundary_this_attempt);
    assert_eq!(
        repaired.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(!repaired.replayed_terminal_attempt);
    assert!(success_outcomes(repaired.receipt.outcome));
    assert_eq!(repaired.receipt.refuse_code, None);
    assert!(repaired.receipt.residual.marker_served);
    assert!(repaired.pending_boundary.is_none());

    let stored_ok = get_compact_continuation_receipt(ref_.clone(), "repair-install-1")
        .await
        .expect_ok();
    assert_eq!(stored_ok.as_ref().map(|s| s.terminal), Some(true));
}

#[tokio::test]
async fn p1_foreign_attempt_cannot_steal_failed_repairable() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let failed = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("owner-fail-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        failed.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );

    let steal = run_compact_continuation(
        ref_.clone(),
        base_facts("thief-1", WorkContinuation::ActiveNonTool),
    )
    .await;
    match steal {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict);
            assert!(error.reason.contains("owner-fail-1"));
        }
        OpResult::Ok { .. } => panic!("expected conflict"),
    }

    let owner = run_compact_continuation(
        ref_.clone(),
        base_facts("owner-fail-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(owner.pending_boundary.is_none());
}

#[tokio::test]
async fn p1_interrupt_after_turn_end_commit_one_boundary_on_resume() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("force-gap-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_turn_end_commit: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert!(!interrupted.forced_boundary_this_attempt);
    assert!(interrupted.pending_boundary.is_none());

    let claim = get_compact_continuation_writer_claim(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(claim.claim, WriterClaimKind::Lhc);
    assert_eq!(claim.attempt_id.as_deref(), Some("force-gap-1"));

    let mut facts = base_facts("force-gap-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let resumed = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!resumed.forced_boundary_this_attempt);
    assert!(
        resumed
            .continuation_turn_id
            .as_ref()
            .is_some_and(|t| t.starts_with('t'))
    );
    assert!(resumed.pending_boundary.is_none());
    assert!(success_outcomes(resumed.receipt.outcome));

    let turns = turns::list_turns(ref_.clone()).await.expect_ok();
    assert_eq!(
        turns
            .iter()
            .filter(|t| t.outcome_reason.as_deref() == Some(CONTEXT_COMPACT_CONTINUE_REASON))
            .count(),
        1
    );
}

#[tokio::test]
async fn p1_terminal_replay_same_intent_ok_different_kind_conflict() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("intent-replay-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let after = snapshot_canonical(&path);

    let same = run_compact_continuation(
        ref_.clone(),
        base_facts("intent-replay-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(same.replayed_terminal_attempt);
    assert_eq!(same.receipt.outcome, first.receipt.outcome);
    assert_eq!(snapshot_canonical(&path), after);

    let different = run_compact_continuation(
        ref_.clone(),
        base_facts("intent-replay-1", WorkContinuation::None),
    )
    .await;
    match different {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict)
        }
        OpResult::Ok { .. } => panic!("expected conflict"),
    }
}

#[tokio::test]
async fn p1_preskip_with_pending_same_attempt_nonterminal_then_repair() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("preskip-pending-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        interrupted.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::Pending)
    );
    let c_turn = interrupted.continuation_turn_id.clone().expect("turn");

    let mut skip_facts = base_facts("preskip-pending-1", WorkContinuation::ActiveNonTool);
    skip_facts.writer_claim = WriterClaim::Lhc;
    skip_facts.seam.inside_transport_retry = true;
    let skip = run_compact_continuation(ref_.clone(), skip_facts)
        .await
        .expect_ok();
    assert!(skip.receipt.skipped);
    assert_eq!(
        skip.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::Pending)
    );
    assert_eq!(
        skip.pending_boundary
            .as_ref()
            .map(|b| b.continuation_turn_id.as_str()),
        Some(c_turn.as_str())
    );

    let stored_skip = get_compact_continuation_receipt(ref_.clone(), "preskip-pending-1")
        .await
        .expect_ok();
    assert_eq!(stored_skip.as_ref().map(|s| s.terminal), Some(false));

    let repaired = run_compact_continuation(
        ref_.clone(),
        base_facts("preskip-pending-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert_eq!(
        repaired.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(repaired.pending_boundary.is_none());
    assert!(success_outcomes(repaired.receipt.outcome));
}

#[tokio::test]
async fn input_validation_rejects_malformed() {
    assert_eq!(
        validate_host_facts(&Value::Null).expect("err").code,
        ErrorCode::InvalidCompactContinuationInput
    );
    assert_eq!(
        validate_host_facts(&json!({"attemptId": ""}))
            .expect("err")
            .code,
        ErrorCode::InvalidCompactContinuationInput
    );

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
    // Empty attemptId fails closed validation before I/O.
    let bad = CompactContinuationHostFacts {
        attempt_id: "".into(),
        seam: settled_seam(),
        provider_usage: ProviderUsageAuthority::Unavailable(ProviderUsageUnavailable {
            available: false,
            reason: ProviderUsageUnavailableReason::Missing,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 0,
            source: "s".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            safe_runway_threshold_tokens: None,
            safe_runway_threshold_source: None,
            upper_trigger_tokens: 100,
            lower_target_tokens: 50,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
            compact_retry_budget: None,
        },
        continuation: WorkContinuation::None,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: None,
        actor: "a".into(),
        harness: "h".into(),
        compact: None,
    };
    match run_compact_continuation(ref_, bad).await {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::InvalidCompactContinuationInput)
        }
        OpResult::Ok { .. } => panic!("expected invalid"),
    }
}

#[tokio::test]
async fn native_writer_row_no_authority_continues_stale_row_reclaims() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let before = snapshot_canonical(&path);

    // No host ownership authority supplied: the SDK never steals. This attempt
    // is the loser, continues its current request, and mutates nothing.
    let mut facts = base_facts("native-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let no_authority = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!no_authority.receipt.refused);
    assert_eq!(no_authority.receipt.refuse_code, None);
    assert_eq!(
        no_authority.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueCurrentBody
    );
    assert_eq!(no_authority.receipt.reason_code, "writer_owned_elsewhere");
    assert_eq!(
        warning_codes(&no_authority.receipt),
        vec!["writer_owned_elsewhere"]
    );
    assert!(!has_effect(
        &no_authority.receipt,
        CompactContinuationEffectType::ClaimWriter
    ));
    assert!(!has_effect(
        &no_authority.receipt,
        CompactContinuationEffectType::ReclaimWriter
    ));
    assert!(!no_authority.reclaimed_stale_writer_row);
    // Never strands: the session keeps working on its current body.
    assert!(no_authority.receipt.residual.next_provider_request_allowed);
    assert!(no_authority.next_provider_request_allowed);
    assert_eq!(snapshot_canonical(&path), before);

    // Host authority confirms no live owner: the stale row is reclaimed with a
    // receipt and the compact proceeds through to install.
    let seen: Arc<Mutex<Vec<WriterOwnershipQuery>>> = Arc::new(Mutex::new(Vec::new()));
    let mut facts = base_facts("native-reclaim", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let reclaimed = run_compact_continuation_with_ownership(ref_.clone(), facts, {
        let seen = Arc::clone(&seen);
        Some(Arc::new(move |q: &WriterOwnershipQuery| {
            seen.lock().unwrap().push(q.clone());
            Ok(false) // no live owner holds this LHC thread
        }))
    })
    .await
    .expect_ok();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    // The authority is asked about the canonical LHC thread id, not a session id.
    assert!(
        seen[0].thread_id.starts_with("th_"),
        "{}",
        seen[0].thread_id
    );
    assert_eq!(seen[0].attempt_id, "native-reclaim");
    assert_eq!(reclaimed.receipt.refuse_code, None);
    assert!(reclaimed.reclaimed_stale_writer_row);
    assert!(reclaimed.receipt.effects.iter().any(|e| matches!(
        e,
        CompactContinuationEffect::ReclaimWriter {
            prior_claim: ReclaimPriorClaim::Native,
            host_authority: ReclaimHostAuthority::NoLiveOwner,
        }
    )));
    assert_eq!(
        warning_codes(&reclaimed.receipt),
        vec!["stale_writer_row_reclaimed"]
    );
    // Reclaim precedes this attempt's own claim, and the seam compacts.
    let types: Vec<&str> = reclaimed
        .receipt
        .effects
        .iter()
        .map(|e| e.type_str())
        .collect();
    assert!(
        types.iter().position(|t| *t == "reclaim_writer")
            < types.iter().position(|t| *t == "claim_writer")
    );
    assert!(types.contains(&"install_serving_view"));
    assert!(reclaimed.receipt.residual.next_provider_request_allowed);
    let after = snapshot_canonical(&path);
    assert_eq!(after.marker_count, before.marker_count + 1);
    assert_ne!(after.view_id, before.view_id);
    // The claim is released again at the end of the seam.
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
}

/// R23-S8: the ownership registry is process-global and keyed by LHC thread id —
/// a per-session slot flag is not sufficient, because two sessions/aliases can
/// address the same thread and would hold two independent flags.
#[derive(Clone)]
struct HostSession {
    session_id: &'static str,
    registry: Arc<Mutex<HashMap<String, &'static str>>>,
    owns_slot_locally: Arc<Mutex<bool>>,
}

impl HostSession {
    fn new(session_id: &'static str, registry: &Arc<Mutex<HashMap<String, &'static str>>>) -> Self {
        Self {
            session_id,
            registry: Arc::clone(registry),
            owns_slot_locally: Arc::new(Mutex::new(false)),
        }
    }

    fn claim_thread(&self, thread_id: &str) -> bool {
        let mut reg = self.registry.lock().unwrap();
        if reg.contains_key(thread_id) {
            return false;
        }
        reg.insert(thread_id.to_string(), self.session_id);
        *self.owns_slot_locally.lock().unwrap() = true;
        true
    }

    fn release_thread(&self, thread_id: &str) {
        let mut reg = self.registry.lock().unwrap();
        if reg.get(thread_id) == Some(&self.session_id) {
            reg.remove(thread_id);
        }
        *self.owns_slot_locally.lock().unwrap() = false;
    }

    fn owns_slot(&self) -> bool {
        *self.owns_slot_locally.lock().unwrap()
    }

    /// Live owner iff some *other* session holds the thread in the registry.
    fn ownership_check(
        &self,
    ) -> lhc::compact_continuation::CompactContinuationWriterOwnershipCheck {
        let registry = Arc::clone(&self.registry);
        let session_id = self.session_id;
        Arc::new(move |q: &WriterOwnershipQuery| {
            let reg = registry.lock().unwrap();
            Ok(matches!(reg.get(&q.thread_id), Some(owner) if *owner != session_id))
        })
    }
}

#[tokio::test]
async fn two_sessions_one_thread_loser_continues_without_stealing() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let before = snapshot_canonical(&path);

    let registry: Arc<Mutex<HashMap<String, &'static str>>> = Arc::new(Mutex::new(HashMap::new()));
    let session_a = HostSession::new("session-a", &registry);
    let session_b = HostSession::new("session-b", &registry);

    // Session A takes the thread first. Both sessions believe they have a slot
    // locally; only the registry keyed by LHC thread id knows who owns it.
    let lhc_thread_id = threads::info(ref_.clone()).await.expect_ok().thread_id;
    assert!(session_a.claim_thread(&lhc_thread_id));
    assert!(!session_b.claim_thread(&lhc_thread_id));
    assert!(session_a.owns_slot());
    assert!(!session_b.owns_slot());

    // Session B is the loser: it sees a native row, asks the registry, and is
    // told a live owner holds the thread. It continues its current request.
    let mut facts = base_facts("session-b-attempt", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let loser = run_compact_continuation_with_ownership(
        ref_.clone(),
        facts,
        Some(session_b.ownership_check()),
    )
    .await
    .expect_ok();
    assert_eq!(loser.receipt.refuse_code, None);
    assert_eq!(
        loser.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueCurrentBody
    );
    assert_eq!(
        warning_codes(&loser.receipt),
        vec!["writer_owned_elsewhere"]
    );
    // Never steals.
    assert!(!loser.reclaimed_stale_writer_row);
    assert!(!has_effect(
        &loser.receipt,
        CompactContinuationEffectType::ReclaimWriter
    ));
    assert_eq!(
        registry.lock().unwrap().get(&lhc_thread_id).copied(),
        Some("session-a")
    );
    // Never strands.
    assert!(loser.next_provider_request_allowed);
    assert_eq!(snapshot_canonical(&path), before);

    // Session A owns the thread, so its own attempt is not blocked by the row.
    let mut facts = base_facts("session-a-attempt", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let owner = run_compact_continuation_with_ownership(
        ref_.clone(),
        facts,
        Some(session_a.ownership_check()),
    )
    .await
    .expect_ok();
    assert!(owner.reclaimed_stale_writer_row);
    assert_eq!(
        warning_codes(&owner.receipt),
        vec!["stale_writer_row_reclaimed"]
    );
    assert!(has_effect(
        &owner.receipt,
        CompactContinuationEffectType::InstallServingView
    ));
    assert_ne!(snapshot_canonical(&path).view_id, before.view_id);

    // Once A releases the thread, B retries at its next seam and now reclaims.
    session_a.release_thread(&lhc_thread_id);
    seed_open_agentic_turn(&ref_).await;
    let before_retry = snapshot_canonical(&path);
    let mut facts = base_facts("session-b-retry", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let retried = run_compact_continuation_with_ownership(
        ref_.clone(),
        facts,
        Some(session_b.ownership_check()),
    )
    .await
    .expect_ok();
    assert!(retried.reclaimed_stale_writer_row);
    assert_eq!(retried.receipt.refuse_code, None);
    assert_ne!(snapshot_canonical(&path).view_id, before_retry.view_id);
}

#[tokio::test]
async fn durable_receipt_and_stage_log_inspectable() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("inspect-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();

    let stored = get_compact_continuation_receipt(ref_.clone(), "inspect-1")
        .await
        .expect_ok();
    assert_eq!(stored.as_ref().map(|s| s.terminal), Some(true));
    assert_eq!(
        stored.as_ref().map(|s| s.receipt.outcome),
        Some(result.receipt.outcome)
    );

    let stages = list_compact_continuation_stages(ref_.clone(), "inspect-1")
        .await
        .expect_ok();
    assert!(stages.iter().any(|s| s.stage == "claimed_writer"));
    assert!(stages.iter().any(|s| s.stage == "receipt_recorded"));
}

#[tokio::test]
async fn sdk_surface_exposes_compact_continuation_crate_api() {
    // Rust maps the TS nested sdk.compactContinuation namespace to crate-root
    // free functions; assert public run path works and test hooks are not
    // re-exported from lhc::sdk / crate root.
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
    let _ = intake_stream::message_events(
        ref_.clone(),
        &[
            valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
            valid_event(kind::ASSISTANT_TEXT, AssistantTextOverrides::default()),
        ],
    )
    .await;

    let mut facts = base_facts("sdk-surface-1", WorkContinuation::None);
    facts.provider_usage = ProviderUsageAuthority::Available(ProviderUsageAvailable {
        available: true,
        input_tokens: 10,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total: 10,
        domain: "provider_reported_input".into(),
    });
    let result = run_compact_continuation(ref_, facts).await.expect_ok();
    assert_eq!(
        result.receipt.outcome,
        CompactContinuationOutcomeKind::NormalComplete
    );
}

#[tokio::test]
async fn bl1_claim_only_quiet_degraded_release_fresh_can_claim() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    seed_held_writer(&path, "crashed-quiet");
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("crashed-quiet".into()))
    );
    let mut quiet = below_usage_facts("crashed-quiet");
    quiet.writer_claim = WriterClaim::Lhc;
    let q = run_compact_continuation(ref_.clone(), quiet)
        .await
        .expect_ok();
    assert_eq!(
        q.receipt.outcome,
        CompactContinuationOutcomeKind::ContinueNormal
    );
    assert!(q.receipt.residual.writer_released);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    seed_held_writer(&path, "crashed-missing");
    let mut missing = base_facts("crashed-missing", WorkContinuation::ActiveNonTool);
    missing.writer_claim = WriterClaim::Lhc;
    missing.provider_usage = ProviderUsageAuthority::Unavailable(ProviderUsageUnavailable {
        available: false,
        reason: ProviderUsageUnavailableReason::Missing,
        domain: "provider_reported_input".into(),
    });
    let m = run_compact_continuation(ref_.clone(), missing)
        .await
        .expect_ok();
    assert!(m.receipt.residual.writer_released);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    // Degraded health on re-entry: warn + compact, then release. The reclaimed
    // claim is not a reason to stop, and it is never left held.
    seed_held_writer(&path, "crashed-health");
    let mut health = base_facts("crashed-health", WorkContinuation::ActiveNonTool);
    health.writer_claim = WriterClaim::Lhc;
    health.capture_complete = false;
    let h = run_compact_continuation(ref_.clone(), health)
        .await
        .expect_ok();
    assert_eq!(h.receipt.refuse_code, None);
    assert_eq!(warning_codes(&h.receipt), vec!["capture_incomplete"]);
    assert!(
        success_outcomes(h.receipt.outcome),
        "{:?}",
        h.receipt.outcome
    );
    assert!(h.receipt.residual.writer_released);
    assert!(h.receipt.residual.next_provider_request_allowed);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    // A decline (unprovable protected pair) on a claim-only crash also releases.
    seed_held_writer(&path, "crashed-decline");
    let mut declined_facts = base_facts(
        "crashed-decline",
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec!["call-not-in-record".into()],
            correlation_valid: true,
        },
    );
    declined_facts.writer_claim = WriterClaim::Lhc;
    let declined = run_compact_continuation(ref_.clone(), declined_facts)
        .await
        .expect_ok();
    assert_eq!(declined.receipt.refuse_code, None);
    assert_eq!(
        declined.receipt.outcome,
        CompactContinuationOutcomeKind::DeclineToOrdinaryCompact
    );
    assert!(declined.receipt.residual.writer_released);
    assert!(declined.receipt.residual.next_provider_request_allowed);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    seed_held_writer(&path, "crashed-owner");
    let foreign = run_compact_continuation(ref_.clone(), below_usage_facts("other-fresh"))
        .await
        .expect_ok();
    let _ = foreign;
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("crashed-owner".into()))
    );

    let mut resumed = base_facts("crashed-owner", WorkContinuation::ActiveNonTool);
    resumed.writer_claim = WriterClaim::Lhc;
    let r = run_compact_continuation(ref_.clone(), resumed)
        .await
        .expect_ok();
    assert!(success_outcomes(r.receipt.outcome));
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    seed_open_agentic_turn(&ref_).await;
    let fresh = run_compact_continuation(
        ref_.clone(),
        base_facts("fresh-after-wedge", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let _ = fresh;
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
}

#[tokio::test]
async fn bl2_finalize_mid_txn_faults_storage_failure_rollback_recover() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let cases: &[(&str, CompactContinuationTestHooks)] = &[
        (
            "fin-after-receipt",
            CompactContinuationTestHooks {
                fail_finalize_after_receipt: true,
                ..Default::default()
            },
        ),
        (
            "fin-at-release",
            CompactContinuationTestHooks {
                fail_finalize_at_release: true,
                ..Default::default()
            },
        ),
        (
            "fin-after-release",
            CompactContinuationTestHooks {
                fail_finalize_after_release_before_commit: true,
                ..Default::default()
            },
        ),
        (
            "fin-receipt-write",
            CompactContinuationTestHooks {
                fail_receipt_write: true,
                ..Default::default()
            },
        ),
    ];

    for (attempt_id, hooks) in cases {
        let before = snapshot_canonical(&path);
        assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

        let failed = run_compact_continuation_for_tests(
            ref_.clone(),
            base_facts(attempt_id, WorkContinuation::ActiveNonTool),
            None,
            Some(hooks.clone()),
        )
        .await;
        match failed {
            OpResult::Err { error } => assert_eq!(error.code, ErrorCode::StorageFailure),
            OpResult::Ok { .. } => panic!("{attempt_id}: expected storage_failure"),
        }

        let stored = get_compact_continuation_receipt(ref_.clone(), attempt_id)
            .await
            .expect_ok();
        assert!(stored.is_none(), "{attempt_id}: no terminal receipt");

        assert_eq!(
            writer_claim_of(&path),
            (WriterClaimKind::Lhc, Some((*attempt_id).into()))
        );

        let pending = get_pending_compact_continuation_boundary(ref_.clone())
            .await
            .expect_ok();
        if let Some(p) = &pending {
            assert_ne!(p.status, BoundaryStatus::Complete);
            assert_eq!(p.attempt_id, *attempt_id);
        }

        let stages = list_compact_continuation_stages(ref_.clone(), attempt_id)
            .await
            .expect_ok();
        assert!(!stages.iter().any(|s| s.stage == "writer_released"));
        assert!(stages.iter().any(|s| s.stage == "claimed_writer"));

        let after_fail = snapshot_canonical(&path);
        assert!(after_fail.view_id == before.view_id || after_fail.view_id.is_some());

        let mut recover = base_facts(attempt_id, WorkContinuation::ActiveNonTool);
        recover.writer_claim = WriterClaim::Lhc;
        let recovered = run_compact_continuation(ref_.clone(), recover)
            .await
            .expect_ok();
        assert!(success_outcomes(recovered.receipt.outcome));
        assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
        let stored_ok = get_compact_continuation_receipt(ref_.clone(), attempt_id)
            .await
            .expect_ok();
        assert_eq!(stored_ok.as_ref().map(|s| s.terminal), Some(true));

        seed_open_agentic_turn(&ref_).await;
    }
}

#[tokio::test]
async fn m2_identity_drift_conflict_posture_drift_accepted_audited() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let failed = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("identity-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        failed.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );

    let mut actor = base_facts("identity-1", WorkContinuation::ActiveNonTool);
    actor.actor = "other-actor".into();
    match run_compact_continuation(ref_.clone(), actor).await {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict)
        }
        OpResult::Ok { .. } => panic!("actor drift"),
    }

    let mut policy = base_facts("identity-1", WorkContinuation::ActiveNonTool);
    policy.policy.lower_target_tokens = 999_999;
    match run_compact_continuation(ref_.clone(), policy).await {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict)
        }
        OpResult::Ok { .. } => panic!("policy drift"),
    }

    let mut harness = base_facts("identity-1", WorkContinuation::ActiveNonTool);
    harness.harness = "other-harness".into();
    match run_compact_continuation(ref_.clone(), harness).await {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict)
        }
        OpResult::Ok { .. } => panic!("harness drift"),
    }

    match run_compact_continuation(
        ref_.clone(),
        base_facts(
            "identity-1",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["x".into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict)
        }
        OpResult::Ok { .. } => panic!("kind drift"),
    }

    let mut repaired = base_facts("identity-1", WorkContinuation::ActiveNonTool);
    repaired.provider_usage = ProviderUsageAuthority::Available(ProviderUsageAvailable {
        available: true,
        input_tokens: 91_000,
        cache_creation_tokens: 5_000,
        cache_read_tokens: 10_000,
        total: 106_000,
        domain: "provider_reported_input".into(),
    });
    repaired.seam.input_epoch_at_decision = 2;
    repaired.seam.input_epoch_at_apply = 2;
    let r = run_compact_continuation(ref_.clone(), repaired)
        .await
        .expect_ok();
    assert!(success_outcomes(r.receipt.outcome));
    let stages = list_compact_continuation_stages(ref_.clone(), "identity-1")
        .await
        .expect_ok();
    assert!(stages.iter().filter(|s| s.stage == "retry_posture").count() >= 2);
}

#[tokio::test]
async fn m5_public_rejects_test_hooks() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let before = snapshot_canonical(&path);

    let err = validate_host_facts(&json!({
        "attemptId": "hooks-public-1",
        "testHooks": { "skipRealCompact": true }
    }))
    .expect("reject");
    assert_eq!(err.code, ErrorCode::InvalidCompactContinuationInput);
    assert!(
        err.reason.contains("testHooks") || err.reason.contains("unknown field"),
        "{}",
        err.reason
    );

    // Runtime path: construct typed facts cannot carry testHooks; validation
    // of raw host JSON is the public reject surface covered above.
    assert_eq!(snapshot_canonical(&path), before);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
}

#[tokio::test]
async fn terminal_replay_repairs_stale_same_owner_claim() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("replay-repair-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let _ = first;
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    let receipt_before = get_compact_continuation_receipt(ref_.clone(), "replay-repair-1")
        .await
        .expect_ok();
    assert_eq!(receipt_before.as_ref().map(|s| s.terminal), Some(true));
    let receipt_json = lhc::shared_tech::js_json::js_json_stringify(
        &serde_json::to_value(&receipt_before.as_ref().unwrap().receipt).unwrap(),
    );

    seed_held_writer(&path, "replay-repair-1");
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("replay-repair-1".into()))
    );

    let replay = run_compact_continuation(
        ref_.clone(),
        base_facts("replay-repair-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(replay.replayed_terminal_attempt);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    let stages = list_compact_continuation_stages(ref_.clone(), "replay-repair-1")
        .await
        .expect_ok();
    assert!(stages.iter().any(|s| s.stage == "writer_claim_repaired"));
    assert!(stages.iter().any(|s| s.stage == "recovery_maintenance"));

    let receipt_after = get_compact_continuation_receipt(ref_.clone(), "replay-repair-1")
        .await
        .expect_ok();
    assert_eq!(receipt_after.as_ref().map(|s| s.terminal), Some(true));
    assert_eq!(
        lhc::shared_tech::js_json::js_json_stringify(
            &serde_json::to_value(&receipt_after.as_ref().unwrap().receipt).unwrap(),
        ),
        receipt_json
    );
}

#[tokio::test]
async fn m4_source_state_records_prepared_snapshot_before_marker() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("source-state-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let _ = result;

    let db = open_raw(&path);
    let max_event = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let src = db
        .prepare("SELECT source_state_json FROM thread_view WHERE singleton = 1")
        .get()
        .expect("view");
    let parsed: Value = serde_json::from_str(
        src.get("source_state_json")
            .and_then(|v| v.as_str())
            .unwrap(),
    )
    .unwrap();
    assert!(
        parsed
            .get("maxEventOrder")
            .and_then(|v| v.as_i64())
            .is_some_and(|prepared_max| prepared_max < max_event)
    );
    let marker = db
        .prepare(
            "SELECT event_order FROM event WHERE event_kind = 'compact_continuation_marker' ORDER BY event_order DESC LIMIT 1",
        )
        .get();
    assert!(marker.is_some());
    assert_eq!(
        marker
            .as_ref()
            .and_then(|r| r.get("event_order").and_then(|v| v.as_i64())),
        Some(max_event)
    );
    db.close();
}

#[tokio::test]
async fn m7_fractions_rejected_provider_total_not_sum_checked() {
    let fractional = validate_host_facts(&json!({
        "attemptId": "v-frac",
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0
        },
        "providerUsage": {
            "available": true,
            "inputTokens": 10.5,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "total": 10,
            "domain": "provider_reported_input"
        },
        "postMeasurementEstimate": {
            "tokens": 0,
            "source": "s",
            "domain": "source_labelled_estimate"
        },
        "policy": {
            "upperTriggerTokens": 100,
            "lowerTargetTokens": 50,
            "hostCapability": "full_state_machine"
        },
        "continuation": { "kind": "none" },
        "writerClaim": "none",
        "captureComplete": true,
        "providerIdentityValid": true,
        "actor": "a",
        "harness": "h"
    }));
    assert_eq!(
        fractional.as_ref().map(|e| e.code),
        Some(ErrorCode::InvalidCompactContinuationInput)
    );

    let total_not_sum = validate_host_facts(&json!({
        "attemptId": "v-total",
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0
        },
        "providerUsage": {
            "available": true,
            "inputTokens": 1,
            "cacheCreationTokens": 1,
            "cacheReadTokens": 1,
            "total": 999999,
            "domain": "provider_reported_input"
        },
        "postMeasurementEstimate": {
            "tokens": 0,
            "source": "s",
            "domain": "source_labelled_estimate"
        },
        "policy": {
            "upperTriggerTokens": 100,
            "lowerTargetTokens": 50,
            "hostCapability": "full_state_machine"
        },
        "continuation": { "kind": "none" },
        "writerClaim": "none",
        "captureComplete": true,
        "providerIdentityValid": true,
        "actor": "a",
        "harness": "h"
    }));
    assert!(total_not_sum.is_none());

    let unknown_nested = validate_host_facts(&json!({
        "attemptId": "v-unk",
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
            "extraFlag": true
        },
        "providerUsage": {
            "available": false,
            "reason": "missing",
            "domain": "provider_reported_input"
        },
        "postMeasurementEstimate": {
            "tokens": 0,
            "source": "s",
            "domain": "source_labelled_estimate"
        },
        "policy": {
            "upperTriggerTokens": 100,
            "lowerTargetTokens": 50,
            "hostCapability": "full_state_machine"
        },
        "continuation": { "kind": "none" },
        "writerClaim": "none",
        "captureComplete": true,
        "providerIdentityValid": true,
        "actor": "a",
        "harness": "h"
    }));
    assert!(
        unknown_nested
            .as_ref()
            .map(|e| e.reason.contains("seam.extraFlag"))
            .unwrap_or(false),
        "{unknown_nested:?}"
    );
}

#[tokio::test]
async fn writer_conflict_when_foreign_claim_held() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_held_writer(&path, "foreign-attempt");
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("my-attempt", WorkContinuation::ActiveNonTool),
    )
    .await;
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
    let facts = base_facts("id-1", WorkContinuation::ActiveNonTool);
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
async fn attempt_intent_inspect_returns_stored_identity_and_rejects_corrupt() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let tool_call_id = "call-preserve-X";
    let events = vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("y.txt"));
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
                    tool_call_id: tool_call_id.into(),
                    content: "preserve body ".repeat(20),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ];
    let _ = intake_stream::message_events(ref_.clone(), &events)
        .await
        .expect_ok();

    let mut facts = base_facts(
        "identity-inspect-1",
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec![tool_call_id.into()],
            correlation_valid: true,
        },
    );
    facts.actor = "recovery-actor".into();
    facts.harness = "recovery-harness".into();
    facts.policy = CompactContinuationPolicy {
        safe_runway_threshold_tokens: None,
        safe_runway_threshold_source: None,
        upper_trigger_tokens: 77_000,
        lower_target_tokens: 321,
        host_capability: CompactContinuationHostCapability::FullStateMachine,
        compact_retry_budget: None,
    };
    facts.compact = Some(lhc::compact_continuation::HostCompactOpts {
        profile: Some("continuation".into()),
        params: Some(ViewCompactParams {
            lower_bound: Some(321.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(25.0),
                smooth: Some(25.0),
                detailed: Some(25.0),
                brief: Some(25.0),
            }),
            newest_closed_protection: None,
        }),
    });

    let crashed = run_compact_continuation_for_tests(
        ref_.clone(),
        facts.clone(),
        None,
        Some(CompactContinuationTestHooks {
            fail_finalize_at_release: true,
            ..Default::default()
        }),
    )
    .await;
    assert!(matches!(crashed, OpResult::Err { .. }));
    let claim = get_compact_continuation_writer_claim(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(claim.attempt_id.as_deref(), Some("identity-inspect-1"));

    let missing = get_compact_continuation_attempt_intent(ref_.clone(), "no-such")
        .await
        .expect_ok();
    assert!(missing.is_none());

    let inspected = get_compact_continuation_attempt_intent(ref_.clone(), "identity-inspect-1")
        .await
        .expect_ok()
        .expect("identity row");
    assert_eq!(inspected.attempt_id, "identity-inspect-1");
    assert_eq!(inspected.actor, "recovery-actor");
    assert_eq!(inspected.harness, "recovery-harness");
    match &inspected.continuation {
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: ids,
            ..
        } => {
            assert_eq!(ids, &vec![tool_call_id.to_string()]);
        }
        other => panic!("expected pending tool identity, got {other:?}"),
    }
    assert_eq!(inspected.policy.upper_trigger_tokens, 77_000);
    assert_eq!(inspected.policy.lower_target_tokens, 321);
    let expected = compute_operation_identity(&facts);
    assert_eq!(inspected.intent_hash, hash_attempt_intent(&expected).0);

    // Corrupt intent_json → storage_failure; claim remains held.
    {
        let db = open_raw(&path);
        db.prepare("UPDATE compact_continuation_attempt SET intent_json = ? WHERE attempt_id = ?")
            .run(&[
                SqlParam::from("{not-json"),
                SqlParam::from("identity-inspect-1"),
            ]);
        db.close();
    }
    let corrupt = get_compact_continuation_attempt_intent(ref_.clone(), "identity-inspect-1").await;
    match corrupt {
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::StorageFailure),
        OpResult::Ok { .. } => panic!("corrupt intent must fail"),
    }
    let claim_after = get_compact_continuation_writer_claim(ref_)
        .await
        .expect_ok();
    assert_eq!(
        claim_after.attempt_id.as_deref(),
        Some("identity-inspect-1")
    );
}

#[tokio::test]
async fn claim_only_preserve_reentry_uses_stored_identity_despite_live_drift() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let tool_call_id = "call-crash-X";
    let events = vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("y.txt"));
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
                    tool_call_id: tool_call_id.into(),
                    content: "preserve body ".repeat(20),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ];
    let _ = intake_stream::message_events(ref_.clone(), &events)
        .await
        .expect_ok();

    let preserve = base_facts(
        "preserve-claim-only-1",
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec![tool_call_id.into()],
            correlation_valid: true,
        },
    );
    let crashed = run_compact_continuation_for_tests(
        ref_.clone(),
        preserve,
        None,
        Some(CompactContinuationTestHooks {
            fail_finalize_at_release: true,
            ..Default::default()
        }),
    )
    .await;
    assert!(matches!(crashed, OpResult::Err { .. }));

    let identity = get_compact_continuation_attempt_intent(ref_.clone(), "preserve-claim-only-1")
        .await
        .expect_ok()
        .expect("stored identity");

    // Live drift without stored identity → attempt_conflict; claim held.
    let mut live_drift = base_facts("preserve-claim-only-1", WorkContinuation::ActiveNonTool);
    live_drift.writer_claim = WriterClaim::Lhc;
    live_drift.policy = CompactContinuationPolicy {
        safe_runway_threshold_tokens: None,
        safe_runway_threshold_source: None,
        upper_trigger_tokens: 999_999,
        lower_target_tokens: 1,
        host_capability: CompactContinuationHostCapability::FullStateMachine,
        compact_retry_budget: None,
    };
    live_drift.compact = Some(lhc::compact_continuation::HostCompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(1.0),
            percentages: None,
            newest_closed_protection: None,
        }),
    });
    match run_compact_continuation(ref_.clone(), live_drift).await {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict);
        }
        OpResult::Ok { .. } => panic!("drift must conflict"),
    }
    assert_eq!(
        get_compact_continuation_writer_claim(ref_.clone())
            .await
            .expect_ok()
            .attempt_id
            .as_deref(),
        Some("preserve-claim-only-1")
    );

    // Recovery with stored immutable fields + fresh mutable posture.
    let mut recovered = base_facts(
        &identity.attempt_id,
        match &identity.continuation {
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids,
                ..
            } => WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: protected_tool_call_ids.clone(),
                correlation_valid: true,
            },
            other => other.clone(),
        },
    );
    recovered.actor = identity.actor.clone();
    recovered.harness = identity.harness.clone();
    recovered.policy = identity.policy.clone();
    recovered.compact = identity.compact.clone();
    recovered.writer_claim = WriterClaim::Lhc;
    recovered.seam.input_epoch_at_decision = 9;
    recovered.seam.input_epoch_at_apply = 9;
    let recovered_run = run_compact_continuation(ref_.clone(), recovered)
        .await
        .expect_ok();
    let _ = recovered_run.receipt.outcome;
    assert_eq!(
        get_compact_continuation_writer_claim(ref_.clone())
            .await
            .expect_ok()
            .claim,
        WriterClaimKind::None
    );

    seed_open_agentic_turn(&ref_).await;
    let fresh = run_compact_continuation(
        ref_,
        base_facts(
            "fresh-after-preserve-recovery",
            WorkContinuation::ActiveNonTool,
        ),
    )
    .await
    .expect_ok();
    let _ = fresh.receipt.outcome;
    let _ = path;
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
    let ver = db
        .prepare("PRAGMA user_version")
        .get()
        .and_then(|r| r.get("user_version").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    assert_eq!(ver, CURRENT_THREAD_SCHEMA_VERSION);
    db.close();
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
async fn marker_visible_to_model_hidden_from_user_chat() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("marker-vis-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    if let Some(tid) = &result.continuation_turn_id {
        if has_compact_continuation_marker(ref_.clone(), tid)
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
}

// ── N5 Rust↔TS parity deltas (LIM-63 Fable review) ─────────────────────────

#[tokio::test]
async fn n5_terminal_replay_without_identity_row_conflicts() {
    // TS refuses terminal replay when the attempt-intent row is missing.
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let first = run_compact_continuation(
        ref_.clone(),
        base_facts("n5-replay-noid-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(!first.receipt.outcome.as_str().is_empty());

    // Drop the identity row while leaving the terminal receipt intact.
    {
        let db = open_raw(&path);
        db.prepare("DELETE FROM compact_continuation_attempt WHERE attempt_id = ?")
            .run(&[SqlParam::from("n5-replay-noid-1")]);
        db.close();
    }

    let replay = run_compact_continuation(
        ref_.clone(),
        base_facts("n5-replay-noid-1", WorkContinuation::ActiveNonTool),
    )
    .await;
    match replay {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict);
            assert!(
                error.reason.contains("already completed")
                    || error.reason.contains("different operation identity"),
                "{}",
                error.reason
            );
        }
        OpResult::Ok { .. } => panic!("expected conflict when identity row is missing"),
    }
}

#[tokio::test]
async fn n5_preskip_with_pending_feeds_oracle_boundary_and_releases_writer() {
    // TS feeds forcedFromPending into the oracle and releases same-owner writer
    // on pre-seam skip (pending stays nonterminal for repair).
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("n5-preskip-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        interrupted.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::Pending)
    );
    let c_turn = interrupted
        .continuation_turn_id
        .clone()
        .expect("continuation turn");
    // Writer should still be held after interrupt.
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("n5-preskip-1".into()))
    );

    let mut skip_facts = base_facts("n5-preskip-1", WorkContinuation::ActiveNonTool);
    skip_facts.writer_claim = WriterClaim::Lhc;
    skip_facts.seam.inside_transport_retry = true;
    let skip = run_compact_continuation(ref_.clone(), skip_facts)
        .await
        .expect_ok();
    assert!(skip.receipt.skipped);
    // Residual must preserve pending boundary identity (not NotApplied).
    assert_eq!(
        skip.pending_boundary
            .as_ref()
            .map(|b| b.continuation_turn_id.as_str()),
        Some(c_turn.as_str())
    );
    assert_eq!(
        skip.receipt.residual.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    // Same-owner writer released on pre-seam skip (TS releaseWriter: ownsWriter).
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    // Receipt stays nonterminal while pending exists.
    let stored = get_compact_continuation_receipt(ref_.clone(), "n5-preskip-1")
        .await
        .expect_ok();
    assert_eq!(stored.as_ref().map(|s| s.terminal), Some(false));
}

#[tokio::test]
async fn n5_foreign_pending_checked_before_attempt_intent_write() {
    // TS ownership gate runs before insertAttemptIntent. Foreign pending must
    // conflict without registering the caller's attempt intent.
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("n5-owner-a", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert!(interrupted.pending_boundary.is_some());

    let before_intents: i64 = {
        let db = open_raw(&path);
        let n = db
            .prepare("SELECT COUNT(*) AS n FROM compact_continuation_attempt WHERE attempt_id = ?")
            .get_params(&[SqlParam::from("n5-owner-b")])
            .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        db.close();
        n
    };
    assert_eq!(before_intents, 0);

    let foreign = run_compact_continuation(
        ref_.clone(),
        base_facts("n5-owner-b", WorkContinuation::ActiveNonTool),
    )
    .await;
    match foreign {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict);
        }
        OpResult::Ok { .. } => panic!("expected foreign-pending conflict"),
    }

    let after_intents: i64 = {
        let db = open_raw(&path);
        let n = db
            .prepare("SELECT COUNT(*) AS n FROM compact_continuation_attempt WHERE attempt_id = ?")
            .get_params(&[SqlParam::from("n5-owner-b")])
            .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        db.close();
        n
    };
    assert_eq!(
        after_intents, 0,
        "foreign pending must not write caller's attempt intent"
    );
}

#[tokio::test]
async fn n5_force_turn_end_no_new_turn_is_attempt_conflict() {
    // TS maps "force_turn_end did not open a continuation turn" to attempt
    // conflict (reused attemptId), not storage_failure.
    //
    // Seed a force-intent + durable turn_end whose force key has no opened
    // turn. Keep one open agentic turn for health. Re-entry re-sends the
    // idempotent turn_end, finds no opened turn, and must return
    // attempt_conflict (not storage_failure).
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    seed_held_writer(&path, "n5-force-none-1");

    {
        let db = open_raw(&path);
        let now = "2020-01-01T00:00:00.000Z";
        let turn_key = "lhc.compact_continuation.force_turn_end:n5-force-none-1";
        let _ = db
            .prepare(
                r#"INSERT INTO compact_continuation_force_intent
                   (attempt_id, turn_end_idempotency_key, status, continuation_turn_id, recorded_at)
                   VALUES (?, ?, 'intent', NULL, ?)"#,
            )
            .run(&[
                SqlParam::from("n5-force-none-1"),
                SqlParam::from(turn_key),
                SqlParam::from(now),
            ]);
        let max_order: i64 = db
            .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
            .get()
            .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        let next = max_order + 1;
        let payload = r#"{"outcome":"completed","outcomeReason":"context_compact_continue"}"#;
        let _ = db
            .prepare(
                r#"INSERT INTO event
                   (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
                   VALUES (?, 'turn_end', ?, 'fixture-actor', 'fixture-harness', ?, ?)"#,
            )
            .run(&[
                SqlParam::from(next),
                SqlParam::from(turn_key),
                SqlParam::from(payload),
                SqlParam::from(now),
            ]);
        // Sanity: force key resolves to no turn.
        let found = db
            .prepare("SELECT turn_id FROM turns WHERE opened_at_event_order = ? LIMIT 1")
            .get_params(&[SqlParam::from(next)]);
        assert!(found.is_none(), "force key must not resolve a turn");
        db.close();
    }

    let mut facts = base_facts("n5-force-none-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let result = run_compact_continuation(ref_.clone(), facts).await;
    match result {
        OpResult::Err { error } => {
            assert_eq!(
                error.code,
                ErrorCode::CompactContinuationAttemptConflict,
                "must be attempt_conflict not storage: {} / {}",
                error.code.as_str(),
                error.reason
            );
            assert!(
                error.reason.contains("force_turn_end")
                    || error.reason.contains("did not open")
                    || error.reason.contains("reused attemptId")
                    || error.reason.contains("cannot force"),
                "{}",
                error.reason
            );
        }
        OpResult::Ok { value } => panic!(
            "expected attempt_conflict, got ok outcome={:?} refuse={:?} reason={}",
            value.receipt.outcome, value.receipt.refuse_code, value.receipt.reason_code
        ),
    }
}

#[tokio::test]
async fn n5_wrong_kind_with_applied_boundary_refuses_without_stealing() {
    // TS: applied boundary + non-active_non_tool is refused by the oracle
    // (invalid_pending_boundary_continuation). Hosts re-entering with a
    // different continuation kind hit identity conflict first (kind is part of
    // operation identity) — both are non-mutating refuse/conflict paths.
    //
    // This test pins the host-visible identity path (kind drift) plus residual
    // preservation: foreign/owner pending stays, no install, no second marker.
    // The oracle wrong-kind refuse is covered by compact_continuation_contract.
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("n5-wrong-kind-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let c_turn = interrupted
        .continuation_turn_id
        .clone()
        .expect("continuation turn");
    let before = snapshot_canonical(&path);
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("n5-wrong-kind-1".into()))
    );

    // Kind drift on same attemptId → identity conflict (TS M2 parity).
    let wrong = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "n5-wrong-kind-1",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["ghost-tool".into()],
                correlation_valid: true,
            },
        ),
    )
    .await;
    match wrong {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::CompactContinuationAttemptConflict);
        }
        OpResult::Ok { .. } => panic!("kind drift must conflict on identity"),
    }

    // Pending boundary owner identity preserved; no install / no new marker.
    let pending = get_pending_compact_continuation_boundary(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(
        pending.as_ref().map(|b| b.continuation_turn_id.as_str()),
        Some(c_turn.as_str())
    );
    assert_eq!(
        pending.as_ref().map(|b| b.attempt_id.as_str()),
        Some("n5-wrong-kind-1")
    );
    let after = snapshot_canonical(&path);
    assert_eq!(after.marker_count, before.marker_count);
    assert_eq!(after.turn_count, before.turn_count);

    // Correct-kind same-attempt repair still works after the wrong-kind probe.
    let mut repair = base_facts("n5-wrong-kind-1", WorkContinuation::ActiveNonTool);
    repair.writer_claim = WriterClaim::Lhc;
    let repaired = run_compact_continuation(ref_.clone(), repair)
        .await
        .expect_ok();
    assert_eq!(
        repaired.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(repaired.pending_boundary.is_none() || success_outcomes(repaired.receipt.outcome));
}

// ── LIM-67 pending-tool protected escalation runtime ─────────────────────────

const PROTECTED_ID: &str = "call-protected-1";

/// One open agentic turn: older huge unprotected tool results, then the
/// protected pair.
async fn seed_escalation_turn(ref_: &ThreadRef) {
    let mut events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "sustained tool work".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "running the long tool loop".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
    ];
    // Selector eviction can raise the compact point into later closed fixture
    // turns. Keep enough unprotected bulk in the open tail for a genuine
    // escalation walk.
    for i in 1..=10 {
        let id = format!("call-old-{i}");
        events.push(valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: id.clone(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!(format!("old-{i}.txt")));
                        m
                    },
                }),
                ..Default::default()
            },
        ));
        events.push(valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: id,
                    content: format!("old bulky data {i} ").repeat(2000),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ));
    }
    events.push(valid_event(
        kind::TOOL_CALL,
        ToolCallOverrides {
            payload: Some(ToolCallPayload {
                tool_call_id: PROTECTED_ID.into(),
                tool_name: "read_file".into(),
                arguments: {
                    let mut m = Map::new();
                    m.insert("path".into(), json!("current.txt"));
                    m
                },
            }),
            ..Default::default()
        },
    ));
    events.push(valid_event(
        kind::TOOL_RESULT,
        ToolResultOverrides {
            payload: Some(ToolResultPayload {
                tool_call_id: PROTECTED_ID.into(),
                content: "protected verbatim payload".into(),
                is_error: Some(false),
            }),
            ..Default::default()
        },
    ));
    let batch = intake_stream::message_events(ref_.clone(), &events).await;
    assert!(matches!(batch, OpResult::Ok { .. }));
}

fn escalation_facts(attempt_id: &str, safe_runway_threshold: i64) -> CompactContinuationHostFacts {
    let mut facts = base_facts(
        attempt_id,
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec![PROTECTED_ID.to_string()],
            correlation_valid: true,
        },
    );
    facts.provider_usage = ProviderUsageAuthority::Available(ProviderUsageAvailable {
        available: true,
        input_tokens: 290_000,
        cache_creation_tokens: 5_000,
        cache_read_tokens: 5_000,
        total: 300_000,
        domain: "provider_reported_input".into(),
    });
    facts.post_measurement_estimate = PostMeasurementEstimate {
        tokens: 2_000,
        source: "lhc_token_estimate".into(),
        domain: "source_labelled_estimate".into(),
    };
    facts.policy = CompactContinuationPolicy {
        upper_trigger_tokens: 100_000,
        // High enough that a successful prune is not classified degraded
        // solely for missing the lower target after selector eviction.
        lower_target_tokens: 5_000_000,
        host_capability: CompactContinuationHostCapability::FullStateMachine,
        safe_runway_threshold_tokens: Some(safe_runway_threshold),
        safe_runway_threshold_source: Some("host_safe_runway".into()),
        compact_retry_budget: None,
    };
    // Keep the fixture turns in the full tail so selector eviction cannot
    // band later closed turns (those would report missing derivations).
    facts.compact = Some(lhc::compact_continuation::HostCompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(1_000_000.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(100.0),
                smooth: Some(0.0),
                detailed: Some(0.0),
                brief: Some(0.0),
            }),
            newest_closed_protection: None,
        }),
    });
    facts
}

#[tokio::test]
async fn escalates_ineffective_preserve_through_protected_boundary_and_installs() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let path = fixture.file_path.clone();
    let ref_ = ThreadRef::file_path(&path);
    seed_escalation_turn(&ref_).await;
    let before = snapshot_canonical(&path);

    // Preserve alone saves ~nothing (results are in the open tail), so projected
    // pressure stays above the threshold until the protected boundary prunes the
    // older unprotected bodies (via the maximal retry).
    let result = run_compact_continuation(
        ref_.clone(),
        escalation_facts("escalate-install-1", 298_000),
    )
    .await
    .expect_ok();
    let receipt = &result.receipt;
    assert_eq!(
        receipt.outcome,
        CompactContinuationOutcomeKind::CompactPreserveToolEscalated
    );
    assert_eq!(
        receipt.relief_path,
        lhc::shared_tech::compact_continuation::CompactContinuationReliefPath::HostValidationAwaiting
    );
    assert_eq!(
        receipt.protected_tool_call_ids,
        vec![PROTECTED_ID.to_string()]
    );
    assert!(!receipt.residual.next_provider_request_allowed);
    assert_eq!(
        receipt.residual.host_validation_status,
        lhc::shared_tech::compact_continuation::HostValidationStatusFact::Awaiting
    );
    assert!(receipt.residual.marker_persisted);
    assert!(receipt.residual.marker_served);
    let vb_after = receipt
        .residual
        .visibility_boundary_after
        .expect("boundary advanced");
    assert!(vb_after > receipt.residual.visibility_boundary_before.unwrap_or(0));
    let types: Vec<&str> = receipt.effects.iter().map(|e| e.type_str()).collect();
    assert!(types.contains(&"advance_visibility_boundary"));
    assert!(types.contains(&"preserve_tool_pairs_verbatim"));

    // One forced boundary, one marker, view installed.
    let after = snapshot_canonical(&path);
    assert_eq!(after.turn_count, before.turn_count + 1);
    assert_eq!(after.marker_count, 1);
    assert_ne!(after.view_id, before.view_id);

    // Protected pair stays canonical and verbatim.
    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let protected_result = listed
        .iter()
        .find(|m| {
            m.kind.as_str() == "tool_result"
                && lhc::shared_tech::js_json::js_json_stringify_of(m)
                    .unwrap()
                    .contains(PROTECTED_ID)
        })
        .expect("protected result present");
    assert!(
        lhc::shared_tech::js_json::js_json_stringify_of(protected_result)
            .unwrap()
            .contains("protected verbatim payload")
    );

    // Host validation acknowledgment flips awaiting → ok.
    let hv = get_compact_continuation_host_validation(ref_.clone(), "escalate-install-1")
        .await
        .expect_ok()
        .expect("awaiting row");
    assert_eq!(hv.status, HostValidationStatus::Awaiting);
    let ack = record_compact_continuation_host_validation(
        ref_.clone(),
        "escalate-install-1",
        HostValidationStatus::Ok,
        None,
        None,
    )
    .await
    .expect_ok();
    assert_eq!(ack.status, HostValidationStatus::Ok);
    let hv2 = get_compact_continuation_host_validation(ref_.clone(), "escalate-install-1")
        .await
        .expect_ok()
        .expect("row");
    assert_eq!(hv2.status, HostValidationStatus::Ok);
}

#[tokio::test]
async fn unsafe_runway_after_maximal_prune_installs_best_relief() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let path = fixture.file_path.clone();
    let ref_ = ThreadRef::file_path(&path);
    seed_escalation_turn(&ref_).await;
    let before = snapshot_canonical(&path);

    // Threshold so low that no amount of eligible pruning can reach it. R24:
    // that is a diagnostic about the projection, not a gate — oversized
    // outgoing content is ours to truncate as a ladder rung, and the host's
    // exact body check is downstream.
    let result =
        run_compact_continuation(ref_.clone(), escalation_facts("escalate-unsafe-1", 1_000))
            .await
            .expect_ok();
    let receipt = &result.receipt;
    assert!(!receipt.refused);
    assert_eq!(receipt.refuse_code, None);
    assert_eq!(
        receipt.outcome,
        CompactContinuationOutcomeKind::CompactPreserveToolEscalated
    );
    assert_eq!(
        receipt.relief_path,
        CompactContinuationReliefPath::HostValidationAwaiting
    );
    assert_eq!(
        receipt.protected_tool_call_ids,
        vec![PROTECTED_ID.to_string()]
    );

    // The unsafe projection is recorded as a loud warning and nothing else.
    assert_eq!(warning_codes(receipt), vec!["unsafe_runway_projection"]);
    assert_eq!(receipt.pressure.projected_pressure_safe, Some(false));
    let projected = receipt
        .pressure
        .projected_pressure_tokens
        .expect("projected");
    let next_request = receipt
        .pressure
        .next_request_pressure_tokens
        .expect("next request");
    assert!(projected < next_request);

    // The relief actually installed: marker, escalated boundary, new view.
    let types: Vec<&str> = receipt.effects.iter().map(|e| e.type_str()).collect();
    assert!(types.contains(&"insert_continuation_marker"));
    assert!(types.contains(&"preserve_tool_pairs_verbatim"));
    assert!(types.contains(&"advance_visibility_boundary"));
    assert!(types.contains(&"install_serving_view"));
    assert!(receipt.residual.marker_persisted);
    assert!(receipt.residual.marker_served);
    assert!(!receipt.residual.prior_serving_view_intact);
    let boundary_after = receipt.residual.visibility_boundary_after.expect("after");
    assert!(boundary_after > receipt.residual.visibility_boundary_before.unwrap_or(0));

    let after = snapshot_canonical(&path);
    assert_eq!(after.turn_count, before.turn_count + 1);
    assert_eq!(after.marker_count, 1);
    assert_ne!(after.view_id, before.view_id);

    // The protected pair still survives verbatim through the maximal prune.
    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let protected_result = listed
        .iter()
        .find(|m| {
            m.kind == MessageKind::ToolResult
                && m.blocks.iter().any(|b| {
                    b.content.get("toolCallId").and_then(|v| v.as_str()) == Some(PROTECTED_ID)
                })
        })
        .expect("protected tool_result survives");
    assert_eq!(
        protected_result.blocks[0]
            .content
            .get("content")
            .and_then(|v| v.as_str()),
        Some("protected verbatim payload")
    );

    // Next request waits on the host validation acknowledgment only — not on
    // the runway projection. Acknowledging lets the session proceed.
    assert_eq!(
        receipt.residual.host_validation_status,
        lhc::shared_tech::compact_continuation::HostValidationStatusFact::Awaiting
    );
    assert!(!receipt.residual.next_provider_request_allowed);
    let ack = record_compact_continuation_host_validation(
        ref_.clone(),
        "escalate-unsafe-1",
        HostValidationStatus::Ok,
        None,
        None,
    )
    .await;
    assert!(matches!(ack, OpResult::Ok { .. }), "{ack:?}");
    let hv = get_compact_continuation_host_validation(ref_.clone(), "escalate-unsafe-1")
        .await
        .expect_ok()
        .expect("row");
    assert_eq!(hv.status, HostValidationStatus::Ok);
}

#[tokio::test]
async fn stale_boundary_preview_is_clamped_to_prepared_compact_point() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let path = fixture.file_path.clone();
    let ref_ = ThreadRef::file_path(&path);
    seed_escalation_turn(&ref_).await;
    let stored_point = thread_view::describe(ref_.clone())
        .await
        .expect_ok()
        .map(|v| v.compact_point)
        .unwrap_or(0);
    let prepared = thread_view::prepare_compact(
        ref_.clone(),
        CompactOpts {
            profile: None,
            params: None,
            signal: None,
            compact_point_upper_bound: None,
        },
    )
    .await
    .expect_ok();
    // High target: first preview stays at the stored compact point (0).
    let preview = thread_view::preview_protected_boundary(
        ref_.clone(),
        vec![PROTECTED_ID.to_string()],
        lhc::thread_view::internal::protected_boundary::ProtectedBoundaryOpts {
            target_zone_tokens: Some(10_000_000),
            compact_point_override: None,
        },
    )
    .await
    .expect_ok();
    assert!(prepared.selection.compact_point > stored_point);
    assert!(preview.proposed_boundary < prepared.selection.compact_point);

    let mut facts = escalation_facts("stale-boundary-clamp-1", 10_000_000);
    // Same default-profile prepare as above (not the 100% full escalation bag).
    facts.compact = None;
    let result = run_compact_continuation(ref_, facts).await.expect_ok();
    // Upper bound is the previewed visibility line: compact point cannot
    // advance past it (no stale-behind install refuse; pair stays in tail).
    let after = result
        .receipt
        .residual
        .visibility_boundary_after
        .unwrap_or(preview.proposed_boundary);
    assert!(
        after < prepared.selection.compact_point,
        "boundary {after} must stay below unconstrained compact point {}",
        prepared.selection.compact_point
    );
}
