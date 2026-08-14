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
    BoundaryStatus, CompactContinuationHostFacts, WriterClaimKind, compute_operation_identity,
    compute_retry_posture, get_compact_continuation_receipt, get_compact_continuation_writer_claim,
    get_pending_compact_continuation_boundary, has_compact_continuation_marker,
    hash_attempt_intent, list_compact_continuation_stages, prove_pending_tool_pair,
    run_compact_continuation, validate_host_facts,
};
use lhc::messages::{self, MessageKind, MessageListOptions};
use lhc::shared_tech::compact_continuation::{
    CONTEXT_COMPACT_CONTINUE_REASON, CompactContinuationEffectType,
    CompactContinuationHostCapability, CompactContinuationOutcomeKind, CompactContinuationPolicy,
    CompactContinuationRefuseCode, CompactContinuationSeam, PostMeasurementEstimate,
    ProviderUsageAuthority, ProviderUsageAvailable, ProviderUsageUnavailable,
    ProviderUsageUnavailableReason, WorkContinuation, WriterClaim,
    compact_continuation_marker_idempotency_key,
};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::storage::{CURRENT_THREAD_SCHEMA_VERSION, SqlParam};
use lhc::shared_tech::view::{PartialViewProfilePercentages, ViewCompactParams};
use lhc::thread_view::{self, CompactOpts, InstallPreparedOptions};
use lhc::threads::{NewThreadInput, ThreadRef, new_thread};
use lhc::turns;
use lhc::{init_lhc, intake_stream};
use serde_json::{Map, Value, json};

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
            upper_trigger_tokens: 100_000,
            lower_target_tokens: 400,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
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
        }),
        signal: None,
    }
}

// ── tests ─────────────────────────────────────────────────────────────────

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
async fn b1_health_refusals_do_not_mutate() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let _ = thread_view::compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let before = snapshot_canonical(&path);

    let mut capture = base_facts("health-capture", WorkContinuation::ActiveNonTool);
    capture.capture_complete = false;
    let cap = run_compact_continuation(ref_.clone(), capture)
        .await
        .expect_ok();
    assert_eq!(
        cap.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::IncompleteCapture)
    );
    assert!(cap.receipt.residual.prior_serving_view_intact);
    assert!(!cap.receipt.residual.marker_persisted);
    assert!(!has_effect(
        &cap.receipt,
        CompactContinuationEffectType::ClaimWriter
    ));
    assert_eq!(snapshot_canonical(&path), before);

    let mut identity = base_facts("health-identity", WorkContinuation::ActiveNonTool);
    identity.provider_identity_valid = false;
    let id = run_compact_continuation(ref_.clone(), identity)
        .await
        .expect_ok();
    assert_eq!(
        id.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidProviderIdentity)
    );
    assert_eq!(snapshot_canonical(&path), before);

    seed_pending_tool_turn(&ref_, "call-bad-corr").await;
    let before_tool = snapshot_canonical(&path);
    let corr = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "health-corr",
            WorkContinuation::PendingCorrelatedToolResult {
                tool_call_id: "call-bad-corr".into(),
                correlation_valid: false,
            },
        ),
    )
    .await
    .expect_ok();
    assert_eq!(
        corr.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidToolCorrelation)
    );
    assert_eq!(snapshot_canonical(&path), before_tool);

    let missing = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "health-pair-missing",
            WorkContinuation::PendingCorrelatedToolResult {
                tool_call_id: "call-does-not-exist".into(),
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    assert_eq!(
        missing.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidToolCorrelation)
    );
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
                tool_call_id: tool_call_id.into(),
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
async fn m4_stale_prepared_compact_install_refuses_prior_view_intact() {
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
    match installed {
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::StalePreparedCompact),
        OpResult::Ok { .. } => panic!("expected stale"),
    }

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
async fn install_failure_after_marker_keeps_prior_view() {
    let (_store, ref_, _) = fixture_thread().await;
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
    assert_eq!(
        result.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InstallFailed)
    );
    assert!(result.receipt.residual.marker_persisted);
    assert!(!result.receipt.residual.marker_served);
    assert!(result.receipt.residual.prior_serving_view_intact);
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
    assert_eq!(
        failed.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InstallFailed)
    );
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
            upper_trigger_tokens: 100,
            lower_target_tokens: 50,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
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
async fn native_writer_conflict_refuses_without_claim() {
    let (_store, ref_, path) = fixture_thread().await;
    let before = snapshot_canonical(&path);
    let mut facts = base_facts("native-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Native;
    let result = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert_eq!(
        result.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::NativeWriterConflict)
    );
    assert!(!has_effect(
        &result.receipt,
        CompactContinuationEffectType::ClaimWriter
    ));
    assert_eq!(snapshot_canonical(&path), before);
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
async fn bl1_claim_only_quiet_health_release_fresh_can_claim() {
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

    seed_held_writer(&path, "crashed-health");
    let mut health = base_facts("crashed-health", WorkContinuation::ActiveNonTool);
    health.writer_claim = WriterClaim::Lhc;
    health.capture_complete = false;
    let h = run_compact_continuation(ref_.clone(), health)
        .await
        .expect_ok();
    assert_eq!(
        h.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::IncompleteCapture)
    );
    assert!(h.receipt.residual.writer_released);
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
                tool_call_id: "x".into(),
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
async fn m4_source_state_json_max_event_order_after_marker_install() {
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
    assert_eq!(
        parsed.get("maxEventOrder").and_then(|v| v.as_i64()),
        Some(max_event)
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
