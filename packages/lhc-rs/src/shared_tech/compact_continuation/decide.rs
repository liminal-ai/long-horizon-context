//! Pure compact-continuation decision function — whole-seam parity/receipt oracle.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/decide.ts`.
//! Deterministic: same input ⇒ same Decision (including transition path and
//! ordered effects). No I/O.
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
    CompactContinuationReceiptContinuation, CompactContinuationRefuseCode,
    CompactContinuationReliefPath, CompactContinuationResidualState, CompactContinuationSkipCode,
    CompactContinuationState, ForcedContinuationBoundary, ForcedContinuationBoundaryApplied,
    HostValidationStatusFact, WorkContinuation, WriterClaim,
    compact_continuation_marker_idempotency_key, normalize_protected_tool_call_ids,
};

fn is_applied_boundary(
    b: &ForcedContinuationBoundary,
) -> Option<&ForcedContinuationBoundaryApplied> {
    b.as_applied()
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
        next_provider_request_allowed,
        relief_path: extras.relief_path,
        protected_tool_call_ids: extras.protected_tool_call_ids,
        visibility_boundary_before: extras.visibility_boundary_before,
        visibility_boundary_after: extras.visibility_boundary_after,
        host_validation_status: extras.host_validation_status,
        core_install_retained_pending_host_validation: extras
            .core_install_retained_pending_host_validation,
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

/// Applied forced-boundary residual facts must remain truthful on skip/refuse
/// exits that never reach repair compact.
///
/// `markerAlreadyPersisted` is trusted only on repair (`forcedThisSeam: false`).
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
    base.marker_persisted = base.marker_persisted || trust_prior_marker;
    base.original_agentic_turn_still_open = false;
    base.next_provider_request_allowed = false;
    base
}

fn early_refuse_effects(
    input: &CompactContinuationInput,
    code: CompactContinuationRefuseCode,
    reason: &str,
) -> Vec<CompactContinuationEffect> {
    let mut effects = Vec::new();
    if input.invariants.writer_claim == WriterClaim::Lhc {
        effects.push(CompactContinuationEffect::ClaimWriter {
            writer: ClaimWriterTarget::Lhc,
        });
    }
    effects.push(CompactContinuationEffect::Refuse {
        code,
        reason: reason.to_string(),
    });
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
    refused: bool,
    refuse_code: Option<CompactContinuationRefuseCode>,
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
        continuation: parts.continuation.clone(),
        relief_path: parts.residual.relief_path,
        protected_tool_call_ids: parts.residual.protected_tool_call_ids.clone(),
        effects: parts.effects.clone(),
        residual: parts.residual.clone(),
        refused: parts.refused,
        refuse_code: parts.refuse_code,
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

fn refuse_early(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationRefuseCode,
    reason: &str,
) -> CompactContinuationDecision {
    let effects = early_refuse_effects(input, code, reason);
    let applied = is_applied_boundary(&input.forced_continuation_boundary).is_some();
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalRefuse);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::Refuse,
            terminal_state: CompactContinuationState::TerminalRefuse,
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
                    false,
                    ResidualExtrasOver::default(),
                ),
            ),
            refused: true,
            refuse_code: Some(code),
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}

fn refuse_unsupported_version(input: &CompactContinuationInput) -> CompactContinuationDecision {
    let rejected = input.contract_version.clone();
    let reason = format!(
        "unsupported compact-continuation contract version {rejected}; oracle is {COMPACT_CONTINUATION_CONTRACT_VERSION}"
    );
    let effects = vec![
        CompactContinuationEffect::Refuse {
            code: CompactContinuationRefuseCode::UnsupportedContractVersion,
            reason,
        },
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
    let residual = base_residual(
        input,
        true,
        true,
        false,
        false,
        None,
        false,
        false,
        true,
        false,
        ResidualExtrasOver::default(),
    );
    let transition_path = vec![
        CompactContinuationState::Idle,
        CompactContinuationState::TerminalRefuse,
    ];
    let receipt = CompactContinuationReceipt {
        contract_version: COMPACT_CONTINUATION_CONTRACT_VERSION.to_string(),
        outcome: CompactContinuationOutcomeKind::Refuse,
        reason_code: format!("unsupported_contract_version:{rejected}"),
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
        continuation: CompactContinuationReceiptContinuation {
            opened: false,
            marker_served: false,
            same_agentic_turn_preserved: true,
        },
        relief_path: residual.relief_path,
        protected_tool_call_ids: residual.protected_tool_call_ids.clone(),
        effects: effects.clone(),
        residual,
        refused: true,
        refuse_code: Some(CompactContinuationRefuseCode::UnsupportedContractVersion),
        skipped: false,
        skip_code: None,
        transition_path: transition_path.clone(),
    };
    CompactContinuationDecision {
        outcome: CompactContinuationOutcomeKind::Refuse,
        terminal_state: CompactContinuationState::TerminalRefuse,
        transition_path,
        effects,
        receipt,
    }
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
                    false,
                    ResidualExtrasOver::default(),
                ),
            ),
            refused: false,
            refuse_code: None,
            skipped: true,
            skip_code: Some(code),
            compact_ran: false,
        },
    )
}

fn continue_normal(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    reason_code: &str,
    via_below_trigger: bool,
) -> CompactContinuationDecision {
    let effects = vec![CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    }];
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
                true,
                ResidualExtrasOver::default(),
            ),
            refused: false,
            refuse_code: None,
            skipped: false,
            skip_code: None,
            compact_ran: false,
        },
    )
}

fn normal_complete(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    reason_code: &str,
) -> CompactContinuationDecision {
    let effects = vec![CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    }];
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
                true,
                ResidualExtrasOver::default(),
            ),
            refused: false,
            refuse_code: None,
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

fn refuse_after_preserve_attempt(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationRefuseCode,
    reason: &str,
    effects_so_far: Vec<CompactContinuationEffect>,
    compact_ran: bool,
) -> CompactContinuationDecision {
    let mut effects = effects_so_far;
    effects.push(CompactContinuationEffect::Refuse {
        code,
        reason: reason.to_string(),
    });
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    effects.push(CompactContinuationEffect::ReleaseWriter);
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalRefuse);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::Refuse,
            terminal_state: CompactContinuationState::TerminalRefuse,
            transition_path,
            effects,
            reason_code: code.as_str().to_string(),
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
                false,
                ResidualExtrasOver {
                    relief_path: Some(
                        if matches!(
                            code,
                            CompactContinuationRefuseCode::UnsafeRunway
                                | CompactContinuationRefuseCode::InvalidProtectedToolPairs
                        ) {
                            CompactContinuationReliefPath::None
                        } else {
                            CompactContinuationReliefPath::CoreInstallFailed
                        },
                    ),
                    host_validation_status: Some(HostValidationStatusFact::NotRequired),
                    ..Default::default()
                },
            ),
            refused: true,
            refuse_code: Some(code),
            skipped: false,
            skip_code: None,
            compact_ran,
        },
    )
}

#[allow(clippy::too_many_arguments)] // mirrors TS refuseAfterContinueAttempt arity
fn refuse_after_continue_attempt(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
    code: CompactContinuationRefuseCode,
    reason: &str,
    effects_so_far: Vec<CompactContinuationEffect>,
    compact_ran: bool,
    continuation_turn_id: &str,
    attempt_marker_persisted: bool,
) -> CompactContinuationDecision {
    let mut effects = effects_so_far;
    effects.push(CompactContinuationEffect::Refuse {
        code,
        reason: reason.to_string(),
    });
    effects.push(CompactContinuationEffect::RecordReceipt {
        durable: true,
        user_chat_visible: false,
    });
    effects.push(CompactContinuationEffect::ReleaseWriter);
    let marker_persisted = residual_marker_persisted(input, attempt_marker_persisted);
    let mut transition_path = path.to_vec();
    transition_path.push(CompactContinuationState::TerminalRefuse);
    decide(
        input,
        DecideParts {
            outcome: CompactContinuationOutcomeKind::Refuse,
            terminal_state: CompactContinuationState::TerminalRefuse,
            transition_path,
            effects,
            reason_code: code.as_str().to_string(),
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
                false,
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
            refused: true,
            refuse_code: Some(code),
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

fn post_compact_tail(
    input: &CompactContinuationInput,
    path: &[CompactContinuationState],
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
        let Some(boundary) = is_applied_boundary(&input.forced_continuation_boundary) else {
            return refuse_early(
                input,
                &branch_path,
                CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
                "continue-turn compact requires forcedContinuationBoundary.applied with continuationTurnId",
            );
        };
        if boundary.continuation_turn_id.is_empty() {
            return refuse_early(
                input,
                &branch_path,
                CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
                "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id",
            );
        }
        let continuation_turn_id = boundary.continuation_turn_id.clone();
        let forced_this_seam = boundary.forced_this_seam;

        let mut effects_so_far = vec![CompactContinuationEffect::ClaimWriter {
            writer: ClaimWriterTarget::Lhc,
        }];
        if forced_this_seam {
            effects_so_far.push(force_turn_end_effect(&continuation_turn_id));
        }
        effects_so_far.push(compact_effect(input));

        let mut path_after_claim = branch_path.clone();
        path_after_claim.push(CompactContinuationState::Compacting);

        if !material.compact_structurally_valid {
            return refuse_after_continue_attempt(
                input,
                &path_after_claim,
                CompactContinuationRefuseCode::CompactFailed,
                "compact assembly could not produce a structurally valid view",
                effects_so_far,
                true,
                &continuation_turn_id,
                false,
            );
        }
        if !material.can_produce_valid_provider_request {
            return refuse_after_continue_attempt(
                input,
                &path_after_claim,
                CompactContinuationRefuseCode::NoValidProviderRequest,
                "no structurally valid provider request can be produced",
                effects_so_far,
                true,
                &continuation_turn_id,
                false,
            );
        }

        if material.maximal_prune_insufficient || material.projected_pressure_safe == Some(false) {
            return refuse_after_continue_attempt(
                input,
                &path_after_claim,
                CompactContinuationRefuseCode::UnsafeRunway,
                if material.maximal_prune_insufficient {
                    "maximal eligible unprotected pruning cannot produce safe projected runway"
                } else {
                    "projected pressure remains at or above host safe-runway threshold"
                },
                effects_so_far,
                true,
                &continuation_turn_id,
                false,
            );
        }

        insert_degrade_after_compact(&mut effects_so_far, &degradation_reasons);
        effects_so_far.push(marker_effect(&continuation_turn_id));

        if !material.install_succeeds {
            let mut path_installing = path_after_claim.clone();
            path_installing.push(CompactContinuationState::Installing);
            return refuse_after_continue_attempt(
                input,
                &path_installing,
                CompactContinuationRefuseCode::InstallFailed,
                "post-compact serving view could not be installed",
                effects_so_far,
                true,
                &continuation_turn_id,
                true,
            );
        }

        let protected_ids = protected_ids_of(input);

        // Shared effect suffix builder: protected pairs + boundary advance.
        let boundary_advance = match (
            material.visibility_boundary_before,
            material.visibility_boundary_after,
        ) {
            (Some(before), Some(after)) if after > before => {
                Some(CompactContinuationEffect::AdvanceVisibilityBoundary {
                    previous_boundary: before,
                    new_boundary: after,
                    compact_point: material.compact_point_at_install.unwrap_or(0),
                })
            }
            _ => None,
        };

        // Host full-body validation failure after successful core install does NOT
        // roll back the core view/boundary. Distinct refuse; next request blocked.
        if material.host_validation_status == HostValidationStatusFact::Failed {
            let mut effects = effects_so_far.clone();
            if !protected_ids.is_empty() {
                effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
                    protected_tool_call_ids: protected_ids.clone(),
                    location: "open_turn_tail".to_string(),
                });
            }
            if let Some(adv) = boundary_advance.clone() {
                effects.push(adv);
            }
            effects.push(CompactContinuationEffect::InstallServingView);
            effects.push(CompactContinuationEffect::AwaitHostValidation {
                attempt_id_scope: "current_attempt".to_string(),
            });
            effects.push(CompactContinuationEffect::RecordHostValidation {
                result: "failed".to_string(),
                reason: Some("host_reported_provider_body_unsafe".to_string()),
            });
            effects.push(CompactContinuationEffect::Refuse {
                code: CompactContinuationRefuseCode::HostValidationFailed,
                reason: "host full-body validation failed after core install".to_string(),
            });
            effects.push(CompactContinuationEffect::RecordReceipt {
                durable: true,
                user_chat_visible: false,
            });
            effects.push(CompactContinuationEffect::ReleaseWriter);
            let mut transition_path = path_after_claim.clone();
            transition_path.push(CompactContinuationState::Installing);
            transition_path.push(CompactContinuationState::TerminalRefuse);
            return decide(
                input,
                DecideParts {
                    outcome: CompactContinuationOutcomeKind::Refuse,
                    terminal_state: CompactContinuationState::TerminalRefuse,
                    transition_path,
                    effects,
                    reason_code: "host_validation_failed".to_string(),
                    turn_end_reason: Some(CONTEXT_COMPACT_CONTINUE_REASON.to_string()),
                    fidelity: "full".to_string(),
                    degradation_reasons: vec![],
                    continuation: CompactContinuationReceiptContinuation {
                        opened: true,
                        marker_served: true,
                        same_agentic_turn_preserved: false,
                    },
                    residual: base_residual(
                        input,
                        true,
                        // Core install retained — prior view is NOT intact.
                        false,
                        true,
                        true,
                        Some(continuation_turn_id),
                        true,
                        true,
                        false,
                        false,
                        ResidualExtrasOver {
                            relief_path: Some(CompactContinuationReliefPath::HostValidationFailed),
                            protected_tool_call_ids: Some(protected_ids),
                            host_validation_status: Some(HostValidationStatusFact::Failed),
                            core_install_retained_pending_host_validation: Some(true),
                            ..Default::default()
                        },
                    ),
                    refused: true,
                    refuse_code: Some(CompactContinuationRefuseCode::HostValidationFailed),
                    skipped: false,
                    skip_code: None,
                    compact_ran: true,
                },
            );
        }

        // Protected-escalation (pending tools + forced boundary) preserves pairs
        // and may advance visibility boundary. Active non-tool has no protected set.
        let escalated_pending = !protected_ids.is_empty() && material.protected_escalation_applied;
        let host_status = material.host_validation_status;
        let next_allowed = matches!(
            host_status,
            HostValidationStatusFact::NotRequired | HostValidationStatusFact::Ok
        );
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
        let needs_await_effect = host_status != HostValidationStatusFact::NotRequired;

        if !material.useful_reduction {
            let mut effects = effects_so_far;
            if !protected_ids.is_empty() {
                effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
                    protected_tool_call_ids: protected_ids.clone(),
                    location: "open_turn_tail".to_string(),
                });
            }
            if let Some(adv) = boundary_advance.clone() {
                effects.push(adv);
            }
            effects.push(CompactContinuationEffect::InstallServingView);
            if needs_await_effect {
                effects.push(CompactContinuationEffect::AwaitHostValidation {
                    attempt_id_scope: "current_attempt".to_string(),
                });
            }
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
                        next_allowed,
                        ResidualExtrasOver {
                            relief_path: Some(relief_path),
                            protected_tool_call_ids: Some(protected_ids),
                            host_validation_status: Some(host_status),
                            core_install_retained_pending_host_validation: Some(matches!(
                                host_status,
                                HostValidationStatusFact::Awaiting
                                    | HostValidationStatusFact::Failed
                            )),
                            ..Default::default()
                        },
                    ),
                    refused: false,
                    refuse_code: None,
                    skipped: false,
                    skip_code: None,
                    compact_ran: true,
                },
            );
        }

        let mut effects = effects_so_far;
        if !protected_ids.is_empty() {
            effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
                protected_tool_call_ids: protected_ids.clone(),
                location: "open_turn_tail".to_string(),
            });
        }
        if let Some(adv) = boundary_advance {
            effects.push(adv);
        }
        effects.push(CompactContinuationEffect::InstallServingView);
        if needs_await_effect {
            effects.push(CompactContinuationEffect::AwaitHostValidation {
                attempt_id_scope: "current_attempt".to_string(),
            });
        }
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
                    next_allowed,
                    ResidualExtrasOver {
                        relief_path: Some(if escalated_pending {
                            if host_status == HostValidationStatusFact::Awaiting {
                                CompactContinuationReliefPath::HostValidationAwaiting
                            } else {
                                CompactContinuationReliefPath::ProtectedEscalation
                            }
                        } else {
                            CompactContinuationReliefPath::None
                        }),
                        protected_tool_call_ids: Some(protected_ids),
                        host_validation_status: Some(host_status),
                        core_install_retained_pending_host_validation: Some(matches!(
                            host_status,
                            HostValidationStatusFact::Awaiting | HostValidationStatusFact::Failed
                        )),
                        ..Default::default()
                    },
                ),
                refused: false,
                refuse_code: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    // ── preserve_tool ─────────────────────────────────────────────────────────
    let protected_tool_call_ids = protected_ids_of(input);
    let mut effects_so_far = vec![
        CompactContinuationEffect::ClaimWriter {
            writer: ClaimWriterTarget::Lhc,
        },
        compact_effect(input),
    ];
    let mut path_after_claim = branch_path;
    path_after_claim.push(CompactContinuationState::Compacting);

    if !material.compact_structurally_valid {
        return refuse_after_preserve_attempt(
            input,
            &path_after_claim,
            CompactContinuationRefuseCode::CompactFailed,
            "compact assembly could not produce a structurally valid view",
            effects_so_far,
            true,
        );
    }
    if !material.can_produce_valid_provider_request {
        return refuse_after_preserve_attempt(
            input,
            &path_after_claim,
            CompactContinuationRefuseCode::NoValidProviderRequest,
            "no structurally valid provider request can be produced",
            effects_so_far,
            true,
        );
    }

    insert_degrade_after_compact(&mut effects_so_far, &degradation_reasons);

    // Unsafe projected runway after preserve/escalation candidate (before install)
    // refuses without native fallback. Runtime must not install an unsafe view.
    if material.maximal_prune_insufficient || material.projected_pressure_safe == Some(false) {
        return refuse_after_preserve_attempt(
            input,
            &path_after_claim,
            CompactContinuationRefuseCode::UnsafeRunway,
            if material.maximal_prune_insufficient {
                "maximal eligible unprotected pruning cannot produce safe projected runway"
            } else {
                "projected pressure remains at or above host safe-runway threshold"
            },
            effects_so_far,
            true,
        );
    }

    if !material.install_succeeds {
        let mut install_fail_effects = effects_so_far;
        install_fail_effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
            protected_tool_call_ids: protected_tool_call_ids.clone(),
            location: "open_turn_tail".to_string(),
        });
        let mut path_installing = path_after_claim.clone();
        path_installing.push(CompactContinuationState::Installing);
        return refuse_after_preserve_attempt(
            input,
            &path_installing,
            CompactContinuationRefuseCode::InstallFailed,
            "post-compact serving view could not be installed",
            install_fail_effects,
            true,
        );
    }

    let host_status = material.host_validation_status;
    let next_allowed = matches!(
        host_status,
        HostValidationStatusFact::NotRequired | HostValidationStatusFact::Ok
    );
    let core_retained = matches!(
        host_status,
        HostValidationStatusFact::Awaiting | HostValidationStatusFact::Failed
    );

    if !material.useful_reduction {
        let mut effects = effects_so_far;
        effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
            protected_tool_call_ids: protected_tool_call_ids.clone(),
            location: "open_turn_tail".to_string(),
        });
        effects.push(CompactContinuationEffect::InstallServingView);
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
                    next_allowed,
                    ResidualExtrasOver {
                        relief_path: Some(CompactContinuationReliefPath::NormalPreserve),
                        host_validation_status: Some(host_status),
                        core_install_retained_pending_host_validation: Some(core_retained),
                        ..Default::default()
                    },
                ),
                refused: false,
                refuse_code: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    let mut effects = effects_so_far;
    effects.push(CompactContinuationEffect::PreserveToolPairsVerbatim {
        protected_tool_call_ids: protected_tool_call_ids.clone(),
        location: "open_turn_tail".to_string(),
    });
    effects.push(CompactContinuationEffect::InstallServingView);
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
                next_allowed,
                ResidualExtrasOver {
                    relief_path: Some(CompactContinuationReliefPath::NormalPreserve),
                    host_validation_status: Some(host_status),
                    core_install_retained_pending_host_validation: Some(core_retained),
                    ..Default::default()
                },
            ),
            refused: false,
            refuse_code: None,
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

/// Evaluate compact-continuation for a completed (or classifiable) seam.
///
/// Ordering is fixed (see `COMPACT_CONTINUATION_TRANSITION_ORDER`). Capability-
/// limited hosts still receive the full decision table; they must not claim
/// effects they cannot perform (host adapter concern, not decision rewriting).
pub fn decide_compact_continuation(
    input: &CompactContinuationInput,
) -> CompactContinuationDecision {
    if input.contract_version != COMPACT_CONTINUATION_CONTRACT_VERSION {
        return refuse_unsupported_version(input);
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

    if seam.input_epoch_at_decision != seam.input_epoch_at_apply {
        return skip(
            input,
            &path,
            CompactContinuationSkipCode::InputEpochChanged,
            &format!(
                "input epoch changed ({}→{}); skip seam",
                seam.input_epoch_at_decision, seam.input_epoch_at_apply
            ),
        );
    }

    // Stage: forced_boundary_state_legality — after epoch, before writer/capture.
    // v2: applied boundary is legal with active_non_tool OR pending protected-tool
    // escalation (pending_correlated_tool_result). Other kinds remain illegal.
    if is_applied_boundary(&input.forced_continuation_boundary).is_some()
        && !matches!(
            input.continuation,
            WorkContinuation::ActiveNonTool | WorkContinuation::PendingCorrelatedToolResult { .. }
        )
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
            &format!(
                "forcedContinuationBoundary.applied requires active_non_tool or pending_correlated_tool_result; got {}",
                input.continuation.kind_str()
            ),
        );
    }
    if let Some(boundary) = is_applied_boundary(&input.forced_continuation_boundary)
        && boundary.continuation_turn_id.is_empty()
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
            "forcedContinuationBoundary.continuationTurnId must be a non-empty turn id when applied",
        );
    }
    if let Some(boundary) = is_applied_boundary(&input.forced_continuation_boundary)
        && boundary.forced_this_seam
        && boundary.marker_already_persisted
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
            "forcedContinuationBoundary.forcedThisSeam true cannot pair with markerAlreadyPersisted true (fresh turn_end marker cannot already exist)",
        );
    }

    if matches!(
        input.invariants.writer_claim,
        WriterClaim::Conflict | WriterClaim::Native
    ) {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::NativeWriterConflict,
            "LHC and host-native compact must be one writer at a seam; native/conflict claim refuses silent mid-turn fallback",
        );
    }

    if !input.invariants.capture_complete {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::IncompleteCapture,
            "capture of the settled model turn is incomplete; canonical record is not trustworthy",
        );
    }

    if !input.invariants.provider_identity_valid {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidProviderIdentity,
            "required provider/model identity cannot be proven; next provider request is not trustworthy",
        );
    }

    if !input.invariants.single_open_turn {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::OpenTurnInvariantBroken,
            "exactly-one-open-turn invariant does not hold",
        );
    }

    if let WorkContinuation::PendingCorrelatedToolResult {
        correlation_valid, ..
    } = &input.continuation
        && !*correlation_valid
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidToolCorrelation,
            "pending tool-result continuation requires proven call/result correlation",
        );
    }
    if let WorkContinuation::PendingCorrelatedToolResult {
        protected_tool_call_ids,
        ..
    } = &input.continuation
        && normalize_protected_tool_call_ids(protected_tool_call_ids).is_empty()
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidProtectedToolPairs,
            "protectedToolCallIds must be a sorted unique non-empty set",
        );
    }

    let mut eval_path = path;
    eval_path.push(CompactContinuationState::EvaluatingPressure);

    if is_applied_boundary(&input.forced_continuation_boundary).is_some() {
        return post_compact_tail(input, &eval_path, Branch::ContinueTurn);
    }

    if !input.provider_usage.is_available() {
        if matches!(input.continuation, WorkContinuation::None) {
            return normal_complete(input, &eval_path, "no_provider_usage_work_complete");
        }
        return continue_normal(input, &eval_path, "no_provider_usage", false);
    }

    let pressure = pressure_receipt(input);
    if pressure.at_or_above_trigger != Some(true) {
        if matches!(input.continuation, WorkContinuation::None) {
            return normal_complete(input, &eval_path, "below_trigger_work_complete");
        }
        return continue_normal(input, &eval_path, "below_trigger", true);
    }

    if matches!(input.continuation, WorkContinuation::None) {
        return normal_complete(input, &eval_path, "normal_complete_above_pressure");
    }

    if matches!(
        input.continuation,
        WorkContinuation::PendingCorrelatedToolResult { .. }
    ) {
        return post_compact_tail(input, &eval_path, Branch::PreserveTool);
    }

    // active_non_tool above trigger without applied boundary
    refuse_early(
        input,
        &eval_path,
        CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
        "active_non_tool above trigger requires forcedContinuationBoundary.applied with continuationTurnId (runtime forces turn_end first)",
    )
}
