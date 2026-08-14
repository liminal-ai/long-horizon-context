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
    CompactContinuationResidualState, CompactContinuationSkipCode, CompactContinuationState,
    ForcedContinuationBoundary, ForcedContinuationBoundaryApplied, WorkContinuation, WriterClaim,
    compact_continuation_marker_idempotency_key,
};

fn is_applied_boundary(
    b: &ForcedContinuationBoundary,
) -> Option<&ForcedContinuationBoundaryApplied> {
    b.as_applied()
}

fn pressure_receipt(input: &CompactContinuationInput) -> CompactContinuationPressureReceipt {
    let provider_usage = &input.provider_usage;
    let estimate = &input.post_measurement_estimate;
    let policy = &input.policy;
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
        },
        Some(total) => {
            let next = total + estimate.tokens;
            CompactContinuationPressureReceipt {
                provider_base_tokens: Some(total),
                provider_base_domain: "provider_reported_input".to_string(),
                estimate_tokens: estimate.tokens,
                estimate_source: estimate.source.clone(),
                estimate_domain: "source_labelled_estimate".to_string(),
                next_request_pressure_tokens: Some(next),
                upper_trigger_tokens: policy.upper_trigger_tokens,
                at_or_above_trigger: Some(next >= policy.upper_trigger_tokens),
            }
        }
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
                CompactContinuationResidualState {
                    writer_released: true,
                    prior_serving_view_intact: true,
                    forced_continuation_boundary_applied: false,
                    continuation_turn_opened: false,
                    continuation_turn_id: None,
                    marker_persisted: false,
                    marker_served: false,
                    original_agentic_turn_still_open: true,
                    next_provider_request_allowed: false,
                },
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
    };
    let residual = CompactContinuationResidualState {
        writer_released: true,
        prior_serving_view_intact: true,
        forced_continuation_boundary_applied: false,
        continuation_turn_opened: false,
        continuation_turn_id: None,
        marker_persisted: false,
        marker_served: false,
        original_agentic_turn_still_open: true,
        next_provider_request_allowed: false,
    };
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
                CompactContinuationResidualState {
                    writer_released: true,
                    prior_serving_view_intact: true,
                    forced_continuation_boundary_applied: false,
                    continuation_turn_opened: false,
                    continuation_turn_id: None,
                    marker_persisted: false,
                    marker_served: false,
                    original_agentic_turn_still_open: true,
                    next_provider_request_allowed: false,
                },
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
            residual: CompactContinuationResidualState {
                writer_released: true,
                prior_serving_view_intact: true,
                forced_continuation_boundary_applied: false,
                continuation_turn_opened: false,
                continuation_turn_id: None,
                marker_persisted: false,
                marker_served: false,
                original_agentic_turn_still_open: true,
                next_provider_request_allowed: true,
            },
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
            residual: CompactContinuationResidualState {
                writer_released: true,
                prior_serving_view_intact: true,
                forced_continuation_boundary_applied: false,
                continuation_turn_opened: false,
                continuation_turn_id: None,
                marker_persisted: false,
                marker_served: false,
                original_agentic_turn_still_open: false,
                next_provider_request_allowed: true,
            },
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
            residual: CompactContinuationResidualState {
                writer_released: true,
                prior_serving_view_intact: true,
                forced_continuation_boundary_applied: false,
                continuation_turn_opened: false,
                continuation_turn_id: None,
                marker_persisted: false,
                marker_served: false,
                original_agentic_turn_still_open: true,
                next_provider_request_allowed: false,
            },
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
            residual: CompactContinuationResidualState {
                writer_released: true,
                prior_serving_view_intact: true,
                forced_continuation_boundary_applied: true,
                continuation_turn_opened: true,
                continuation_turn_id: Some(continuation_turn_id.to_string()),
                marker_persisted,
                marker_served: false,
                original_agentic_turn_still_open: false,
                next_provider_request_allowed: false,
            },
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

    if branch == Branch::ContinueTurn {
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

        if !material.useful_reduction {
            let mut effects = effects_so_far;
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
                    residual: CompactContinuationResidualState {
                        writer_released: true,
                        prior_serving_view_intact: false,
                        forced_continuation_boundary_applied: true,
                        continuation_turn_opened: true,
                        continuation_turn_id: Some(continuation_turn_id),
                        marker_persisted: true,
                        marker_served: true,
                        original_agentic_turn_still_open: false,
                        next_provider_request_allowed: true,
                    },
                    refused: false,
                    refuse_code: None,
                    skipped: false,
                    skip_code: None,
                    compact_ran: true,
                },
            );
        }

        let mut effects = effects_so_far;
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
                residual: CompactContinuationResidualState {
                    writer_released: true,
                    prior_serving_view_intact: false,
                    forced_continuation_boundary_applied: true,
                    continuation_turn_opened: true,
                    continuation_turn_id: Some(continuation_turn_id),
                    marker_persisted: true,
                    marker_served: true,
                    original_agentic_turn_still_open: false,
                    next_provider_request_allowed: true,
                },
                refused: false,
                refuse_code: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    // preserve_tool
    let WorkContinuation::PendingCorrelatedToolResult { tool_call_id, .. } = &input.continuation
    else {
        // Mirrors TS throw — unreachable for valid oracle callers.
        panic!("preserve_tool branch requires pending_correlated_tool_result");
    };
    let tool_call_id = tool_call_id.clone();
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

    if !material.install_succeeds {
        let mut install_fail_effects = effects_so_far;
        install_fail_effects.push(CompactContinuationEffect::PreserveToolPairVerbatim {
            tool_call_id,
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

    if !material.useful_reduction {
        let mut effects = effects_so_far;
        effects.push(CompactContinuationEffect::PreserveToolPairVerbatim {
            tool_call_id,
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
                residual: CompactContinuationResidualState {
                    writer_released: true,
                    prior_serving_view_intact: false,
                    forced_continuation_boundary_applied: false,
                    continuation_turn_opened: false,
                    continuation_turn_id: None,
                    marker_persisted: false,
                    marker_served: false,
                    original_agentic_turn_still_open: true,
                    next_provider_request_allowed: true,
                },
                refused: false,
                refuse_code: None,
                skipped: false,
                skip_code: None,
                compact_ran: true,
            },
        );
    }

    let mut effects = effects_so_far;
    effects.push(CompactContinuationEffect::PreserveToolPairVerbatim {
        tool_call_id,
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
            residual: CompactContinuationResidualState {
                writer_released: true,
                prior_serving_view_intact: false,
                forced_continuation_boundary_applied: false,
                continuation_turn_opened: false,
                continuation_turn_id: None,
                marker_persisted: false,
                marker_served: false,
                original_agentic_turn_still_open: true,
                next_provider_request_allowed: true,
            },
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
    if is_applied_boundary(&input.forced_continuation_boundary).is_some()
        && !matches!(input.continuation, WorkContinuation::ActiveNonTool)
    {
        return refuse_early(
            input,
            &path,
            CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation,
            &format!(
                "forcedContinuationBoundary.applied requires continuation.kind active_non_tool; got {}",
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
