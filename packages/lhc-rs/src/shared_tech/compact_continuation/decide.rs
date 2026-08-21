//! Pure compact-continuation decision function — whole-seam parity/receipt oracle.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/decide.ts`.
//! Deterministic: same input ⇒ same Decision (including transition path and
//! ordered effects). No I/O.
//!
//! ## CX-S5: no stop in the compact path
//!
//! Compact is the recovery mechanism, not the thing you recover from. No
//! condition here refuses. Every former refusal is one of:
//! - **warn + continue** — the seam compacts with a loud diagnostic
//!   (incomplete capture, unproven provider identity, unverified open-turn
//!   invariant, unsafe projected runway, unproven provider request, failed host
//!   body validation);
//! - **bounded retry** — a failed compact or install retries within budget and
//!   then continues on the current body;
//! - **decline into ordinary compact** — the continuation machinery hands the
//!   seam to the host's ordinary settled-seam compact on canonical turns
//!   (uncorrelatable tool pairs, invalid protected pair set, unknown contract
//!   version, unavailable continuation boundary);
//! - **discard and start fresh** — an unusable pending forced boundary;
//! - **reclaim or continue** — a stale writer row is reclaimed under host
//!   ownership authority; a live loser continues its current request.
//!
//! Effect ordering is canonical: everything the seam *detected* (boundary
//! discard, writer reclaim, warnings) precedes everything the seam *did*
//! (claim writer, force boundary, compact, marker, install, receipt, release).
//!
//! ## Effects vs residual
//!
//! `effects` is the prescribed whole-seam protocol. `residual` records what
//! actually completed on interruption/repair paths. Do not reinterpret effects
//! as proof that each action already committed (LIM-63).

use super::contract::{
    COMPACT_CONTINUATION_CONTRACT_VERSION, COMPACT_CONTINUATION_MARKER_KIND,
    CONTEXT_COMPACT_CONTINUE_REASON, ClaimWriterTarget, CompactContinuationDecision,
    CompactContinuationEffect, CompactContinuationInput, CompactContinuationLowerTargetReceipt,
    CompactContinuationMarkerSemantics, CompactContinuationOutcomeKind,
    CompactContinuationPressureReceipt, CompactContinuationReceipt,
    CompactContinuationReceiptContinuation, CompactContinuationReliefPath,
    CompactContinuationResidualState, CompactContinuationRetryReceipt, CompactContinuationSkipCode,
    CompactContinuationState, CompactContinuationWarning, CompactContinuationWarningCode,
    DEFAULT_COMPACT_RETRY_BUDGET, ForcedContinuationBoundary, ForcedContinuationBoundaryApplied,
    HostValidationStatusFact, ReclaimHostAuthority, ReclaimPriorClaim, WorkContinuation,
    WriterClaim, WriterOwnershipAuthority, compact_continuation_marker_idempotency_key,
    normalize_protected_tool_call_ids,
};

fn is_applied_boundary(
    b: &ForcedContinuationBoundary,
) -> Option<&ForcedContinuationBoundaryApplied> {
    b.as_applied()
}

/// Ordered facts the seam detected before it did anything: a discarded pending
/// boundary, a reclaimed stale writer row, and every degradation warning. These
/// effects lead the receipt's effect list on every terminal path.
#[derive(Default, Clone)]
struct SeamPrelude {
    effects: Vec<CompactContinuationEffect>,
    boundary_discarded: bool,
}

fn warn(code: CompactContinuationWarningCode, reason: &str) -> CompactContinuationEffect {
    CompactContinuationEffect::Warn {
        code,
        reason: reason.to_string(),
    }
}

/// Receipt warnings are the `warn` effects, in the order they were detected.
fn warnings_of(effects: &[CompactContinuationEffect]) -> Vec<CompactContinuationWarning> {
    effects
        .iter()
        .filter_map(|e| match e {
            CompactContinuationEffect::Warn { code, reason } => Some(CompactContinuationWarning {
                code: *code,
                reason: reason.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// Effective bounded retry budget. A failed attempt is never terminal, so min 1.
fn retry_budget_of(input: &CompactContinuationInput) -> i64 {
    match input.policy.compact_retry_budget {
        Some(raw) => raw.max(1),
        None => DEFAULT_COMPACT_RETRY_BUDGET,
    }
}

fn attempt_index_of(input: &CompactContinuationInput) -> i64 {
    match input.compact_material.compact_attempt_index {
        Some(raw) => raw.max(1),
        None => 1,
    }
}

/// Retry accounting for a seam where no compact/install attempt failed.
fn no_retry(input: &CompactContinuationInput) -> CompactContinuationRetryReceipt {
    CompactContinuationRetryReceipt {
        attempt_index: attempt_index_of(input),
        budget: retry_budget_of(input),
        retry_authorized: false,
    }
}

/// Combine provider total + labelled estimate without panicking.
///
/// Validated inputs (via `as_compact_continuation_input`) guarantee the sum is a
/// safe non-negative integer within `Number.MAX_SAFE_INTEGER`, so `checked_add`
/// always succeeds on the guarded path. For hand-built typed values that overflow
/// `i64`, returns `None` so the oracle treats pressure as unavailable rather than
/// panicking — a defensive LIM-63 surface, not a redesign of valid-input semantics.
fn checked_pressure_sum(total: i64, estimate_tokens: i64) -> Option<i64> {
    total.checked_add(estimate_tokens)
}
fn pressure_receipt(input: &CompactContinuationInput) -> CompactContinuationPressureReceipt {
    let provider_usage = &input.provider_usage;
    let estimate = &input.post_measurement_estimate;
    let policy = &input.policy;
    let material = &input.compact_material;
    // Typed material always carries these facts (TS validated inputs likewise);
    // savings is a required non-negative integer, so its domain label is fixed.
    let savings = Some(material.rendered_savings_tokens);
    let savings_source = Some(material.rendered_savings_source.clone());
    let projected = material.projected_pressure_tokens;
    let safe_threshold = material.safe_runway_threshold_tokens;
    let safe_source = material.safe_runway_threshold_source.clone();
    let projected_safe = material.projected_pressure_safe;

    match provider_usage.available_total() {
        None => CompactContinuationPressureReceipt {
            provider_base_tokens: None,
            provider_base_domain: "provider_reported_input".to_string(),
            estimate_tokens: estimate.tokens,
            estimate_source: estimate.source.clone(),
            estimate_domain: "source_labelled_estimate".to_string(),
            next_request_pressure_tokens: None,
            upper_trigger_tokens: policy.upper_trigger_tokens,
            at_or_above_trigger: None,
            projected_pressure_tokens: None,
            rendered_savings_tokens: savings,
            rendered_savings_source: savings_source,
            rendered_savings_domain: Some("source_labelled_estimate".to_string()),
            safe_runway_threshold_tokens: safe_threshold,
            safe_runway_threshold_source: safe_source,
            projected_pressure_safe: None,
        },
        Some(total) => match checked_pressure_sum(total, estimate.tokens) {
            Some(next) => {
                let projected_resolved = match projected {
                    Some(p) => Some(p),
                    None => Some((next - material.rendered_savings_tokens).max(0)),
                };
                let projected_safe_resolved = match projected_safe {
                    Some(v) => Some(v),
                    None => safe_threshold.map(|t| projected_resolved.expect("resolved above") < t),
                };
                CompactContinuationPressureReceipt {
                    provider_base_tokens: Some(total),
                    provider_base_domain: "provider_reported_input".to_string(),
                    estimate_tokens: estimate.tokens,
                    estimate_source: estimate.source.clone(),
                    estimate_domain: "source_labelled_estimate".to_string(),
                    next_request_pressure_tokens: Some(next),
                    upper_trigger_tokens: policy.upper_trigger_tokens,
                    at_or_above_trigger: Some(next >= policy.upper_trigger_tokens),
                    projected_pressure_tokens: projected_resolved,
                    rendered_savings_tokens: savings,
                    rendered_savings_source: savings_source,
                    rendered_savings_domain: Some("source_labelled_estimate".to_string()),
                    safe_runway_threshold_tokens: safe_threshold,
                    safe_runway_threshold_source: safe_source,
                    projected_pressure_safe: projected_safe_resolved,
                }
            }
            // Overflow on unvalidated hand-built input: do not invent pressure.
            None => CompactContinuationPressureReceipt {
                provider_base_tokens: Some(total),
                provider_base_domain: "provider_reported_input".to_string(),
                estimate_tokens: estimate.tokens,
                estimate_source: estimate.source.clone(),
                estimate_domain: "source_labelled_estimate".to_string(),
                next_request_pressure_tokens: None,
                upper_trigger_tokens: policy.upper_trigger_tokens,
                at_or_above_trigger: None,
                projected_pressure_tokens: None,
                rendered_savings_tokens: savings,
                rendered_savings_source: savings_source,
                rendered_savings_domain: Some("source_labelled_estimate".to_string()),
                safe_runway_threshold_tokens: safe_threshold,
                safe_runway_threshold_source: safe_source,
                projected_pressure_safe: None,
            },
        },
    }
}

fn protected_ids_of(input: &CompactContinuationInput) -> Vec<String> {
    match &input.continuation {
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids,
            ..
        } => normalize_protected_tool_call_ids(protected_tool_call_ids),
        _ => Vec::new(),
    }
}

/// Residual-extras defaults mirroring TS `emptyResidualExtras`: overrides win,
/// otherwise fall back to the compact-material facts.
#[derive(Default)]
struct ResidualExtrasOver {
    relief_path: Option<CompactContinuationReliefPath>,
    protected_tool_call_ids: Option<Vec<String>>,
    visibility_boundary_before: Option<Option<i64>>,
    visibility_boundary_after: Option<Option<i64>>,
    host_validation_status: Option<HostValidationStatusFact>,
    core_install_retained_pending_host_validation: Option<bool>,
}

struct ResidualExtras {
    relief_path: CompactContinuationReliefPath,
    protected_tool_call_ids: Vec<String>,
    visibility_boundary_before: Option<i64>,
    visibility_boundary_after: Option<i64>,
    host_validation_status: HostValidationStatusFact,
    core_install_retained_pending_host_validation: bool,
}

fn residual_extras(input: &CompactContinuationInput, over: ResidualExtrasOver) -> ResidualExtras {
    ResidualExtras {
        relief_path: over
            .relief_path
            .unwrap_or(CompactContinuationReliefPath::None),
        protected_tool_call_ids: over
            .protected_tool_call_ids
            .unwrap_or_else(|| protected_ids_of(input)),
        visibility_boundary_before: over
            .visibility_boundary_before
            .unwrap_or(input.compact_material.visibility_boundary_before),
        visibility_boundary_after: over
            .visibility_boundary_after
            .unwrap_or(input.compact_material.visibility_boundary_after),
        host_validation_status: over
            .host_validation_status
            .unwrap_or(input.compact_material.host_validation_status),
        core_install_retained_pending_host_validation: over
            .core_install_retained_pending_host_validation
            .unwrap_or(false),
    }
}

/// Base residual with default extras, mirroring TS literal + `...emptyResidualExtras(input)`.
#[allow(clippy::too_many_arguments)] // mirrors the TS residual literal field list
fn base_residual(
    input: &CompactContinuationInput,
    writer_released: bool,
    prior_serving_view_intact: bool,
    forced_continuation_boundary_applied: bool,
    continuation_turn_opened: bool,
    continuation_turn_id: Option<String>,
    marker_persisted: bool,
    marker_served: bool,
    original_agentic_turn_still_open: bool,
    // `None` mirrors a TS call-site literal that omitted `pendingBoundaryDiscarded`
    // (skip / attempt-failure paths): the value is false and it serializes last.
    pending_boundary_discarded: Option<bool>,
    next_provider_request_allowed: bool,
    over: ResidualExtrasOver,
) -> CompactContinuationResidualState {
    let extras = residual_extras(input, over);
    CompactContinuationResidualState {
        writer_released,
        prior_serving_view_intact,
        forced_continuation_boundary_applied,
        continuation_turn_opened,
        continuation_turn_id,
        marker_persisted,
        marker_served,
        original_agentic_turn_still_open,
        pending_boundary_discarded: pending_boundary_discarded.unwrap_or(false),
        next_provider_request_allowed,
        relief_path: extras.relief_path,
        protected_tool_call_ids: extras.protected_tool_call_ids,
        visibility_boundary_before: extras.visibility_boundary_before,
        visibility_boundary_after: extras.visibility_boundary_after,
        host_validation_status: extras.host_validation_status,
        core_install_retained_pending_host_validation: extras
            .core_install_retained_pending_host_validation,
        pending_boundary_discarded_trailing: pending_boundary_discarded.is_none(),
    }
}

fn lower_target_receipt(
    input: &CompactContinuationInput,
    compact_ran: bool,
) -> CompactContinuationLowerTargetReceipt {
    CompactContinuationLowerTargetReceipt {
        domain: "lhc_rendered_history".to_string(),
        tokens: input.policy.lower_target_tokens,
        met: if compact_ran {
            Some(input.compact_material.lower_target_met)
        } else {
            None
        },
        is_success_gate: false,
    }
}

/// Applied forced-boundary residual facts must remain truthful on skip/decline
/// exits that never reach repair compact.
///
/// `markerAlreadyPersisted` is trusted only on repair (`forcedThisSeam: false`).
/// A fresh force (`forcedThisSeam: true`) just minted the continuation turn id,
/// so its boundary-derived marker cannot already exist — never OR an untrusted
/// fresh+already-persisted claim back to residual true.
fn applied_boundary_residual_overlay(
    input: &CompactContinuationInput,
    mut base: CompactContinuationResidualState,
) -> CompactContinuationResidualState {
    let Some(boundary) = is_applied_boundary(&input.forced_continuation_boundary) else {
        return base;
    };
    let trust_prior_marker = !boundary.forced_this_seam && boundary.marker_already_persisted;
    base.forced_continuation_boundary_applied = true;
    base.continuation_turn_opened = true;
    base.continuation_turn_id = Some(boundary.continuation_turn_id.clone());
    // Residual marker presence: already-persisted fact at entry (repair only).
    base.marker_persisted = base.marker_persisted || trust_prior_marker;
    base.original_agentic_turn_still_open = false;
    base
}

/// After a supported input has reached the settled seam and carries
/// `writerClaim: "lhc"`, a decline must still record the idempotent claim_writer
/// and a final release_writer when residual says writerReleased. Never claim or
/// release native/conflict writers.
fn decline_effects(
    input: &CompactContinuationInput,
    prelude: &SeamPrelude,
    code: CompactContinuationWarningCode,
    reason: &str,
) -> Vec<CompactContinuationEffect> {
    let mut effects = prelude.effects.clone();
    effects.push(warn(code, reason));
    if input.invariants.writer_claim == WriterClaim::Lhc {
        effects.push(CompactContinuationEffect::ClaimWriter {
            writer: ClaimWriterTarget::Lhc,
        });
    }
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    if input.invariants.writer_claim == WriterClaim::Lhc {
        effects.push(CompactContinuationEffect::ReleaseWriter);
    }
    effects
}

fn residual_marker_persisted(input: &CompactContinuationInput, attempt_persisted: bool) -> bool {
    let Some(boundary) = is_applied_boundary(&input.forced_continuation_boundary) else {
        return attempt_persisted;
    };
    // Fresh force cannot already hold a marker; only repair prior-marker is residual fact.
    let prior = !boundary.forced_this_seam && boundary.marker_already_persisted;
    attempt_persisted || prior
}

struct DecideParts {
    outcome: CompactContinuationOutcomeKind,
    terminal_state: CompactContinuationState,
    transition_path: Vec<CompactContinuationState>,
    effects: Vec<CompactContinuationEffect>,
    reason_code: String,
    turn_end_reason: Option<String>,
    fidelity: String,
    degradation_reasons: Vec<String>,
    continuation: CompactContinuationReceiptContinuation,
    residual: CompactContinuationResidualState,
    retry: Option<CompactContinuationRetryReceipt>,
    skipped: bool,
    skip_code: Option<CompactContinuationSkipCode>,
    compact_ran: bool,
}

fn base_receipt(
    input: &CompactContinuationInput,
    parts: &DecideParts,
) -> CompactContinuationReceipt {
    CompactContinuationReceipt {
        contract_version: COMPACT_CONTINUATION_CONTRACT_VERSION.to_string(),
        outcome: parts.outcome,
        reason_code: parts.reason_code.clone(),
        turn_end_reason: parts.turn_end_reason.clone(),
        pressure: pressure_receipt(input),
        lower_target: lower_target_receipt(input, parts.compact_ran),
        fidelity: parts.fidelity.clone(),
        degradation_reasons: parts.degradation_reasons.clone(),
        warnings: warnings_of(&parts.effects),
        retry: parts.retry.clone().unwrap_or_else(|| no_retry(input)),
        continuation: parts.continuation.clone(),
        relief_path: parts.residual.relief_path,
        protected_tool_call_ids: parts.residual.protected_tool_call_ids.clone(),
        effects: parts.effects.clone(),
        residual: parts.residual.clone(),
        // The refuse set is empty in this contract version (CX-S5).
        refused: false,
        refuse_code: None,
        skipped: parts.skipped,
        skip_code: parts.skip_code,
        transition_path: parts.transition_path.clone(),
    }
}

fn decide(input: &CompactContinuationInput, parts: DecideParts) -> CompactContinuationDecision {
    let receipt = base_receipt(input, &parts);
    CompactContinuationDecision {
        outcome: parts.outcome,
        terminal_state: parts.terminal_state,
        transition_path: parts.transition_path,
        effects: parts.effects,
        receipt,
    }
}

/// Decline into the host's ordinary settled-seam compact on canonical state.
///
/// The continuation machinery performs no mutation and claims no relief; the
/// canonical turns are schema-stable and compact through the ordinary path. The
/// next provider request is authorized — declining is a recovery path, not a stop.
fn decline_to_ordinary(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    prelude: &SeamPrelude,
    code: CompactContinuationWarningCode,
    reason: &str,
) -> CompactContinuationDecision {
    let effects = decline_effects(input, prelude, code, reason);
    let applied = is_applied_boundary(&input.forced_continuation_boundary).is_some();
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalDeclineOrdinary);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::DeclineToOrdinaryCompact,
            terminal_state: CompactContinuationState::TerminalDeclineOrdinary,
            transition_path,
            effects,
            reason_code: code.as_str().to_string(),
            turn_end_reason: if applied {
                Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string())
            } else {
                None
            },
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: applied,
                marker_served: false,
                same_agentic_turn_preserved: !applied,
            },
            residual: applied_boundary_residual_overlay(
                input,
                base_residual(
                    input,
                    true,
                    true,
                    false,
                    false,
                    None,
                    false,
                    false,
                    true,
                    Some(prelude.boundary_discarded),
                    // Declining hands the seam to the ordinary compact path — never strands.
                    true,
                    ResidualExtrasOver::default(),
                ),
            ),
            retry: None,
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}

/// Unknown contract version: degrade by **feature omission** (R22).
///
/// The oracle does not interpret a single byte of version-specific continuation
/// state — misreading it risks semantic corruption. Continuation state is
/// treated as absent in its entirety: the pending boundary is discarded, the
/// continuation machinery is skipped, and the host's ordinary compact runs on
/// canonical turns. No partial parse, no guessing.
fn decline_unsupported_version(input: &CompactContinuationInput) -> CompactContinuationDecision {
    let rejected = input.contract_version.clone();
    let reason = format!(
        "unsupported compact-continuation contract version {rejected}; oracle is {COMPACT_CONTINUATION_CONTRACT_VERSION} — continuation state omitted in its entirety, ordinary compact runs on canonical turns"
    );
    let effects = vec![
        CompactContinuationEffect::DiscardPendingBoundary {
            continuation_turn_id: None,
            reason: reason.clone(),
        },
        warn(
            CompactContinuationWarningCode::UnsupportedContractVersionOmitted,
            &reason,
        ),
        CompactContinuationEffect::RecordReceipt {
            durable: true,
            user_chat_visible: false,
        },
    ];
    let pressure = CompactContinuationPressureReceipt {
        provider_base_tokens: None,
        provider_base_domain: "provider_reported_input".to_string(),
        estimate_tokens: 0,
        estimate_source: "none".to_string(),
        estimate_domain: "source_labelled_estimate".to_string(),
        next_request_pressure_tokens: None,
        upper_trigger_tokens: 0,
        at_or_above_trigger: None,
        projected_pressure_tokens: None,
        rendered_savings_tokens: None,
        rendered_savings_source: None,
        rendered_savings_domain: None,
        safe_runway_threshold_tokens: None,
        safe_runway_threshold_source: None,
        projected_pressure_safe: None,
    };
    // Nothing below is read from the unknown-version input: continuation state is
    // absent by construction, not by interpretation.
    let residual = CompactContinuationResidualState {
        writer_released: true,
        prior_serving_view_intact: true,
        forced_continuation_boundary_applied: false,
        continuation_turn_opened: false,
        continuation_turn_id: None,
        marker_persisted: false,
        marker_served: false,
        original_agentic_turn_still_open: true,
        pending_boundary_discarded: true,
        next_provider_request_allowed: true,
        relief_path: CompactContinuationReliefPath::None,
        protected_tool_call_ids: vec![],
        visibility_boundary_before: None,
        visibility_boundary_after: None,
        host_validation_status: HostValidationStatusFact::NotRequired,
        core_install_retained_pending_host_validation: false,
        pending_boundary_discarded_trailing: false,
    };
    let transition_path = vec![
        CompactContinuationState::Idle,
        CompactContinuationState::TerminalDeclineOrdinary,
    ];
    let receipt = CompactContinuationReceipt {
        contract_version: COMPACT_CONTINUATION_CONTRACT_VERSION.to_string(),
        outcome: CompactContinuationOutcomeKind::DeclineToOrdinaryCompact,
        reason_code: format!("unsupported_contract_version_omitted:{rejected}"),
        turn_end_reason: None,
        pressure,
        lower_target: CompactContinuationLowerTargetReceipt {
            domain: "lhc_rendered_history".to_string(),
            tokens: 0,
            met: None,
            is_success_gate: false,
        },
        fidelity: "full".to_string(),
        degradation_reasons: vec![],
        warnings: warnings_of(&effects),
        retry: CompactContinuationRetryReceipt {
            attempt_index: 1,
            budget: DEFAULT_COMPACT_RETRY_BUDGET,
            retry_authorized: false,
        },
        continuation: CompactContinuationReceiptContinuation {
            opened: false,
            marker_served: false,
            same_agentic_turn_preserved: true,
        },
        relief_path: residual.relief_path,
        protected_tool_call_ids: residual.protected_tool_call_ids.clone(),
        effects: effects.clone(),
        residual,
        refused: false,
        refuse_code: None,
        skipped: false,
        skip_code: None,
        transition_path: transition_path.clone(),
    };
    CompactContinuationDecision {
        outcome: CompactContinuationOutcomeKind::DeclineToOrdinaryCompact,
        terminal_state: CompactContinuationState::TerminalDeclineOrdinary,
        transition_path,
        effects,
        receipt,
    }
}

/// A live owner holds this LHC thread (R23-S8). This attempt is the loser: it
/// neither steals the row nor strands. It continues its current request and
/// re-competes at the next eligible seam.
fn writer_owned_elsewhere(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    prelude: &SeamPrelude,
    reason: &str,
) -> CompactContinuationDecision {
    let mut effects = prelude.effects.clone();
    effects.push(warn(
        CompactContinuationWarningCode::WriterOwnedElsewhere,
        reason,
    ));
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    let applied = is_applied_boundary(&input.forced_continuation_boundary).is_some();
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalContinueCurrentBody);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::ContinueCurrentBody,
            terminal_state: CompactContinuationState::TerminalContinueCurrentBody,
            transition_path,
            effects,
            reason_code: "writer_owned_elsewhere".to_string(),
            turn_end_reason: if applied {
                Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string())
            } else {
                None
            },
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: applied,
                marker_served: false,
                same_agentic_turn_preserved: !applied,
            },
            residual: applied_boundary_residual_overlay(
                input,
                base_residual(
                    input,
                    true,
                    true,
                    false,
                    false,
                    None,
                    false,
                    false,
                    true,
                    Some(prelude.boundary_discarded),
                    // The loser continues its current request; it is never stranded.
                    true,
                    ResidualExtrasOver::default(),
                ),
            ),
            retry: None,
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}

fn skip(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationSkipCode,
    reason: &str,
) -> CompactContinuationDecision {
    let effects = vec![
        CompactContinuationEffect::SkipSeam {
            code,
            reason: reason.to_string(),
        },
        CompactContinuationEffect::RecordReceipt {
            durable: true,
            user_chat_visible: false,
        },
    ];
    let applied = is_applied_boundary(&input.forced_continuation_boundary).is_some();
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalSkip);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::SkipSeam,
            terminal_state: CompactContinuationState::TerminalSkip,
            transition_path,
            effects,
            reason_code: code.as_str().to_string(),
            turn_end_reason: if applied {
                Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string())
            } else {
                None
            },
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: applied,
                marker_served: false,
                same_agentic_turn_preserved: !applied,
            },
            residual: applied_boundary_residual_overlay(
                input,
                base_residual(
                    input,
                    true,
                    true,
                    false,
                    false,
                    None,
                    false,
                    false,
                    true,
                    None,
                    // Skip = wait and re-evaluate. Does not authorize a fresh next request.
                    // Does not cancel an already in-flight transport retry.
                    false,
                    ResidualExtrasOver::default(),
                ),
            ),
            retry: None,
            skipped: true,
            skip_code: Some(code),
            compact_ran: false,
        },
    )
}

fn continue_normal(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    prelude: &SeamPrelude,
    reason_code: &str,
    via_below_trigger: bool,
) -> CompactContinuationDecision {
    let mut effects = prelude.effects.clone();
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    let mut transition_path = path.to_vec();
    if via_below_trigger {
        transition_path.push(CompactContinuationState::BelowTrigger);
    }
    transition_path.push(CompactContinuationState::TerminalContinueNormal);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::ContinueNormal,
            terminal_state: CompactContinuationState::TerminalContinueNormal,
            transition_path,
            effects,
            reason_code: reason_code.to_string(),
            turn_end_reason: None,
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: false,
                marker_served: false,
                same_agentic_turn_preserved: true,
            },
            residual: base_residual(
                input,
                true,
                true,
                false,
                false,
                None,
                false,
                false,
                true,
                Some(prelude.boundary_discarded),
                true,
                ResidualExtrasOver::default(),
            ),
            retry: None,
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}

fn normal_complete(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    prelude: &SeamPrelude,
    reason_code: &str,
) -> CompactContinuationDecision {
    let mut effects = prelude.effects.clone();
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::PathNormalComplete);
    transition_path.push(CompactContinuationState::TerminalNormalComplete);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::NormalComplete,
            terminal_state: CompactContinuationState::TerminalNormalComplete,
            transition_path,
            effects,
            reason_code: reason_code.to_string(),
            turn_end_reason: None,
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: false,
                marker_served: false,
                same_agentic_turn_preserved: false,
            },
            residual: base_residual(
                input,
                true,
                true,
                false,
                false,
                None,
                false,
                false,
                false,
                Some(prelude.boundary_discarded),
                true,
                ResidualExtrasOver::default(),
            ),
            retry: None,
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}
fn force_turn_end_effect(continuation_turn_id: &str) -> CompactContinuationEffect {
    CompactContinuationEffect::ForceTurnEnd {
        reason: CONTEXT_COMPACT_CONTINUE_REASON.to_string(),
        outcome: "completed".to_string(),
        opens_continuation_turn: true,
        continuation_turn_count: 1,
        continuation_turn_id: continuation_turn_id.to_string(),
    }
}

fn compact_effect(input: &CompactContinuationInput) -> CompactContinuationEffect {
    CompactContinuationEffect::Compact {
        lower_target_domain: "lhc_rendered_history".to_string(),
        lower_target_tokens: input.policy.lower_target_tokens,
        allow_degraded_derivations: true,
    }
}

fn marker_effect(continuation_turn_id: &str) -> CompactContinuationEffect {
    CompactContinuationEffect::InsertContinuationMarker {
        kind: COMPACT_CONTINUATION_MARKER_KIND.to_string(),
        continuation_turn_id: continuation_turn_id.to_string(),
        idempotency_key: compact_continuation_marker_idempotency_key(continuation_turn_id),
        semantics: CompactContinuationMarkerSemantics::canonical(),
        model_visible: true,
        lhc_inspect_visible: true,
        user_chat_visible: false,
        host_may_inject_transiently: true,
    }
}

fn degradation_reasons_of(input: &CompactContinuationInput) -> Vec<String> {
    let mut reasons = Vec::new();
    if input.compact_material.derivations_missing_or_failed {
        reasons.push("derivations_missing_or_failed".to_string());
    }
    if !input.compact_material.lower_target_met {
        reasons.push("lower_target_missed".to_string());
    }
    reasons
}

/// Bounded-retry classification shared by compact-failure and install-failure.
struct RetryClassification {
    retry: CompactContinuationRetryReceipt,
    outcome: CompactContinuationOutcomeKind,
    terminal_state: CompactContinuationState,
    reason_code: &'static str,
}

fn retry_classification(input: &CompactContinuationInput) -> RetryClassification {
    let attempt_index = attempt_index_of(input);
    let budget = retry_budget_of(input);
    let retry_authorized = attempt_index < budget;
    RetryClassification {
        retry: CompactContinuationRetryReceipt {
            attempt_index,
            budget,
            retry_authorized,
        },
        outcome: if retry_authorized {
            CompactContinuationOutcomeKind::RetryCompact
        } else {
            CompactContinuationOutcomeKind::ContinueCurrentBody
        },
        terminal_state: if retry_authorized {
            CompactContinuationState::TerminalRetry
        } else {
            CompactContinuationState::TerminalContinueCurrentBody
        },
        reason_code: if retry_authorized {
            "compact_retry_authorized"
        } else {
            "compact_retry_budget_exhausted"
        },
    }
}

/// Warning tail for a failed attempt: the failure, plus exhaustion when spent.
fn attempt_failure_warnings(
    code: CompactContinuationWarningCode,
    reason: &str,
    retry: &CompactContinuationRetryReceipt,
) -> Vec<CompactContinuationEffect> {
    let mut effects = vec![warn(code, reason)];
    if !retry.retry_authorized {
        effects.push(warn(
            CompactContinuationWarningCode::CompactRetryBudgetExhausted,
            &format!(
                "bounded compact retry budget spent (attempt {} of {}); continuing on the current body",
                retry.attempt_index, retry.budget
            ),
        ));
    }
    effects
}

/// Compact/install attempt failed on the preserve-tool path: bounded retry, then
/// continue on the current body. The original agentic turn stays open, the prior
/// serving view stands, and the next provider request proceeds — never a stop.
fn attempt_failed_after_preserve(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationWarningCode,
    reason: &str,
    effects_so_far: Vec<CompactContinuationEffect>,
    compact_ran: bool,
) -> CompactContinuationDecision {
    let cls = retry_classification(input);
    let mut effects = effects_so_far;
    effects.extend(attempt_failure_warnings(code, reason, &cls.retry));
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    effects.push(CompactContinuationEffect::ReleaseWriter);
    let mut transition_path = path.to_vec();
    transition_path.push(cls.terminal_state);
    decide(
        input,
        DecideParts {
            outcome: cls.outcome,
            terminal_state: cls.terminal_state,
            transition_path,
            effects,
            reason_code: cls.reason_code.to_string(),
            turn_end_reason: None,
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: false,
                marker_served: false,
                same_agentic_turn_preserved: true,
            },
            residual: base_residual(
                input,
                true,
                true,
                false,
                false,
                None,
                false,
                false,
                true,
                None,
                // Relief failed; the session continues on the body it already has.
                true,
                ResidualExtrasOver {
                    relief_path: Some(CompactContinuationReliefPath::CoreInstallFailed),
                    host_validation_status: Some(HostValidationStatusFact::NotRequired),
                    ..Default::default()
                },
            ),
            retry: Some(cls.retry),
            skipped: false,
            skip_code: None,
            compact_ran,
        },
    )
}

/// Compact/install attempt failed after a forced continuation boundary: bounded
/// retry, then continue on the current body. The boundary stays durable and
/// repairable at the next seam; the session keeps working meanwhile.
#[allow(clippy::too_many_arguments)] // mirrors TS attemptFailedAfterContinue arity
fn attempt_failed_after_continue(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationWarningCode,
    reason: &str,
    effects_so_far: Vec<CompactContinuationEffect>,
    compact_ran: bool,
    continuation_turn_id: &str,
    // True when this attempt inserted the marker (install-failure path).
    attempt_marker_persisted: bool,
) -> CompactContinuationDecision {
    let cls = retry_classification(input);
    let mut effects = effects_so_far;
    effects.extend(attempt_failure_warnings(code, reason, &cls.retry));
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    effects.push(CompactContinuationEffect::ReleaseWriter);
    let marker_persisted = residual_marker_persisted(input, attempt_marker_persisted);
    let mut transition_path = path.to_vec();
    transition_path.push(cls.terminal_state);
    decide(
        input,
        DecideParts {
            outcome: cls.outcome,
            terminal_state: cls.terminal_state,
            transition_path,
            effects,
            reason_code: cls.reason_code.to_string(),
            turn_end_reason: Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string()),
            fidelity: "full".to_string(),
            degradation_reasons: vec![],
            continuation: CompactContinuationReceiptContinuation {
                opened: true,
                marker_served: false,
                same_agentic_turn_preserved: false,
            },
            residual: base_residual(
                input,
                true,
                true,
                true,
                true,
                Some(continuation_turn_id.to_string()),
                marker_persisted,
                false,
                false,
                None,
                // Boundary is durable and repairable; the session is not held hostage to it.
                true,
                ResidualExtrasOver {
                    relief_path: Some(if input.compact_material.protected_escalation_applied {
                        CompactContinuationReliefPath::ProtectedEscalation
                    } else {
                        CompactContinuationReliefPath::CoreInstallFailed
                    }),
                    host_validation_status: Some(HostValidationStatusFact::NotRequired),
                    ..Default::default()
                },
            ),
            retry: Some(cls.retry),
            skipped: false,
            skip_code: None,
            compact_ran,
        },
    )
}
fn insert_degrade_after_compact(
    effects: &mut Vec<CompactContinuationEffect>,
    degradation_reasons: &[String],
) {
    if degradation_reasons.is_empty() {
        return;
    }
    let compact_idx = effects
        .iter()
        .position(|e| matches!(e, CompactContinuationEffect::Compact { .. }));
    let insert_at = compact_idx.map(|i| i + 1).unwrap_or(effects.len());
    effects.insert(
        insert_at,
        CompactContinuationEffect::DegradeFidelity {
            causes: degradation_reasons.to_vec(),
        },
    );
}

/// Unsafe projected runway and an unproven provider request are diagnostics, not
/// gates: warn and install the best available body. The provider is the final
/// authority on what it accepts, and a provider rejection is recoverable where a
/// stranded session is not.
fn body_quality_warnings(input: &CompactContinuationInput) -> Vec<CompactContinuationEffect> {
    let material = &input.compact_material;
    let mut effects = Vec::new();
    if !material.can_produce_valid_provider_request {
        effects.push(warn(
            CompactContinuationWarningCode::ProviderRequestUnvalidated,
            "no structurally valid provider request could be proven after the full reduction ladder; sending the best available body",
        ));
    }
    if material.maximal_prune_insufficient || material.projected_pressure_safe == Some(false) {
        effects.push(warn(
            CompactContinuationWarningCode::UnsafeRunwayProjection,
            if material.maximal_prune_insufficient {
                "maximal eligible unprotected pruning cannot produce safe projected runway; installing best available relief"
            } else {
                "projected pressure remains at or above host safe-runway threshold; installing best available relief"
            },
        ));
    }
    effects
}

/// Visibility-boundary advance effect when the install moved the boundary.
fn boundary_advance_effects(input: &CompactContinuationInput) -> Vec<CompactContinuationEffect> {
    let material = &input.compact_material;
    match (
        material.visibility_boundary_before,
        material.visibility_boundary_after,
    ) {
        (Some(before), Some(after)) if after > before => {
            vec![CompactContinuationEffect::AdvanceVisibilityBoundary {
                previous_boundary: before,
                new_boundary: after,
                compact_point: material.compact_point_at_install.unwrap_or(0),
            }]
        }
        _ => vec![],
    }
}

/// Host body-validation acknowledgment effects. A `failed` acknowledgment
/// degrades: the core install stands, the warning is loud, and the next provider
/// request proceeds on the best available body (R10 / R23-S16).
fn host_validation_effects(
    host_status: HostValidationStatusFact,
) -> Vec<CompactContinuationEffect> {
    if host_status == HostValidationStatusFact::NotRequired {
        return vec![];
    }
    let mut effects = vec![CompactContinuationEffect::AwaitHostValidation {
        attempt_id_scope: "current_attempt".to_string(),
    }];
    if host_status == HostValidationStatusFact::Failed {
        effects.push(CompactContinuationEffect::RecordHostValidation {
            result: "failed".to_string(),
            reason: Some("host_reported_provider_body_unsafe".to_string()),
        });
        effects.push(warn(
            CompactContinuationWarningCode::HostValidationFailed,
            "host full-body validation failed after core install; degraded body stands and the next provider request proceeds",
        ));
    }
    effects
}

fn post_compact_tail(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    prelude: &SeamPrelude,
    branch: Branch,
) -> CompactContinuationDecision {
    let material = &input.compact_material;
    let degradation_reasons = degradation_reasons_of(input);
    let branch_state = match branch {
        Branch::PreserveTool => CompactContinuationState::PathPreserveTool,
        Branch::ContinueTurn => CompactContinuationState::PathContinueTurn,
    };
    let mut branch_path = path.to_vec();
    branch_path.push(branch_state);

    // ── continue_turn: claim → [force if this seam] → compact → marker → … ──
    if matches!(branch, Branch::ContinueTurn) {
        let boundary = is_applied_boundary(&input.forced_continuation_boundary);
        let Some(boundary) = boundary.filter(|b| !b.continuation_turn_id.is_empty()) else {
            // No continuation turn identity to key the boundary/marker on, and the
            // oracle never invents one. Hand the seam to the ordinary compact path.
            return decline_to_ordinary(
                input,
                &branch_path,
                prelude,
                CompactContinuationWarningCode::ContinuationBoundaryUnavailable,
                "continue-turn compact requires an applied forcedContinuationBoundary with a continuationTurnId; declining into ordinary settled-seam compact",
            );
        };
        let continuation_turn_id = boundary.continuation_turn_id.clone();
        let forced_this_seam = boundary.forced_this_seam;

        let mut effects_so_far = prelude.effects.clone();
        effects_so_far.push(CompactContinuationEffect::ClaimWriter {
            writer: ClaimWriterTarget::Lhc,
        });
        if forced_this_seam {
            effects_so_far.push(force_turn_end_effect(&continuation_turn_id));
        }
        effects_so_far.push(compact_effect(input));

        let mut path_after_claim = branch_path.clone();
        path_after_claim.push(CompactContinuationState::Compacting);

        if !material.compact_structurally_valid {
            return attempt_failed_after_continue(
                input,
                &path_after_claim,
                CompactContinuationWarningCode::CompactAttemptFailed,
                "compact assembly could not produce a structurally valid view",
                effects_so_far,
                true,
                &continuation_turn_id,
                false,
            );
        }

        // Body-quality diagnostics never gate the install.
        effects_so_far.extend(body_quality_warnings(input));

        insert_degrade_after_compact(&mut effects_so_far, &degradation_reasons);
        effects_so_far.push(marker_effect(&continuation_turn_id));

        if !material.install_succeeds {
            let mut path_installing = path_after_claim.clone();
            path_installing.push(CompactContinuationState::Installing);
            return attempt_failed_after_continue(
                input,
                &path_installing,
                CompactContinuationWarningCode::InstallAttemptFailed,
                "post-compact serving view could not be installed",
                effects_so_far,
                true,
                &continuation_turn_id,
                true,
            );
        }

        // Protected-escalation (pending tools + forced boundary) preserves pairs
        // and may advance visibility boundary. Active non-tool has no protected set.
        let protected_ids = protected_ids_of(input);
        let escalated_pending = !protected_ids.is_empty() && material.protected_escalation_applied;
        let host_status = material.host_validation_status;
        // Only an unanswered acknowledgment holds the next request; a failure degrades.
        let next_allowed = host_status != HostValidationStatusFact::Awaiting;
        let relief_path = if escalated_pending {
            match host_status {
                HostValidationStatusFact::Failed => {
                    CompactContinuationReliefPath::HostValidationFailed
                }
                HostValidationStatusFact::Awaiting => {
                    CompactContinuationReliefPath::HostValidationAwaiting
                }
                _ => CompactContinuationReliefPath::ProtectedEscalation,
            }
        } else {
            CompactContinuationReliefPath::None
        };

        let mut install_tail: Vec<CompactContinuationEffect> = Vec::new();
        if !protected_ids.is_empty() {
            install_tail.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
                protected_tool_call_ids: protected_ids.clone(),
                location: "open_turn_tail".to_string(),
            });
        }
        install_tail.extend(boundary_advance_effects(input));
        install_tail.push(CompactContinuationEffect::InstallServingView);
        install_tail.extend(host_validation_effects(host_status));

        if !material.useful_reduction {
            let mut effects = effects_so_far;
            effects.extend(install_tail);
            effects.push(CompactContinuationEffect::RecordReceipt {
                durable: true,
                user_chat_visible: false,
            });
            effects.push(CompactContinuationEffect::ReleaseWriter);
            let mut transition_path = path_after_claim.clone();
            transition_path.push(CompactContinuationState::Installing);
            transition_path.push(CompactContinuationState::TerminalNoReduction);
            return decide(
                input,
                DecideParts {
                    outcome: CompactContinuationOutcomeKind::NoReduction,
                    terminal_state: CompactContinuationState::TerminalNoReduction,
                    transition_path,
                    effects,
                    reason_code: "no_useful_reduction".to_string(),
                    turn_end_reason: Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string()),
                    fidelity: if degradation_reasons.is_empty() {
                        "full".to_string()
                    } else {
                        "degraded".to_string()
                    },
                    degradation_reasons: degradation_reasons.clone(),
                    continuation: CompactContinuationReceiptContinuation {
                        opened: true,
                        marker_served: true,
                        same_agentic_turn_preserved: false,
                    },
                    residual: base_residual(
                        input,
                        true,
                        false,
                        true,
                        true,
                        Some(continuation_turn_id),
                        true,
                        true,
                        false,
                        Some(prelude.boundary_discarded),
                        next_allowed,
                        ResidualExtrasOver {
                            relief_path: Some(relief_path),
                            protected_tool_call_ids: Some(protected_ids),
                            host_validation_status: Some(host_status),
                            core_install_retained_pending_host_validation: Some(
                                host_status == HostValidationStatusFact::Awaiting,
                            ),
                            ..Default::default()
                        },
                    ),
                    retry: None,
                    skipped: false,
                    skip_code: None,
                    compact_ran: true,
                },
            );
        }

        let mut effects = effects_so_far;
        effects.extend(install_tail);
        effects.push(CompactContinuationEffect::RecordReceipt {
            durable: true,
            user_chat_visible: false,
        });
        effects.push(CompactContinuationEffect::ReleaseWriter);
        let degraded = !degradation_reasons.is_empty();
        let outcome = if degraded {
            CompactContinuationOutcomeKind::DegradedCompact
        } else if escalated_pending {
            CompactContinuationOutcomeKind::CompactPreserveToolEscalated
        } else {
            CompactContinuationOutcomeKind::CompactContinueTurn
        };
        let terminal = if degraded {
            CompactContinuationState::TerminalDegraded
        } else {
            CompactContinuationState::TerminalContinueTurn
        };
        let mut transition_path = path_after_claim;
        transition_path.push(CompactContinuationState::Installing);
        transition_path.push(terminal);
        return decide(
            input,
            DecideParts {
                outcome,
                terminal_state: terminal,
                transition_path,
                effects,
                reason_code: if degraded {
                    "degraded_continue_turn".to_string()
                } else if escalated_pending {
                    "protected_escalation".to_string()
                } else {
                    CONTEXT_COMPACT_CONTINUE_REASON.to_string()
                },
                turn_end_reason: Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string()),
                fidelity: if degraded {
                    "degraded".to_string()
                } else {
                    "full".to_string()
                },
                degradation_reasons,
                continuation: CompactContinuationReceiptContinuation {
                    opened: true,
                    marker_served: true,
                    same_agentic_turn_preserved: false,
                },
                residual: base_residual(
                    input,
                    true,
                    false,
                    true,
                    true,
                    Some(continuation_turn_id),
                    true,
                    true,
                    false,
                    Some(prelude.boundary_discarded),
                    next_allowed,
                    ResidualExtrasOver {
                        relief_path: Some(if escalated_pending {
                            match host_status {
                                HostValidationStatusFact::Awaiting => {
                                    CompactContinuationReliefPath::HostValidationAwaiting
                                }
                                HostValidationStatusFact::Failed => {
                                    CompactContinuationReliefPath::HostValidationFailed
                                }
                                _ => CompactContinuationReliefPath::ProtectedEscalation,
                            }
                        } else {
                            CompactContinuationReliefPath::None
                        }),
                        protected_tool_call_ids: Some(protected_ids),
                        host_validation_status: Some(host_status),
                        core_install_retained_pending_host_validation: Some(
                            host_status == HostValidationStatusFact::Awaiting,
                        ),
                        ..Default::default()
                    },
                ),
                retry: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    // ── preserve_tool ─────────────────────────────────────────────────────────
    let protected_tool_call_ids = protected_ids_of(input);
    let mut effects_so_far = prelude.effects.clone();
    effects_so_far.push(CompactContinuationEffect::ClaimWriter {
        writer: ClaimWriterTarget::Lhc,
    });
    effects_so_far.push(compact_effect(input));
    let mut path_after_claim = branch_path;
    path_after_claim.push(CompactContinuationState::Compacting);

    if !material.compact_structurally_valid {
        return attempt_failed_after_preserve(
            input,
            &path_after_claim,
            CompactContinuationWarningCode::CompactAttemptFailed,
            "compact assembly could not produce a structurally valid view",
            effects_so_far,
            true,
        );
    }

    effects_so_far.extend(body_quality_warnings(input));

    insert_degrade_after_compact(&mut effects_so_far, &degradation_reasons);

    let preserve_effect = CompactContinuationEffect::PreserveToolPairsVerbatim {
        protected_tool_call_ids: protected_tool_call_ids.clone(),
        location: "open_turn_tail".to_string(),
    };

    if !material.install_succeeds {
        // Normative preserve-tool order places preserve before install; install
        // attempt reached ⇒ include preserve effect even when install fails.
        let mut install_fail_effects = effects_so_far;
        install_fail_effects.push(preserve_effect);
        let mut path_installing = path_after_claim.clone();
        path_installing.push(CompactContinuationState::Installing);
        return attempt_failed_after_preserve(
            input,
            &path_installing,
            CompactContinuationWarningCode::InstallAttemptFailed,
            "post-compact serving view could not be installed",
            install_fail_effects,
            true,
        );
    }

    let host_status = material.host_validation_status;
    let mut install_tail = vec![
        preserve_effect,
        CompactContinuationEffect::InstallServingView,
    ];
    install_tail.extend(host_validation_effects(host_status));
    let next_allowed = host_status != HostValidationStatusFact::Awaiting;
    let core_retained = host_status == HostValidationStatusFact::Awaiting;

    if !material.useful_reduction {
        let mut effects = effects_so_far;
        effects.extend(install_tail);
        effects.push(CompactContinuationEffect::RecordReceipt {
            durable: true,
            user_chat_visible: false,
        });
        effects.push(CompactContinuationEffect::ReleaseWriter);
        let mut transition_path = path_after_claim.clone();
        transition_path.push(CompactContinuationState::Installing);
        transition_path.push(CompactContinuationState::TerminalNoReduction);
        return decide(
            input,
            DecideParts {
                outcome: CompactContinuationOutcomeKind::NoReduction,
                terminal_state: CompactContinuationState::TerminalNoReduction,
                transition_path,
                effects,
                reason_code: "no_useful_reduction".to_string(),
                turn_end_reason: None,
                fidelity: if degradation_reasons.is_empty() {
                    "full".to_string()
                } else {
                    "degraded".to_string()
                },
                degradation_reasons: degradation_reasons.clone(),
                continuation: CompactContinuationReceiptContinuation {
                    opened: false,
                    marker_served: false,
                    same_agentic_turn_preserved: true,
                },
                residual: base_residual(
                    input,
                    true,
                    false,
                    false,
                    false,
                    None,
                    false,
                    false,
                    true,
                    Some(prelude.boundary_discarded),
                    next_allowed,
                    ResidualExtrasOver {
                        relief_path: Some(CompactContinuationReliefPath::NormalPreserve),
                        host_validation_status: Some(host_status),
                        core_install_retained_pending_host_validation: Some(core_retained),
                        ..Default::default()
                    },
                ),
                retry: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    let mut effects = effects_so_far;
    effects.extend(install_tail);
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    effects.push(CompactContinuationEffect::ReleaseWriter);
    let degraded = !degradation_reasons.is_empty();
    let outcome = if degraded {
        CompactContinuationOutcomeKind::DegradedCompact
    } else {
        CompactContinuationOutcomeKind::CompactPreserveTool
    };
    let terminal = if degraded {
        CompactContinuationState::TerminalDegraded
    } else {
        CompactContinuationState::TerminalPreserveTool
    };
    let mut transition_path = path_after_claim;
    transition_path.push(CompactContinuationState::Installing);
    transition_path.push(terminal);
    decide(
        input,
        DecideParts {
            outcome,
            terminal_state: terminal,
            transition_path,
            effects,
            reason_code: if degraded {
                "degraded_preserve_tool".to_string()
            } else {
                "compact_preserve_tool".to_string()
            },
            turn_end_reason: None,
            fidelity: if degraded {
                "degraded".to_string()
            } else {
                "full".to_string()
            },
            degradation_reasons,
            continuation: CompactContinuationReceiptContinuation {
                opened: false,
                marker_served: false,
                same_agentic_turn_preserved: true,
            },
            residual: base_residual(
                input,
                true,
                false,
                false,
                false,
                None,
                false,
                false,
                true,
                Some(prelude.boundary_discarded),
                next_allowed,
                ResidualExtrasOver {
                    relief_path: Some(CompactContinuationReliefPath::NormalPreserve),
                    host_validation_status: Some(host_status),
                    core_install_retained_pending_host_validation: Some(core_retained),
                    ..Default::default()
                },
            ),
            retry: None,
            skipped: false,
            skip_code: None,
            compact_ran: true,
        },
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Branch {
    /// Tool-preserve path; protected ids read from the proven pending tool kind.
    PreserveTool,
    ContinueTurn,
}

/// A pending tool pair that cannot be protected through compact. Recorded at the
/// health stage and resolved at the branch.
struct ProtectedPathUnavailable {
    code: CompactContinuationWarningCode,
    reason: &'static str,
}

/// Evaluate compact-continuation for a completed (or classifiable) seam.
///
/// Ordering is fixed (see `COMPACT_CONTINUATION_TRANSITION_ORDER`). Capability-
/// limited hosts still receive the full decision table; they must not claim
/// effects they cannot perform (host adapter concern, not decision rewriting).
pub fn decide_compact_continuation(
    input: &CompactContinuationInput,
) -> CompactContinuationDecision {
    // Unknown contract version: omit continuation features entirely (R22).
    if input.contract_version != COMPACT_CONTINUATION_CONTRACT_VERSION {
        return decline_unsupported_version(input);
    }

    let seam = &input.seam;

    if seam.inside_transport_retry {
        return skip(
            input,
            &[CompactContinuationState::Idle],
            CompactContinuationSkipCode::TransportRetry,
            "mutation forbidden inside transport retry",
        );
    }

    let at_seam = seam.model_response_complete
        && seam.requested_tools_settled
        && seam.capture_flushed
        && seam.before_next_provider_request;

    if !at_seam {
        return skip(
            input,
            &[CompactContinuationState::Idle],
            CompactContinuationSkipCode::NotAtSettledSeam,
            "compact-continuation requires a settled model-turn seam before the next provider request",
        );
    }

    let path = vec![
        CompactContinuationState::AtSeam,
        CompactContinuationState::CheckingInvariants,
    ];

    // Input-epoch drift is diagnostic only (R1). Settled history is not
    // invalidated by input that arrived later in the turn; that input belongs to
    // the next turn. There is no epoch veto at any of the three former sites.

    let mut prelude_effects: Vec<CompactContinuationEffect> = Vec::new();
    let mut boundary_discarded = false;
    let mut effective = input.clone();

    // ── Stage: forced_boundary_state_legality ────────────────────────────────
    // An unusable applied boundary is discarded and the seam starts fresh (R23-S12).
    if let Some(entry_boundary) = is_applied_boundary(&input.forced_continuation_boundary) {
        let wrong_kind = !matches!(
            input.continuation,
            WorkContinuation::ActiveNonTool | WorkContinuation::PendingCorrelatedToolResult { .. }
        );
        let missing_turn_id = entry_boundary.continuation_turn_id.is_empty();
        if wrong_kind || missing_turn_id {
            let reason = if wrong_kind {
                format!(
                    "forcedContinuationBoundary.applied requires active_non_tool or pending_correlated_tool_result; got {} — boundary discarded, seam starts fresh",
                    input.continuation.kind_str()
                )
            } else {
                "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id when applied — boundary discarded, seam starts fresh".to_string()
            };
            prelude_effects.push(CompactContinuationEffect::DiscardPendingBoundary {
                continuation_turn_id: if missing_turn_id {
                    None
                } else {
                    Some(entry_boundary.continuation_turn_id.clone())
                },
                reason: reason.clone(),
            });
            prelude_effects.push(warn(
                CompactContinuationWarningCode::PendingBoundaryDiscarded,
                &reason,
            ));
            boundary_discarded = true;
            effective.forced_continuation_boundary = ForcedContinuationBoundary::not_applied();
        } else if entry_boundary.forced_this_seam && entry_boundary.marker_already_persisted {
            // A fresh atomic turn_end just minted this continuation turn id, so its
            // boundary-derived marker cannot already exist. Keep the real boundary —
            // discarding it would orphan an open continuation turn — and simply do
            // not trust the contradictory marker claim (residual already ignores it).
            prelude_effects.push(warn(
                CompactContinuationWarningCode::BoundaryMarkerClaimUntrusted,
                "forcedThisSeam true cannot pair with markerAlreadyPersisted true (a fresh turn_end marker cannot already exist); marker claim not trusted",
            ));
        }
    }

    // ── Stage: writer_claim (stale-row reclaim under host authority, R23-S8) ──
    let writer_claim = effective.invariants.writer_claim;
    if matches!(writer_claim, WriterClaim::Native | WriterClaim::Conflict) {
        let authority = effective.invariants.writer_ownership_authority;
        if authority == Some(WriterOwnershipAuthority::NoLiveOwner) {
            prelude_effects.push(CompactContinuationEffect::ReclaimWriter {
                prior_claim: if writer_claim == WriterClaim::Native {
                    ReclaimPriorClaim::Native
                } else {
                    ReclaimPriorClaim::Conflict
                },
                host_authority: ReclaimHostAuthority::NoLiveOwner,
            });
            prelude_effects.push(warn(
                CompactContinuationWarningCode::StaleWriterRowReclaimed,
                &format!(
                    "stale {} writer row reclaimed after host ownership authority confirmed no live owner holds this LHC thread",
                    writer_claim.as_str()
                ),
            ));
            // The row is ours now; downstream paths claim and release LHC normally.
            effective.invariants.writer_claim = WriterClaim::None;
        } else {
            let reason = if authority == Some(WriterOwnershipAuthority::LiveOwner) {
                format!(
                    "a live owner holds this LHC thread ({} writer row); continuing this attempt's current request and re-competing at the next seam",
                    writer_claim.as_str()
                )
            } else {
                format!(
                    "no host ownership authority was supplied for a {} writer row; treating it as a live owner and continuing this attempt's current request",
                    writer_claim.as_str()
                )
            };
            return writer_owned_elsewhere(
                &effective,
                &path,
                &SeamPrelude {
                    effects: prelude_effects,
                    boundary_discarded,
                },
                &reason,
            );
        }
    }

    // ── Stage: capture_identity_correlation — warn, never refuse ─────────────
    if !effective.invariants.capture_complete {
        prelude_effects.push(warn(
            CompactContinuationWarningCode::CaptureIncomplete,
            "capture of the settled model turn is incomplete; compacting on available thread data (capture feeds derivation quality, not compact capability)",
        ));
    }

    if !effective.invariants.provider_identity_valid {
        let reason = "required provider/model identity cannot be proven; omitting signed reasoning and proceeding with the compact";
        prelude_effects.push(warn(
            CompactContinuationWarningCode::ProviderIdentityUnproven,
            reason,
        ));
        prelude_effects.push(CompactContinuationEffect::OmitSignedReasoning {
            reason: reason.to_string(),
        });
    }

    if !effective.invariants.single_open_turn {
        prelude_effects.push(warn(
            CompactContinuationWarningCode::OpenTurnInvariantUnverified,
            "exactly-one-open-turn invariant does not hold; turn-record health is core LHC's own job, not a compact precondition",
        ));
    }

    // Uncorrelatable pairs / invalid pair set: the pair cannot be *protected*
    // through compact, so the protected path is unavailable. Recorded here and
    // resolved at the branch: below trigger continues normally; above trigger
    // declines into the ordinary settled-seam compact on canonical state.
    let mut protected_path_unavailable: Option<ProtectedPathUnavailable> = None;
    if let WorkContinuation::PendingCorrelatedToolResult {
        correlation_valid,
        protected_tool_call_ids,
    } = &effective.continuation
    {
        if !*correlation_valid {
            protected_path_unavailable = Some(ProtectedPathUnavailable {
                code: CompactContinuationWarningCode::ToolCorrelationUnproven,
                reason: "pending tool-result continuation cannot prove call/result correlation; declining into ordinary settled-seam compact on canonical state",
            });
        } else if normalize_protected_tool_call_ids(protected_tool_call_ids).is_empty() {
            protected_path_unavailable = Some(ProtectedPathUnavailable {
                code: CompactContinuationWarningCode::ProtectedToolPairsInvalid,
                reason: "protectedToolCallIds must be a sorted unique non-empty set; declining into ordinary settled-seam compact on canonical state",
            });
        }
        // Not warned here: the warning describes a decision actually taken. Below
        // trigger nothing compacts, so an unprotectable pair changes nothing; above
        // trigger the decline emits it.
    }

    let prelude = SeamPrelude {
        effects: prelude_effects,
        boundary_discarded,
    };
    let mut eval_path = path;
    eval_path.push(CompactContinuationState::EvaluatingPressure);

    // Repair: applied boundary with forcedThisSeam=false takes precedence over
    // fresh pressure/usage. Fresh continue-turn also supplies applied boundary
    // (runtime forced first and filled the turn id).
    if is_applied_boundary(&effective.forced_continuation_boundary).is_some() {
        if let Some(unavailable) = protected_path_unavailable {
            // The boundary stays durable and repairable; this seam declines.
            return decline_to_ordinary(
                &effective,
                &eval_path,
                &prelude,
                unavailable.code,
                unavailable.reason,
            );
        }
        return post_compact_tail(&effective, &eval_path, &prelude, Branch::ContinueTurn);
    }

    if !effective.provider_usage.is_available() {
        if matches!(effective.continuation, WorkContinuation::None) {
            return normal_complete(
                &effective,
                &eval_path,
                &prelude,
                "no_provider_usage_work_complete",
            );
        }
        return continue_normal(&effective, &eval_path, &prelude, "no_provider_usage", false);
    }

    let pressure = pressure_receipt(&effective);
    if pressure.at_or_above_trigger != Some(true) {
        if matches!(effective.continuation, WorkContinuation::None) {
            return normal_complete(
                &effective,
                &eval_path,
                &prelude,
                "below_trigger_work_complete",
            );
        }
        return continue_normal(&effective, &eval_path, &prelude, "below_trigger", true);
    }

    if matches!(effective.continuation, WorkContinuation::None) {
        return normal_complete(
            &effective,
            &eval_path,
            &prelude,
            "normal_complete_above_pressure",
        );
    }

    if matches!(
        effective.continuation,
        WorkContinuation::PendingCorrelatedToolResult { .. }
    ) {
        if let Some(unavailable) = protected_path_unavailable {
            return decline_to_ordinary(
                &effective,
                &eval_path,
                &prelude,
                unavailable.code,
                unavailable.reason,
            );
        }
        return post_compact_tail(&effective, &eval_path, &prelude, Branch::PreserveTool);
    }

    // Active non-tool above trigger without an applied boundary: the runtime must
    // force the boundary first and re-enter with the continuation turn id. The
    // oracle never invents one, so this seam declines into the ordinary compact
    // path rather than stopping.
    decline_to_ordinary(
        &effective,
        &eval_path,
        &prelude,
        CompactContinuationWarningCode::ContinuationBoundaryUnavailable,
        "active_non_tool above trigger requires forcedContinuationBoundary.applied with continuationTurnId (runtime forces turn_end first); declining into ordinary settled-seam compact",
    )
}
