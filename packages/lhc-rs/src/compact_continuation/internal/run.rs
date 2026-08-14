//! Staged compact-continuation runtime (LIM-61 / LIM-63A).
//! Ported from packages/lhc/src/compact-continuation/internal/run.ts.

use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::intake_stream::{self, MessageEventInput};
use crate::shared_tech::compact_continuation::{
    COMPACT_CONTINUATION_CONTRACT_VERSION, COMPACT_CONTINUATION_MARKER_ACTION,
    COMPACT_CONTINUATION_MARKER_CAUSE, COMPACT_CONTINUATION_MARKER_KIND,
    CONTEXT_COMPACT_CONTINUE_REASON, CompactContinuationDecision, CompactContinuationInput,
    CompactContinuationInvariants, CompactContinuationPolicy, CompactContinuationReceipt,
    CompactContinuationSeam, CompactMaterialFacts, ForcedContinuationBoundary,
    ForcedContinuationBoundaryApplied, ForcedContinuationBoundaryNotApplied,
    PostMeasurementEstimate, ProviderUsageAuthority, WorkContinuation, WriterClaim,
    compact_continuation_marker_idempotency_key, decide_compact_continuation,
};
use crate::shared_tech::context::resolve_instance_config;
use crate::shared_tech::derivation::Clock;
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::persist::{create_db_read_transaction, create_db_write_transaction};
use crate::shared_tech::sha256::sha256_hex;
use crate::shared_tech::view::{CompactReceipt, ViewCompactParams};
use crate::thread_view::{
    CompactOpts, InstallPreparedOptions, install_prepared_compact, prepare_compact,
};
use crate::threads::{ThreadRef, resolve_thread_ref};

use super::candidate::assemble_candidate_from_prepared;
use super::store::{
    BoundaryRow, InsertAttemptIntentResult, StageName, StoredCompactContinuationReceipt,
    WriterClaimKind, WriterClaimRow, append_stage_log, claim_lhc_writer,
    find_continuation_turn_from_force_key, insert_attempt_intent, list_boundaries, list_receipts,
    list_stage_log, mark_force_intent_applied, marker_exists_by_idempotency_key, persist_receipt,
    read_force_intent, read_open_turn_ids, read_open_turn_member_count, read_pending_boundary,
    read_receipt_by_attempt_id, read_writer_claim, record_force_intent, release_lhc_writer,
    upsert_boundary,
};
use super::tool_pair::{ToolPairProof, prove_pending_tool_pair};
use super::validate_host::validate_host_facts;

// ── Host input ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationHostFacts {
    pub attempt_id: String,
    pub seam: CompactContinuationSeam,
    pub provider_usage: ProviderUsageAuthority,
    pub post_measurement_estimate: PostMeasurementEstimate,
    pub policy: CompactContinuationPolicy,
    pub continuation: WorkContinuation,
    pub writer_claim: WriterClaim,
    pub capture_complete: bool,
    pub provider_identity_valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub single_open_turn: Option<bool>,
    pub actor: String,
    pub harness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact: Option<HostCompactOpts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCompactOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<ViewCompactParams>,
}

/// Test-only fault injection. Not part of the public host-facts surface.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompactContinuationTestHooks {
    pub force_compact_structurally_valid: Option<bool>,
    pub force_install_succeeds: Option<bool>,
    pub force_useful_reduction: Option<bool>,
    pub force_can_produce_valid_provider_request: Option<bool>,
    pub force_derivations_missing_or_failed: Option<bool>,
    pub skip_real_compact: bool,
    pub fail_install_before_write: bool,
    pub interrupt_after_boundary: bool,
    pub interrupt_after_marker: bool,
    pub interrupt_after_marker_event: bool,
    pub interrupt_after_turn_end_commit: bool,
    pub fail_finalize_write: bool,
    pub fail_receipt_write: bool,
    pub fail_finalize_after_receipt: bool,
    pub fail_finalize_at_release: bool,
    pub fail_finalize_after_release_before_commit: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompactContinuationRunResult {
    pub decision: CompactContinuationDecision,
    pub receipt: CompactContinuationReceipt,
    pub forced_boundary_this_attempt: bool,
    pub continuation_turn_id: Option<String>,
    pub marker_persisted: bool,
    pub compact_receipt: Option<CompactReceipt>,
    pub next_provider_request_allowed: bool,
    pub refuse_receipt_fidelity_describes: &'static str,
    pub replayed_terminal_attempt: bool,
    pub pending_boundary: Option<BoundaryRow>,
}

fn detail(cause: &dyn std::fmt::Display) -> String {
    cause.to_string()
}

fn caller_error(
    code: ErrorCode,
    reason: impl Into<String>,
) -> OpResult<CompactContinuationRunResult> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code,
            reason: reason.into(),
            event_index: None,
        },
    }
}

fn attempt_conflict(
    attempt_id: &str,
    owner_attempt_id: &str,
    reason: &str,
) -> OpResult<CompactContinuationRunResult> {
    caller_error(
        ErrorCode::CompactContinuationAttemptConflict,
        format!("{reason} (caller attemptId={attempt_id}, owner attemptId={owner_attempt_id})"),
    )
}

fn is_at_seam(seam: &CompactContinuationSeam) -> bool {
    seam.model_response_complete
        && seam.requested_tools_settled
        && seam.capture_flushed
        && seam.before_next_provider_request
}

fn pressure_at_or_above(facts: &CompactContinuationHostFacts) -> Option<bool> {
    let total = facts.provider_usage.available_total()?;
    let next = total + facts.post_measurement_estimate.tokens;
    Some(next >= facts.policy.upper_trigger_tokens)
}

fn empty_material() -> CompactMaterialFacts {
    CompactMaterialFacts {
        derivations_missing_or_failed: false,
        lower_target_met: false,
        compact_structurally_valid: false,
        install_succeeds: false,
        useful_reduction: false,
        can_produce_valid_provider_request: false,
    }
}

fn apply_material_hooks(
    base: CompactMaterialFacts,
    hooks: Option<&CompactContinuationTestHooks>,
) -> CompactMaterialFacts {
    let Some(hooks) = hooks else {
        return base;
    };
    CompactMaterialFacts {
        derivations_missing_or_failed: hooks
            .force_derivations_missing_or_failed
            .unwrap_or(base.derivations_missing_or_failed),
        lower_target_met: base.lower_target_met,
        compact_structurally_valid: hooks
            .force_compact_structurally_valid
            .unwrap_or(base.compact_structurally_valid),
        install_succeeds: hooks
            .force_install_succeeds
            .unwrap_or(base.install_succeeds),
        useful_reduction: hooks
            .force_useful_reduction
            .unwrap_or(base.useful_reduction),
        can_produce_valid_provider_request: hooks
            .force_can_produce_valid_provider_request
            .unwrap_or(base.can_produce_valid_provider_request),
    }
}

fn build_oracle_input(
    facts: &CompactContinuationHostFacts,
    invariants: CompactContinuationInvariants,
    forced_continuation_boundary: ForcedContinuationBoundary,
    compact_material: CompactMaterialFacts,
) -> CompactContinuationInput {
    CompactContinuationInput {
        contract_version: COMPACT_CONTINUATION_CONTRACT_VERSION.to_string(),
        seam: facts.seam.clone(),
        provider_usage: facts.provider_usage.clone(),
        post_measurement_estimate: facts.post_measurement_estimate.clone(),
        policy: facts.policy.clone(),
        continuation: facts.continuation.clone(),
        invariants,
        forced_continuation_boundary,
        compact_material,
    }
}

fn to_run_result(
    decision: CompactContinuationDecision,
    forced_boundary_this_attempt: bool,
    continuation_turn_id: Option<String>,
    compact_receipt: Option<CompactReceipt>,
    replayed_terminal_attempt: bool,
    pending_boundary: Option<BoundaryRow>,
) -> CompactContinuationRunResult {
    let marker_persisted = decision.receipt.residual.marker_persisted;
    let next_provider_request_allowed = decision.receipt.residual.next_provider_request_allowed;
    let cont = continuation_turn_id
        .clone()
        .or_else(|| decision.receipt.residual.continuation_turn_id.clone());
    CompactContinuationRunResult {
        receipt: decision.receipt.clone(),
        decision,
        forced_boundary_this_attempt,
        continuation_turn_id: cont,
        marker_persisted,
        compact_receipt,
        next_provider_request_allowed,
        refuse_receipt_fidelity_describes: "installed_view_only",
        replayed_terminal_attempt,
        pending_boundary,
    }
}

fn marker_event_input(
    facts: &CompactContinuationHostFacts,
    continuation_turn_id: &str,
) -> MessageEventInput {
    let mut payload = Map::new();
    payload.insert("kind".into(), json!(COMPACT_CONTINUATION_MARKER_KIND));
    payload.insert("continuationTurnId".into(), json!(continuation_turn_id));
    payload.insert("cause".into(), json!(COMPACT_CONTINUATION_MARKER_CAUSE));
    payload.insert("action".into(), json!(COMPACT_CONTINUATION_MARKER_ACTION));
    payload.insert("newUserRequest".into(), json!(false));
    payload.insert("waitForUser".into(), json!(false));
    MessageEventInput {
        event_kind: "compact_continuation_marker".into(),
        idempotency_key: Some(compact_continuation_marker_idempotency_key(
            continuation_turn_id,
        )),
        actor: facts.actor.clone(),
        harness: facts.harness.clone(),
        payload,
        extra: Map::new(),
    }
}

fn turn_end_idempotency_key(attempt_id: &str) -> String {
    format!("lhc.compact_continuation.force_turn_end:{attempt_id}")
}

fn turn_end_event_input(
    facts: &CompactContinuationHostFacts,
    attempt_id: &str,
) -> MessageEventInput {
    let mut payload = Map::new();
    payload.insert("outcome".into(), json!("completed"));
    payload.insert(
        "outcomeReason".into(),
        json!(CONTEXT_COMPACT_CONTINUE_REASON),
    );
    MessageEventInput {
        event_kind: "turn_end".into(),
        idempotency_key: Some(turn_end_idempotency_key(attempt_id)),
        actor: facts.actor.clone(),
        harness: facts.harness.clone(),
        payload,
        extra: Map::new(),
    }
}

fn pending_boundary_as_forced(pending: Option<&BoundaryRow>) -> ForcedContinuationBoundary {
    let Some(pending) = pending else {
        return ForcedContinuationBoundary::NotApplied(
            crate::shared_tech::compact_continuation::ForcedContinuationBoundaryNotApplied {
                applied: false,
            },
        );
    };
    match pending.status {
        super::store::BoundaryStatus::Pending | super::store::BoundaryStatus::FailedRepairable => {
            ForcedContinuationBoundary::Applied(
                crate::shared_tech::compact_continuation::ForcedContinuationBoundaryApplied {
                    applied: true,
                    continuation_turn_id: pending.continuation_turn_id.clone(),
                    forced_this_seam: false,
                    marker_already_persisted: pending.marker_persisted,
                },
            )
        }
        super::store::BoundaryStatus::Complete => ForcedContinuationBoundary::NotApplied(
            crate::shared_tech::compact_continuation::ForcedContinuationBoundaryNotApplied {
                applied: false,
            },
        ),
    }
}

/// Stable JSON with sorted object keys (arrays keep order).
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            // Use js_json for primitives via object wrap? Match JSON.stringify for primitives.
            js_json_stringify(value)
        }
        Value::Array(items) => {
            let inner = items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{inner}]")
        }
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            let inner = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        js_json_stringify(&Value::String(k.clone())),
                        stable_stringify(map.get(k).unwrap())
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
    }
}

pub fn compute_operation_identity(facts: &CompactContinuationHostFacts) -> Map<String, Value> {
    let continuation_identity = match &facts.continuation {
        WorkContinuation::PendingCorrelatedToolResult { tool_call_id, .. } => {
            json!({
                "kind": "pending_correlated_tool_result",
                "toolCallId": tool_call_id,
            })
        }
        WorkContinuation::None => json!({ "kind": "none" }),
        WorkContinuation::ActiveNonTool => json!({ "kind": "active_non_tool" }),
    };
    let mut out = Map::new();
    out.insert(
        "contractVersion".into(),
        json!(COMPACT_CONTINUATION_CONTRACT_VERSION),
    );
    out.insert("attemptId".into(), json!(facts.attempt_id));
    out.insert("actor".into(), json!(facts.actor));
    out.insert("harness".into(), json!(facts.harness));
    out.insert("continuation".into(), continuation_identity);
    out.insert(
        "policy".into(),
        serde_json::to_value(&facts.policy).unwrap_or(Value::Null),
    );
    if let Some(compact) = &facts.compact {
        out.insert(
            "compact".into(),
            serde_json::to_value(compact).unwrap_or(Value::Null),
        );
    }
    out
}

pub fn compute_retry_posture(
    facts: &CompactContinuationHostFacts,
    durable_writer: &WriterClaimRow,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "seam".into(),
        serde_json::to_value(&facts.seam).unwrap_or(Value::Null),
    );
    out.insert(
        "providerUsage".into(),
        serde_json::to_value(&facts.provider_usage).unwrap_or(Value::Null),
    );
    out.insert(
        "postMeasurementEstimate".into(),
        serde_json::to_value(&facts.post_measurement_estimate).unwrap_or(Value::Null),
    );
    out.insert("captureComplete".into(), json!(facts.capture_complete));
    out.insert(
        "providerIdentityValid".into(),
        json!(facts.provider_identity_valid),
    );
    out.insert(
        "hostWriterClaim".into(),
        serde_json::to_value(&facts.writer_claim).unwrap_or(Value::Null),
    );
    out.insert(
        "durableWriter".into(),
        json!({
            "claim": durable_writer.claim.as_str(),
            "attemptId": durable_writer.attempt_id,
        }),
    );
    if let WorkContinuation::PendingCorrelatedToolResult {
        correlation_valid, ..
    } = &facts.continuation
    {
        out.insert("correlationValid".into(), json!(correlation_valid));
    }
    out
}

pub fn compute_attempt_intent(facts: &CompactContinuationHostFacts) -> Map<String, Value> {
    compute_operation_identity(facts)
}

pub fn hash_attempt_intent(intent: &Map<String, Value>) -> (String, String) {
    let intent_json = stable_stringify(&Value::Object(intent.clone()));
    let intent_hash = sha256_hex(&intent_json);
    (intent_hash, intent_json)
}

pub fn hash_record(value: &Map<String, Value>) -> (String, String) {
    let json = stable_stringify(&Value::Object(value.clone()));
    let hash = sha256_hex(&json);
    (hash, json)
}

fn now_iso() -> String {
    let time = resolve_instance_config()
        .map(|c| (c.clock)())
        .unwrap_or_else(SystemTime::now);
    // Match thread_view system_time_to_iso style via RFC3339 millis if available;
    // use simple format via humantime-free approach from thread_view:
    crate_time_iso(time)
}

fn crate_time_iso(time: SystemTime) -> String {
    // Reuse pattern from thread_view::system_time_to_iso (private) — approximate:
    use std::time::UNIX_EPOCH;
    let dur = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    // Format as UTC ISO-8601 with millis — simplified using chrono-less math:
    // For parity with tests that inject fixed clocks via resolve_instance_config,
    // we use the same algorithm as thread_view if possible by calling through
    // a small local implementation.
    // Fall back to chrono-free UTC formatting:
    format_utc_iso(secs, millis)
}

fn format_utc_iso(secs: i64, millis: u32) -> String {
    // Algorithm from civil time conversion (Howard Hinnant).
    let z = secs + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let time_of_day = secs.rem_euclid(86400) as u32;
    let hour = time_of_day / 3600;
    let min = (time_of_day % 3600) / 60;
    let sec = time_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

fn default_clock() -> Clock {
    std::sync::Arc::new(|| {
        resolve_instance_config()
            .map(|c| (c.clock)())
            .unwrap_or_else(SystemTime::now)
    })
}

fn clock_iso(clock: &Clock) -> String {
    crate_time_iso(clock())
}

async fn stage_log(
    ref_: ThreadRef,
    attempt_id: &str,
    stage: StageName,
    clock: Clock,
    detail_obj: Option<Map<String, Value>>,
) -> OpResult<bool> {
    let attempt_id = attempt_id.to_string();
    let result = create_db_write_transaction(
        ref_,
        move |tx| {
            Box::pin(async move {
                append_stage_log(
                    tx.db,
                    &attempt_id,
                    stage,
                    &clock_iso(&(tx.clock)),
                    detail_obj.as_ref(),
                );
                true
            })
        },
        Some(clock),
    )
    .await;
    match result {
        OpResult::Ok { value } => OpResult::Ok { value },
        OpResult::Err { error } => OpResult::Err { error },
    }
}

struct FinalizeOpts {
    release_writer: bool,
    terminal: bool,
    boundary_update: Option<BoundaryUpdate>,
    forced_boundary_this_attempt: bool,
    continuation_turn_id: Option<String>,
    compact_receipt: Option<CompactReceipt>,
}

struct BoundaryUpdate {
    continuation_turn_id: String,
    status: super::store::BoundaryStatus,
    marker_persisted: bool,
    last_stage: String,
    forced_at: String,
    completed_at: Option<String>,
}

async fn finalize_attempt(
    ref_: ThreadRef,
    facts: &CompactContinuationHostFacts,
    decision: CompactContinuationDecision,
    opts: FinalizeOpts,
    clock: Clock,
    hooks: Option<&CompactContinuationTestHooks>,
) -> OpResult<CompactContinuationRunResult> {
    if hooks.is_some_and(|h| h.fail_finalize_write || h.fail_receipt_write) {
        return storage_failure("compact-continuation finalize write failed (test injection)");
    }

    let mut terminal = opts.terminal;
    if terminal && !opts.release_writer {
        let held = create_db_read_transaction(ref_.clone(), |tx| {
            Box::pin(async move { read_writer_claim(tx.db) })
        })
        .await;
        let OpResult::Ok { value: held } = held else {
            return match held {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        if held.claim == WriterClaimKind::Lhc
            && held.attempt_id.as_deref() == Some(facts.attempt_id.as_str())
        {
            terminal = false;
        }
    }

    let mut decision_for_persist = decision.clone();
    if opts.release_writer {
        if !decision_for_persist.receipt.residual.writer_released {
            decision_for_persist.receipt.residual.writer_released = true;
        }
    } else {
        let held = create_db_read_transaction(ref_.clone(), |tx| {
            Box::pin(async move { read_writer_claim(tx.db) })
        })
        .await;
        let OpResult::Ok { value: held } = held else {
            return match held {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        if held.claim == WriterClaimKind::Lhc
            && held.attempt_id.as_deref() == Some(facts.attempt_id.as_str())
            && decision_for_persist.receipt.residual.writer_released
        {
            decision_for_persist.receipt.residual.writer_released = false;
        }
    }

    let attempt_id = facts.attempt_id.clone();
    let release_writer = opts.release_writer;
    let boundary_update = opts.boundary_update;
    let fail_after_receipt = hooks.is_some_and(|h| h.fail_finalize_after_receipt);
    let fail_at_release = hooks.is_some_and(|h| h.fail_finalize_at_release);
    let fail_after_release = hooks.is_some_and(|h| h.fail_finalize_after_release_before_commit);
    let decision_persist = decision_for_persist.clone();
    let terminal_flag = terminal;

    let write = create_db_write_transaction(
        ref_.clone(),
        move |tx| {
            Box::pin(async move {
                let recorded_at = clock_iso(&(tx.clock));
                let status = persist_receipt(
                    tx.db,
                    &attempt_id,
                    &recorded_at,
                    &decision_persist,
                    terminal_flag,
                );
                if matches!(status, super::store::PersistReceiptResult::AlreadyTerminal) {
                    return "already_terminal".to_string();
                }
                let mut detail = Map::new();
                detail.insert("terminal".into(), json!(terminal_flag));
                detail.insert(
                    "outcome".into(),
                    json!(decision_persist.receipt.outcome.as_str()),
                );
                detail.insert(
                    "writerReleased".into(),
                    json!(decision_persist.receipt.residual.writer_released),
                );
                detail.insert("releaseWriter".into(), json!(release_writer));
                append_stage_log(
                    tx.db,
                    &attempt_id,
                    StageName::ReceiptRecorded,
                    &recorded_at,
                    Some(&detail),
                );
                if let Some(bu) = boundary_update {
                    upsert_boundary(
                        tx.db,
                        &bu.continuation_turn_id,
                        &attempt_id,
                        bu.status,
                        bu.marker_persisted,
                        &bu.last_stage,
                        &bu.forced_at,
                        bu.completed_at.as_deref(),
                    );
                }
                if fail_after_receipt {
                    panic!("compact-continuation finalize after receipt failed (test injection)");
                }
                if release_writer {
                    if fail_at_release {
                        panic!(
                            "compact-continuation finalize at release failed (test injection)"
                        );
                    }
                    let released = release_lhc_writer(tx.db, &attempt_id);
                    if !released {
                        panic!("failed to release writer for attempt {attempt_id}");
                    }
                    append_stage_log(
                        tx.db,
                        &attempt_id,
                        StageName::WriterReleased,
                        &recorded_at,
                        None,
                    );
                    if fail_after_release {
                        panic!(
                            "compact-continuation finalize after release before commit failed (test injection)"
                        );
                    }
                }
                "ok".to_string()
            })
        },
        Some(clock.clone()),
    )
    .await;

    let OpResult::Ok { value: write_kind } = write else {
        return match write {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let pending = create_db_read_transaction(ref_, |tx| {
        Box::pin(async move { read_pending_boundary(tx.db) })
    })
    .await;
    let OpResult::Ok { value: pending } = pending else {
        return match pending {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    OpResult::Ok {
        value: to_run_result(
            decision_for_persist,
            opts.forced_boundary_this_attempt,
            opts.continuation_turn_id,
            opts.compact_receipt,
            write_kind == "already_terminal",
            pending,
        ),
    }
}

async fn release_own_writer_if_held(
    ref_: ThreadRef,
    attempt_id: &str,
    clock: Clock,
) -> OpResult<bool> {
    let attempt_id = attempt_id.to_string();
    let rel = create_db_write_transaction(
        ref_,
        move |tx| {
            Box::pin(async move {
                let claim = read_writer_claim(tx.db);
                if claim.claim == WriterClaimKind::Lhc
                    && claim.attempt_id.as_deref() == Some(attempt_id.as_str())
                {
                    let released = release_lhc_writer(tx.db, &attempt_id);
                    if !released {
                        panic!("failed to release writer for attempt {attempt_id}");
                    }
                    append_stage_log(
                        tx.db,
                        &attempt_id,
                        StageName::WriterReleased,
                        &clock_iso(&(tx.clock)),
                        None,
                    );
                }
                true
            })
        },
        Some(clock),
    )
    .await;
    match rel {
        OpResult::Ok { value } => OpResult::Ok { value },
        OpResult::Err { error } => OpResult::Err { error },
    }
}

/// Public entry: closed validation rejects testHooks; no fault injection surface.
pub async fn run_compact_continuation(
    ref_: ThreadRef,
    facts: CompactContinuationHostFacts,
) -> OpResult<CompactContinuationRunResult> {
    run_compact_continuation_inner(ref_, facts, default_clock(), None).await
}

/// Test-only entry with optional fault hooks.
pub async fn run_compact_continuation_for_tests(
    ref_: ThreadRef,
    facts: CompactContinuationHostFacts,
    clock: Option<Clock>,
    hooks: Option<CompactContinuationTestHooks>,
) -> OpResult<CompactContinuationRunResult> {
    run_compact_continuation_inner(ref_, facts, clock.unwrap_or_else(default_clock), hooks).await
}

async fn run_compact_continuation_inner(
    ref_: ThreadRef,
    facts: CompactContinuationHostFacts,
    clock: Clock,
    hooks: Option<CompactContinuationTestHooks>,
) -> OpResult<CompactContinuationRunResult> {
    // Closed host-fact validation before any I/O.
    let facts_value = serde_json::to_value(&facts).unwrap_or(Value::Null);
    if let Some(issue) = validate_host_facts(&facts_value) {
        return OpResult::Err { error: issue };
    }

    let resolved = resolve_thread_ref(ref_.clone()).await;
    if !matches!(resolved, OpResult::Ok { .. }) {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    }

    // Intent identity + terminal replay before mutation.
    let identity = compute_operation_identity(&facts);
    let (intent_hash, intent_json) = hash_attempt_intent(&identity);

    let pre = create_db_read_transaction(ref_.clone(), {
        let attempt_id = facts.attempt_id.clone();
        move |tx| {
            Box::pin(async move {
                (
                    read_receipt_by_attempt_id(tx.db, &attempt_id),
                    read_writer_claim(tx.db),
                    read_pending_boundary(tx.db),
                    read_force_intent(tx.db, &attempt_id),
                    read_open_turn_ids(tx.db),
                )
            })
        }
    })
    .await;
    let OpResult::Ok {
        value: (prior_receipt, durable_writer, mut pending_boundary, force_intent, open_ids),
    } = pre
    else {
        return match pre {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    // Terminal replay
    if let Some(prior) = &prior_receipt {
        if prior.terminal {
            if let Some(stored) = read_attempt_for_hash_check(ref_.clone(), &facts.attempt_id).await
            {
                match stored {
                    OpResult::Ok { value: Some(row) } => {
                        if row.intent_hash != intent_hash {
                            return attempt_conflict(
                                &facts.attempt_id,
                                &facts.attempt_id,
                                "completed attemptId reused with different operation identity",
                            );
                        }
                    }
                    OpResult::Ok { value: None } => {}
                    OpResult::Err { error } => return OpResult::Err { error },
                }
            }
            let pending = create_db_read_transaction(ref_.clone(), |tx| {
                Box::pin(async move { read_pending_boundary(tx.db) })
            })
            .await;
            let OpResult::Ok { value: pending } = pending else {
                return match pending {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { .. } => unreachable!(),
                };
            };
            return OpResult::Ok {
                value: to_run_result(
                    prior.decision.clone(),
                    false,
                    prior.continuation_turn_id.clone(),
                    None,
                    true,
                    pending,
                ),
            };
        }
    }

    // Persist attempt intent (immutable identity)
    let facts_for_intent = facts.clone();
    let intent_write = create_db_write_transaction(
        ref_.clone(),
        {
            let attempt_id = facts.attempt_id.clone();
            let intent_hash = intent_hash.clone();
            let intent_json = intent_json.clone();
            let clock = clock.clone();
            move |tx| {
                Box::pin(async move {
                    let result = insert_attempt_intent(
                        tx.db,
                        &attempt_id,
                        &intent_hash,
                        &intent_json,
                        &clock_iso(&clock),
                    );
                    let posture =
                        compute_retry_posture(&facts_for_intent, &read_writer_claim(tx.db));
                    append_stage_log(
                        tx.db,
                        &attempt_id,
                        StageName::RetryPosture,
                        &clock_iso(&clock),
                        Some(&posture),
                    );
                    result
                })
            }
        },
        Some(clock.clone()),
    )
    .await;
    let OpResult::Ok {
        value: intent_status,
    } = intent_write
    else {
        return match intent_write {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    if matches!(intent_status, InsertAttemptIntentResult::ExistsDifferent) {
        return attempt_conflict(
            &facts.attempt_id,
            &facts.attempt_id,
            "attemptId reused for a different operation identity",
        );
    }

    // Seam eligibility
    let at_seam = is_at_seam(&facts.seam);
    let epoch_ok = facts.seam.input_epoch_at_decision == facts.seam.input_epoch_at_apply;
    let transport_retry = facts.seam.inside_transport_retry;

    let single_open_turn = open_ids.len() == 1;
    let owns_pending = pending_boundary
        .as_ref()
        .is_some_and(|b| b.attempt_id == facts.attempt_id);
    let foreign_pending = pending_boundary
        .as_ref()
        .is_some_and(|b| b.attempt_id != facts.attempt_id);

    if foreign_pending {
        let owner = pending_boundary
            .as_ref()
            .map(|b| b.attempt_id.clone())
            .unwrap_or_default();
        return attempt_conflict(
            &facts.attempt_id,
            &owner,
            "pending compact-continuation boundary owned by another attempt",
        );
    }

    // Force-intent gap reconcile for continue-turn repair
    let mut forced_from_pending = pending_boundary_as_forced(pending_boundary.as_ref());
    if matches!(&facts.continuation, WorkContinuation::ActiveNonTool) {
        if let Some(fi) = &force_intent {
            if pending_boundary.is_none() {
                // Try to materialize boundary from force key
                let turn_key = fi.turn_end_idempotency_key.clone();
                let found = create_db_read_transaction(ref_.clone(), move |tx| {
                    Box::pin(async move { find_continuation_turn_from_force_key(tx.db, &turn_key) })
                })
                .await;
                if let OpResult::Ok {
                    value: Some(turn_id),
                } = found
                {
                    let attempt_id = facts.attempt_id.clone();
                    let forced_at = fi.recorded_at.clone();
                    let mark = create_db_write_transaction(
                        ref_.clone(),
                        {
                            let turn_id = turn_id.clone();
                            let attempt_id = attempt_id.clone();
                            let forced_at = forced_at.clone();
                            let clock = clock.clone();
                            move |tx| {
                                Box::pin(async move {
                                    let marker_already = marker_exists_by_idempotency_key(
                                        tx.db,
                                        &compact_continuation_marker_idempotency_key(&turn_id),
                                    );
                                    upsert_boundary(
                                        tx.db,
                                        &turn_id,
                                        &attempt_id,
                                        super::store::BoundaryStatus::Pending,
                                        marker_already,
                                        "force_turn_end",
                                        &forced_at,
                                        None,
                                    );
                                    mark_force_intent_applied(tx.db, &attempt_id, &turn_id);
                                    append_stage_log(
                                        tx.db,
                                        &attempt_id,
                                        StageName::ForceTurnEnd,
                                        &clock_iso(&clock),
                                        Some(&{
                                            let mut m = Map::new();
                                            m.insert("continuationTurnId".into(), json!(turn_id));
                                            m.insert("reconciled".into(), json!(true));
                                            m
                                        }),
                                    );
                                    marker_already
                                })
                            }
                        },
                        Some(clock.clone()),
                    )
                    .await;
                    if let OpResult::Ok {
                        value: marker_already,
                    } = mark
                    {
                        pending_boundary = Some(BoundaryRow {
                            continuation_turn_id: turn_id.clone(),
                            attempt_id: facts.attempt_id.clone(),
                            status: super::store::BoundaryStatus::Pending,
                            marker_persisted: marker_already,
                            last_stage: "force_turn_end".into(),
                            forced_at,
                            completed_at: None,
                        });
                        forced_from_pending = pending_boundary_as_forced(pending_boundary.as_ref());
                    }
                }
            }
        }
    }

    // Quiet skip paths (not at seam / transport / epoch) — no claim
    if !at_seam || transport_retry || !epoch_ok {
        let owns_writer = durable_writer.claim == WriterClaimKind::Lhc
            && durable_writer.attempt_id.as_deref() == Some(facts.attempt_id.as_str());
        let release_writer = owns_writer && !owns_pending;
        let oracle_writer = if owns_writer {
            WriterClaim::Lhc
        } else {
            WriterClaim::None
        };
        let decision = decide_compact_continuation(&build_oracle_input(
            &facts,
            CompactContinuationInvariants {
                capture_complete: facts.capture_complete,
                provider_identity_valid: facts.provider_identity_valid,
                single_open_turn,
                writer_claim: oracle_writer,
            },
            ForcedContinuationBoundary::NotApplied(ForcedContinuationBoundaryNotApplied {
                applied: false,
            }),
            empty_material(),
        ));
        return finalize_attempt(
            ref_,
            &facts,
            decision,
            FinalizeOpts {
                release_writer,
                terminal: !owns_pending,
                boundary_update: None,
                forced_boundary_this_attempt: false,
                continuation_turn_id: None,
                compact_receipt: None,
            },
            clock,
            hooks.as_ref(),
        )
        .await;
    }

    // Health / tool pair
    let mut tool_pair_ok = true;
    if let WorkContinuation::PendingCorrelatedToolResult {
        tool_call_id,
        correlation_valid,
    } = &facts.continuation
    {
        if *correlation_valid {
            let proof = create_db_read_transaction(ref_.clone(), {
                let tool_call_id = tool_call_id.clone();
                move |tx| Box::pin(async move { prove_pending_tool_pair(tx.db, &tool_call_id) })
            })
            .await;
            let OpResult::Ok { value: proof } = proof else {
                return match proof {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { .. } => unreachable!(),
                };
            };
            tool_pair_ok = matches!(proof, ToolPairProof::Ok { .. });
        } else {
            tool_pair_ok = false;
        }
    }

    let health_bad = !facts.capture_complete
        || !facts.provider_identity_valid
        || !single_open_turn
        || matches!(
            facts.writer_claim,
            WriterClaim::Native | WriterClaim::Conflict
        );

    // Writer held by foreign attempt
    if durable_writer.claim == WriterClaimKind::Lhc
        && durable_writer.attempt_id.as_deref() != Some(facts.attempt_id.as_str())
        && durable_writer.attempt_id.is_some()
    {
        let owner = durable_writer.attempt_id.clone().unwrap_or_default();
        return caller_error(
            ErrorCode::CompactContinuationWriterConflict,
            format!(
                "cannot claim LHC writer for attempt {}; held by attempt {} — resume with that attemptId",
                facts.attempt_id, owner
            ),
        );
    }

    if health_bad || !tool_pair_ok {
        let mut cont = facts.continuation.clone();
        if !tool_pair_ok {
            if let WorkContinuation::PendingCorrelatedToolResult { tool_call_id, .. } =
                &facts.continuation
            {
                cont = WorkContinuation::PendingCorrelatedToolResult {
                    tool_call_id: tool_call_id.clone(),
                    correlation_valid: false,
                };
            }
        }
        let mut facts_health = facts.clone();
        facts_health.continuation = cont;
        let owns_writer = durable_writer.claim == WriterClaimKind::Lhc
            && durable_writer.attempt_id.as_deref() == Some(facts.attempt_id.as_str());
        let release_writer = owns_writer && !owns_pending;
        let oracle_writer = if owns_writer {
            WriterClaim::Lhc
        } else {
            WriterClaim::None
        };
        let forced = if matches!(forced_from_pending, ForcedContinuationBoundary::Applied(_))
            && matches!(facts.continuation, WorkContinuation::ActiveNonTool)
        {
            forced_from_pending.clone()
        } else {
            ForcedContinuationBoundary::NotApplied(ForcedContinuationBoundaryNotApplied {
                applied: false,
            })
        };
        let decision = decide_compact_continuation(&build_oracle_input(
            &facts_health,
            CompactContinuationInvariants {
                capture_complete: facts.capture_complete,
                provider_identity_valid: facts.provider_identity_valid,
                single_open_turn,
                writer_claim: oracle_writer,
            },
            forced,
            empty_material(),
        ));
        return finalize_attempt(
            ref_,
            &facts,
            decision.clone(),
            FinalizeOpts {
                release_writer,
                terminal: !owns_pending,
                boundary_update: None,
                forced_boundary_this_attempt: false,
                continuation_turn_id: decision.receipt.residual.continuation_turn_id.clone(),
                compact_receipt: None,
            },
            clock,
            hooks.as_ref(),
        )
        .await;
    }

    // Pressure / branch
    let pressure = pressure_at_or_above(&facts);
    let needs_continue_turn = matches!(forced_from_pending, ForcedContinuationBoundary::Applied(_))
        || (pressure == Some(true)
            && matches!(facts.continuation, WorkContinuation::ActiveNonTool));
    let needs_preserve_tool =
        !matches!(forced_from_pending, ForcedContinuationBoundary::Applied(_))
            && pressure == Some(true)
            && matches!(
                facts.continuation,
                WorkContinuation::PendingCorrelatedToolResult { .. }
            )
            && tool_pair_ok;

    if !needs_continue_turn && !needs_preserve_tool {
        let owns_writer = durable_writer.claim == WriterClaimKind::Lhc
            && durable_writer.attempt_id.as_deref() == Some(facts.attempt_id.as_str());
        let release_writer = owns_writer && !owns_pending;
        let oracle_writer = if owns_writer {
            WriterClaim::Lhc
        } else {
            WriterClaim::None
        };
        let decision = decide_compact_continuation(&build_oracle_input(
            &facts,
            CompactContinuationInvariants {
                capture_complete: facts.capture_complete,
                provider_identity_valid: facts.provider_identity_valid,
                single_open_turn,
                writer_claim: oracle_writer,
            },
            ForcedContinuationBoundary::NotApplied(ForcedContinuationBoundaryNotApplied {
                applied: false,
            }),
            empty_material(),
        ));
        return finalize_attempt(
            ref_,
            &facts,
            decision,
            FinalizeOpts {
                release_writer,
                terminal: !owns_pending,
                boundary_update: None,
                forced_boundary_this_attempt: false,
                continuation_turn_id: None,
                compact_receipt: None,
            },
            clock,
            hooks.as_ref(),
        )
        .await;
    }

    // Claim writer for compact paths
    let claim_result = create_db_write_transaction(
        ref_.clone(),
        {
            let attempt_id = facts.attempt_id.clone();
            let clock = clock.clone();
            move |tx| {
                Box::pin(async move {
                    let claimed = claim_lhc_writer(tx.db, &attempt_id, &clock_iso(&clock));
                    if claimed {
                        append_stage_log(
                            tx.db,
                            &attempt_id,
                            StageName::ClaimedWriter,
                            &clock_iso(&clock),
                            None,
                        );
                    }
                    claimed
                })
            }
        },
        Some(clock.clone()),
    )
    .await;
    let OpResult::Ok { value: claimed } = claim_result else {
        return match claim_result {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    if !claimed {
        let held = create_db_read_transaction(ref_.clone(), |tx| {
            Box::pin(async move { read_writer_claim(tx.db) })
        })
        .await;
        let OpResult::Ok { value: held } = held else {
            return match held {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        return caller_error(
            ErrorCode::CompactContinuationWriterConflict,
            format!(
                "cannot claim LHC writer for attempt {}; held by attempt {} — resume with that attemptId",
                facts.attempt_id,
                held.attempt_id.unwrap_or_else(|| "unknown".into())
            ),
        );
    }

    // Compact paths: prepare + install with branch-specific handling.
    // Full force-turn / marker sequence for continue-turn; preserve-tool skips marker.
    let run_result = execute_compact_paths(
        ref_,
        &facts,
        clock,
        hooks.as_ref(),
        needs_continue_turn,
        needs_preserve_tool,
        forced_from_pending,
        pending_boundary,
        force_intent,
    )
    .await;
    run_result
}

async fn read_attempt_for_hash_check(
    ref_: ThreadRef,
    attempt_id: &str,
) -> Option<OpResult<Option<super::store::AttemptRow>>> {
    let attempt_id = attempt_id.to_string();
    Some(
        create_db_read_transaction(ref_, move |tx| {
            Box::pin(async move { super::store::read_attempt_intent(tx.db, &attempt_id) })
        })
        .await,
    )
}

/// Continue-turn and preserve-tool mutation paths after writer claim.
async fn execute_compact_paths(
    ref_: ThreadRef,
    facts: &CompactContinuationHostFacts,
    clock: Clock,
    hooks: Option<&CompactContinuationTestHooks>,
    needs_continue_turn: bool,
    _needs_preserve_tool: bool,
    mut forced_continuation_boundary: ForcedContinuationBoundary,
    pending_boundary: Option<BoundaryRow>,
    force_intent: Option<super::store::ForceIntentRow>,
) -> OpResult<CompactContinuationRunResult> {
    let mut forced_boundary_this_attempt = false;
    let mut continuation_turn_id = pending_boundary
        .as_ref()
        .map(|b| b.continuation_turn_id.clone());
    let mut compact_receipt: Option<CompactReceipt> = None;
    let mut material = empty_material();
    let mut boundary_forced_at = pending_boundary
        .as_ref()
        .map(|b| b.forced_at.clone())
        .unwrap_or_else(|| clock_iso(&clock));
    let mut marker_persisted_durable = pending_boundary
        .as_ref()
        .map(|b| b.marker_persisted)
        .unwrap_or(false);

    // Force boundary for fresh continue-turn
    if needs_continue_turn
        && !matches!(
            forced_continuation_boundary,
            ForcedContinuationBoundary::Applied(_)
        )
    {
        let open_check = create_db_read_transaction(ref_.clone(), |tx| {
            Box::pin(async move {
                let ids = read_open_turn_ids(tx.db);
                if ids.len() != 1 {
                    return (false, 0i64);
                }
                (true, read_open_turn_member_count(tx.db, &ids[0]))
            })
        })
        .await;
        let OpResult::Ok { value: (ok, count) } = open_check else {
            let _ =
                release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone()).await;
            return match open_check {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        if !ok || count == 0 {
            let decision = decide_compact_continuation(&build_oracle_input(
                facts,
                CompactContinuationInvariants {
                    capture_complete: true,
                    provider_identity_valid: true,
                    single_open_turn: true,
                    writer_claim: WriterClaim::Lhc,
                },
                ForcedContinuationBoundary::NotApplied(ForcedContinuationBoundaryNotApplied {
                    applied: false,
                }),
                empty_material(),
            ));
            return finalize_attempt(
                ref_,
                facts,
                decision,
                FinalizeOpts {
                    release_writer: true,
                    terminal: true,
                    boundary_update: None,
                    forced_boundary_this_attempt: false,
                    continuation_turn_id: None,
                    compact_receipt: None,
                },
                clock,
                hooks,
            )
            .await;
        }

        let turn_end_key = turn_end_idempotency_key(&facts.attempt_id);
        let existing_turn = create_db_read_transaction(ref_.clone(), {
            let turn_end_key = turn_end_key.clone();
            move |tx| {
                Box::pin(async move { find_continuation_turn_from_force_key(tx.db, &turn_end_key) })
            }
        })
        .await;
        let OpResult::Ok {
            value: existing_turn,
        } = existing_turn
        else {
            let _ =
                release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone()).await;
            return match existing_turn {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };

        if let Some(turn_id) = existing_turn {
            continuation_turn_id = Some(turn_id.clone());
            forced_boundary_this_attempt = false;
            boundary_forced_at = force_intent
                .as_ref()
                .map(|f| f.recorded_at.clone())
                .unwrap_or_else(|| clock_iso(&clock));
            let bound = create_db_write_transaction(
                ref_.clone(),
                {
                    let turn_id = turn_id.clone();
                    let attempt_id = facts.attempt_id.clone();
                    let forced_at = boundary_forced_at.clone();
                    let clock = clock.clone();
                    move |tx| {
                        Box::pin(async move {
                            let marker_already = marker_exists_by_idempotency_key(
                                tx.db,
                                &compact_continuation_marker_idempotency_key(&turn_id),
                            );
                            upsert_boundary(
                                tx.db,
                                &turn_id,
                                &attempt_id,
                                super::store::BoundaryStatus::Pending,
                                marker_already,
                                "force_turn_end",
                                &forced_at,
                                None,
                            );
                            mark_force_intent_applied(tx.db, &attempt_id, &turn_id);
                            append_stage_log(
                                tx.db,
                                &attempt_id,
                                StageName::ForceTurnEnd,
                                &clock_iso(&clock),
                                Some(&{
                                    let mut m = Map::new();
                                    m.insert("continuationTurnId".into(), json!(turn_id));
                                    m.insert("reconciled".into(), json!(true));
                                    m
                                }),
                            );
                            marker_already
                        })
                    }
                },
                Some(clock.clone()),
            )
            .await;
            let OpResult::Ok {
                value: marker_already,
            } = bound
            else {
                let _ = release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                    .await;
                return match bound {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { .. } => unreachable!(),
                };
            };
            marker_persisted_durable = marker_already;
            forced_continuation_boundary =
                ForcedContinuationBoundary::Applied(ForcedContinuationBoundaryApplied {
                    applied: true,
                    continuation_turn_id: turn_id,
                    forced_this_seam: false,
                    marker_already_persisted: marker_already,
                });
        } else {
            // Force intent + turn_end + boundary
            let intent_rec = create_db_write_transaction(
                ref_.clone(),
                {
                    let attempt_id = facts.attempt_id.clone();
                    let turn_end_key = turn_end_key.clone();
                    let clock = clock.clone();
                    move |tx| {
                        Box::pin(async move {
                            record_force_intent(
                                tx.db,
                                &attempt_id,
                                &turn_end_key,
                                &clock_iso(&clock),
                            );
                            append_stage_log(
                                tx.db,
                                &attempt_id,
                                StageName::ForceIntent,
                                &clock_iso(&clock),
                                Some(&{
                                    let mut m = Map::new();
                                    m.insert("turnEndIdempotencyKey".into(), json!(turn_end_key));
                                    m
                                }),
                            );
                        })
                    }
                },
                Some(clock.clone()),
            )
            .await;
            if !matches!(intent_rec, OpResult::Ok { .. }) {
                let _ = release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                    .await;
                return match intent_rec {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { .. } => unreachable!(),
                };
            }

            let force_batch = intake_stream::message_events(
                ref_.clone(),
                &[turn_end_event_input(facts, &facts.attempt_id)],
            )
            .await;
            if !matches!(force_batch, OpResult::Ok { .. }) {
                let _ = release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                    .await;
                return match force_batch {
                    OpResult::Err { error } => {
                        if error.code == ErrorCode::StorageFailure
                            || error.code == ErrorCode::InvalidEvent
                        {
                            OpResult::Err { error }
                        } else {
                            attempt_conflict(
                                &facts.attempt_id,
                                &facts.attempt_id,
                                &format!(
                                    "attemptId {} cannot force a new boundary (turn_end already recorded)",
                                    facts.attempt_id
                                ),
                            )
                        }
                    }
                    OpResult::Ok { .. } => unreachable!(),
                };
            }

            if hooks.is_some_and(|h| h.interrupt_after_turn_end_commit) {
                let _ = stage_log(
                    ref_.clone(),
                    &facts.attempt_id,
                    StageName::Interrupted,
                    clock.clone(),
                    Some({
                        let mut m = Map::new();
                        m.insert("after".into(), json!("turn_end_commit"));
                        m.insert("forceIntent".into(), json!(true));
                        m
                    }),
                )
                .await;
                let decision = decide_compact_continuation(&build_oracle_input(
                    facts,
                    CompactContinuationInvariants {
                        capture_complete: true,
                        provider_identity_valid: true,
                        single_open_turn: true,
                        writer_claim: WriterClaim::Lhc,
                    },
                    ForcedContinuationBoundary::NotApplied(ForcedContinuationBoundaryNotApplied {
                        applied: false,
                    }),
                    {
                        let mut m = empty_material();
                        m.compact_structurally_valid = false;
                        m.can_produce_valid_provider_request = false;
                        m
                    },
                ));
                return finalize_attempt(
                    ref_,
                    facts,
                    decision,
                    FinalizeOpts {
                        release_writer: false,
                        terminal: false,
                        boundary_update: None,
                        forced_boundary_this_attempt: false,
                        continuation_turn_id: None,
                        compact_receipt: None,
                    },
                    clock,
                    hooks,
                )
                .await;
            }

            let opened = create_db_read_transaction(ref_.clone(), {
                let turn_end_key = turn_end_key.clone();
                move |tx| {
                    Box::pin(
                        async move { find_continuation_turn_from_force_key(tx.db, &turn_end_key) },
                    )
                }
            })
            .await;
            let OpResult::Ok {
                value: Some(turn_id),
            } = opened
            else {
                let _ = release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                    .await;
                return match opened {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { value: None } => {
                        storage_failure("force turn_end did not open a continuation turn")
                    }
                    OpResult::Ok { .. } => unreachable!(),
                };
            };
            continuation_turn_id = Some(turn_id.clone());
            forced_boundary_this_attempt = true;
            boundary_forced_at = clock_iso(&clock);
            let bound = create_db_write_transaction(
                ref_.clone(),
                {
                    let turn_id = turn_id.clone();
                    let attempt_id = facts.attempt_id.clone();
                    let forced_at = boundary_forced_at.clone();
                    let clock = clock.clone();
                    move |tx| {
                        Box::pin(async move {
                            upsert_boundary(
                                tx.db,
                                &turn_id,
                                &attempt_id,
                                super::store::BoundaryStatus::Pending,
                                false,
                                "force_turn_end",
                                &forced_at,
                                None,
                            );
                            mark_force_intent_applied(tx.db, &attempt_id, &turn_id);
                            append_stage_log(
                                tx.db,
                                &attempt_id,
                                StageName::ForceTurnEnd,
                                &clock_iso(&clock),
                                Some(&{
                                    let mut m = Map::new();
                                    m.insert("continuationTurnId".into(), json!(turn_id));
                                    m
                                }),
                            );
                        })
                    }
                },
                Some(clock.clone()),
            )
            .await;
            if !matches!(bound, OpResult::Ok { .. }) {
                let _ = release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                    .await;
                return match bound {
                    OpResult::Err { error } => OpResult::Err { error },
                    OpResult::Ok { .. } => unreachable!(),
                };
            }
            forced_continuation_boundary =
                ForcedContinuationBoundary::Applied(ForcedContinuationBoundaryApplied {
                    applied: true,
                    continuation_turn_id: turn_id,
                    forced_this_seam: true,
                    marker_already_persisted: false,
                });
        }
    }

    if hooks.is_some_and(|h| h.interrupt_after_boundary) {
        let _ = stage_log(
            ref_.clone(),
            &facts.attempt_id,
            StageName::Interrupted,
            clock.clone(),
            Some({
                let mut m = Map::new();
                m.insert("after".into(), json!("boundary"));
                m
            }),
        )
        .await;
        let decision = decide_compact_continuation(&build_oracle_input(
            facts,
            CompactContinuationInvariants {
                capture_complete: true,
                provider_identity_valid: true,
                single_open_turn: true,
                writer_claim: WriterClaim::Lhc,
            },
            forced_continuation_boundary.clone(),
            empty_material(),
        ));
        return finalize_attempt(
            ref_,
            facts,
            decision,
            FinalizeOpts {
                release_writer: false,
                terminal: false,
                boundary_update: None,
                forced_boundary_this_attempt,
                continuation_turn_id: continuation_turn_id.clone(),
                compact_receipt: None,
            },
            clock,
            hooks,
        )
        .await;
    }

    // Prepare compact (real or skip)
    let skip_real = hooks.is_some_and(|h| h.skip_real_compact);
    let prepared = if skip_real {
        None
    } else {
        let prep_opts = CompactOpts {
            profile: facts.compact.as_ref().and_then(|c| c.profile.clone()),
            params: facts.compact.as_ref().and_then(|c| c.params.clone()),
            signal: None,
        };
        let prepared = prepare_compact(ref_.clone(), prep_opts).await;
        match prepared {
            OpResult::Ok { value } => {
                let _ = stage_log(
                    ref_.clone(),
                    &facts.attempt_id,
                    StageName::CompactPrepared,
                    clock.clone(),
                    None,
                )
                .await;
                Some(value)
            }
            OpResult::Err { error } => {
                let _ = stage_log(
                    ref_.clone(),
                    &facts.attempt_id,
                    StageName::CompactFailed,
                    clock.clone(),
                    Some({
                        let mut m = Map::new();
                        m.insert("reason".into(), json!(error.reason));
                        m
                    }),
                )
                .await;
                material.compact_structurally_valid = false;
                material.can_produce_valid_provider_request = false;
                material.install_succeeds = false;
                let decision = decide_compact_continuation(&build_oracle_input(
                    facts,
                    CompactContinuationInvariants {
                        capture_complete: true,
                        provider_identity_valid: true,
                        single_open_turn: true,
                        writer_claim: WriterClaim::Lhc,
                    },
                    forced_continuation_boundary.clone(),
                    apply_material_hooks(material, hooks),
                ));
                return finalize_attempt(
                    ref_,
                    facts,
                    decision,
                    FinalizeOpts {
                        release_writer: true,
                        terminal: true,
                        boundary_update: continuation_turn_id.as_ref().map(|tid| BoundaryUpdate {
                            continuation_turn_id: tid.clone(),
                            status: super::store::BoundaryStatus::FailedRepairable,
                            marker_persisted: marker_persisted_durable,
                            last_stage: "compact_failed".into(),
                            forced_at: boundary_forced_at.clone(),
                            completed_at: None,
                        }),
                        forced_boundary_this_attempt,
                        continuation_turn_id: continuation_turn_id.clone(),
                        compact_receipt: None,
                    },
                    clock,
                    hooks,
                )
                .await;
            }
        }
    };

    // Candidate material from prepared
    if let Some(ref prepared) = prepared {
        let lower = facts.policy.lower_target_tokens;
        let assembly = create_db_read_transaction(ref_.clone(), {
            let prepared = prepared.clone();
            move |tx| {
                Box::pin(async move { assemble_candidate_from_prepared(tx.db, &prepared, lower) })
            }
        })
        .await;
        if let OpResult::Ok { value: assembly } = assembly {
            material.derivations_missing_or_failed =
                assembly.material.derivations_missing_or_failed;
            material.lower_target_met = assembly.material.lower_target_met;
            material.compact_structurally_valid = assembly.material.compact_structurally_valid;
            material.useful_reduction = assembly.material.useful_reduction;
            material.can_produce_valid_provider_request =
                assembly.material.can_produce_valid_provider_request;
        }
    }

    material = apply_material_hooks(material, hooks);

    // Marker for continue-turn before install
    if needs_continue_turn {
        if let Some(c_turn) = continuation_turn_id.clone() {
            if !marker_persisted_durable {
                let marker_batch = intake_stream::message_events(
                    ref_.clone(),
                    &[marker_event_input(facts, &c_turn)],
                )
                .await;
                if !matches!(marker_batch, OpResult::Ok { .. }) {
                    let _ =
                        release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                            .await;
                    return match marker_batch {
                        OpResult::Err { error } => OpResult::Err { error },
                        OpResult::Ok { .. } => unreachable!(),
                    };
                }
                if hooks.is_some_and(|h| h.interrupt_after_marker_event) {
                    let _ = stage_log(
                        ref_.clone(),
                        &facts.attempt_id,
                        StageName::Interrupted,
                        clock.clone(),
                        Some({
                            let mut m = Map::new();
                            m.insert("after".into(), json!("marker_event"));
                            m
                        }),
                    )
                    .await;
                    let decision = decide_compact_continuation(&build_oracle_input(
                        facts,
                        CompactContinuationInvariants {
                            capture_complete: true,
                            provider_identity_valid: true,
                            single_open_turn: true,
                            writer_claim: WriterClaim::Lhc,
                        },
                        forced_continuation_boundary.clone(),
                        material.clone(),
                    ));
                    return finalize_attempt(
                        ref_,
                        facts,
                        decision,
                        FinalizeOpts {
                            release_writer: false,
                            terminal: false,
                            boundary_update: None,
                            forced_boundary_this_attempt,
                            continuation_turn_id: Some(c_turn),
                            compact_receipt: None,
                        },
                        clock,
                        hooks,
                    )
                    .await;
                }
                let status_write = create_db_write_transaction(
                    ref_.clone(),
                    {
                        let c_turn = c_turn.clone();
                        let attempt_id = facts.attempt_id.clone();
                        let forced_at = boundary_forced_at.clone();
                        let clock = clock.clone();
                        move |tx| {
                            Box::pin(async move {
                                upsert_boundary(
                                    tx.db,
                                    &c_turn,
                                    &attempt_id,
                                    super::store::BoundaryStatus::Pending,
                                    true,
                                    "marker_persisted",
                                    &forced_at,
                                    None,
                                );
                                append_stage_log(
                                    tx.db,
                                    &attempt_id,
                                    StageName::MarkerPersisted,
                                    &clock_iso(&clock),
                                    None,
                                );
                            })
                        }
                    },
                    Some(clock.clone()),
                )
                .await;
                if !matches!(status_write, OpResult::Ok { .. }) {
                    let _ =
                        release_own_writer_if_held(ref_.clone(), &facts.attempt_id, clock.clone())
                            .await;
                    return match status_write {
                        OpResult::Err { error } => OpResult::Err { error },
                        OpResult::Ok { .. } => unreachable!(),
                    };
                }
                marker_persisted_durable = true;
                if hooks.is_some_and(|h| h.interrupt_after_marker) {
                    let decision = decide_compact_continuation(&build_oracle_input(
                        facts,
                        CompactContinuationInvariants {
                            capture_complete: true,
                            provider_identity_valid: true,
                            single_open_turn: true,
                            writer_claim: WriterClaim::Lhc,
                        },
                        forced_continuation_boundary.clone(),
                        material.clone(),
                    ));
                    return finalize_attempt(
                        ref_,
                        facts,
                        decision,
                        FinalizeOpts {
                            release_writer: false,
                            terminal: false,
                            boundary_update: None,
                            forced_boundary_this_attempt,
                            continuation_turn_id: Some(c_turn),
                            compact_receipt: None,
                        },
                        clock,
                        hooks,
                    )
                    .await;
                }
            }
        }
    }

    // Install
    if hooks.is_some_and(|h| h.fail_install_before_write) {
        material.install_succeeds = false;
        let decision = decide_compact_continuation(&build_oracle_input(
            facts,
            CompactContinuationInvariants {
                capture_complete: true,
                provider_identity_valid: true,
                single_open_turn: true,
                writer_claim: WriterClaim::Lhc,
            },
            forced_continuation_boundary.clone(),
            apply_material_hooks(material, hooks),
        ));
        let _ = stage_log(
            ref_.clone(),
            &facts.attempt_id,
            StageName::InstallFailed,
            clock.clone(),
            None,
        )
        .await;
        return finalize_attempt(
            ref_,
            facts,
            decision,
            FinalizeOpts {
                release_writer: true,
                terminal: true,
                boundary_update: continuation_turn_id.as_ref().map(|tid| BoundaryUpdate {
                    continuation_turn_id: tid.clone(),
                    status: super::store::BoundaryStatus::FailedRepairable,
                    marker_persisted: marker_persisted_durable,
                    last_stage: "install_failed".into(),
                    forced_at: boundary_forced_at.clone(),
                    completed_at: None,
                }),
                forced_boundary_this_attempt,
                continuation_turn_id: continuation_turn_id.clone(),
                compact_receipt: None,
            },
            clock,
            hooks,
        )
        .await;
    }

    if let Some(prepared) = prepared {
        let marker_key = if needs_continue_turn {
            continuation_turn_id
                .as_ref()
                .map(|t| compact_continuation_marker_idempotency_key(t))
        } else {
            None
        };
        let install = install_prepared_compact(
            ref_.clone(),
            prepared,
            InstallPreparedOptions {
                signal: None,
                created_at: Some(clock_iso(&clock)),
                allowed_marker_idempotency_key: marker_key,
            },
        )
        .await;
        match install {
            OpResult::Ok { value } => {
                compact_receipt = Some(value);
                material.install_succeeds = true;
                let _ = stage_log(
                    ref_.clone(),
                    &facts.attempt_id,
                    StageName::InstallSucceeded,
                    clock.clone(),
                    None,
                )
                .await;
            }
            OpResult::Err { error } => {
                material.install_succeeds = false;
                let stage = if error.code == ErrorCode::StalePreparedCompact {
                    StageName::InstallFailed
                } else {
                    StageName::InstallFailed
                };
                let _ = stage_log(
                    ref_.clone(),
                    &facts.attempt_id,
                    stage,
                    clock.clone(),
                    Some({
                        let mut m = Map::new();
                        m.insert("reason".into(), json!(error.reason));
                        m
                    }),
                )
                .await;
            }
        }
    } else {
        // skip_real_compact: treat install as hook-driven
        material.install_succeeds = hooks.and_then(|h| h.force_install_succeeds).unwrap_or(true);
    }

    material = apply_material_hooks(material, hooks);

    let decision = decide_compact_continuation(&build_oracle_input(
        facts,
        CompactContinuationInvariants {
            capture_complete: true,
            provider_identity_valid: true,
            single_open_turn: true,
            writer_claim: WriterClaim::Lhc,
        },
        forced_continuation_boundary.clone(),
        material.clone(),
    ));

    let success = material.install_succeeds
        && material.compact_structurally_valid
        && material.can_produce_valid_provider_request;

    let boundary_update = if needs_continue_turn {
        continuation_turn_id.as_ref().map(|tid| BoundaryUpdate {
            continuation_turn_id: tid.clone(),
            status: if success {
                super::store::BoundaryStatus::Complete
            } else {
                super::store::BoundaryStatus::FailedRepairable
            },
            marker_persisted: marker_persisted_durable,
            last_stage: if success {
                "install_succeeded".into()
            } else {
                "install_failed".into()
            },
            forced_at: boundary_forced_at.clone(),
            completed_at: if success {
                Some(clock_iso(&clock))
            } else {
                None
            },
        })
    } else {
        None
    };

    finalize_attempt(
        ref_,
        facts,
        decision,
        FinalizeOpts {
            release_writer: true,
            terminal: success || !needs_continue_turn,
            boundary_update,
            forced_boundary_this_attempt,
            continuation_turn_id: continuation_turn_id.clone(),
            compact_receipt,
        },
        clock,
        hooks,
    )
    .await
}

// ── Inspect APIs ────────────────────────────────────────────────────────────

pub async fn get_compact_continuation_receipt(
    ref_: ThreadRef,
    attempt_id: &str,
) -> OpResult<Option<StoredCompactContinuationReceipt>> {
    let attempt_id = attempt_id.to_string();
    create_db_read_transaction(ref_, move |tx| {
        Box::pin(async move { read_receipt_by_attempt_id(tx.db, &attempt_id) })
    })
    .await
}

pub async fn list_compact_continuation_receipts(
    ref_: ThreadRef,
    limit: Option<i64>,
) -> OpResult<Vec<StoredCompactContinuationReceipt>> {
    let limit = limit.unwrap_or(50);
    create_db_read_transaction(ref_, move |tx| {
        Box::pin(async move { list_receipts(tx.db, limit) })
    })
    .await
}

pub async fn get_compact_continuation_writer_claim(ref_: ThreadRef) -> OpResult<WriterClaimRow> {
    create_db_read_transaction(ref_, |tx| Box::pin(async move { read_writer_claim(tx.db) })).await
}

pub async fn has_compact_continuation_marker(
    ref_: ThreadRef,
    continuation_turn_id: &str,
) -> OpResult<bool> {
    let key = compact_continuation_marker_idempotency_key(continuation_turn_id);
    create_db_read_transaction(ref_, move |tx| {
        Box::pin(async move { marker_exists_by_idempotency_key(tx.db, &key) })
    })
    .await
}

pub async fn get_pending_compact_continuation_boundary(
    ref_: ThreadRef,
) -> OpResult<Option<BoundaryRow>> {
    create_db_read_transaction(ref_, |tx| {
        Box::pin(async move { read_pending_boundary(tx.db) })
    })
    .await
}

pub async fn list_compact_continuation_boundaries(ref_: ThreadRef) -> OpResult<Vec<BoundaryRow>> {
    create_db_read_transaction(ref_, |tx| Box::pin(async move { list_boundaries(tx.db) })).await
}

pub async fn list_compact_continuation_stages(
    ref_: ThreadRef,
    attempt_id: &str,
) -> OpResult<Vec<super::store::StageLogEntry>> {
    let attempt_id = attempt_id.to_string();
    create_db_read_transaction(ref_, move |tx| {
        Box::pin(async move { list_stage_log(tx.db, &attempt_id) })
    })
    .await
}
