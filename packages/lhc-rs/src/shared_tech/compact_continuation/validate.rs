//! Structural validation for compact-continuation parity fixtures and receipts.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/validate.ts`.
//! Pure: no I/O. Closed-shape input validation uses explicit per-variant key
//! checks (naive enum `deny_unknown_fields` is insufficient for untagged /
//! internally-tagged unions — see `COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE`).

use serde_json::Value;

use super::contract::{
    COMPACT_CONTINUATION_CONTRACT_VERSION, COMPACT_CONTINUATION_HOST_CAPABILITIES,
    COMPACT_CONTINUATION_MARKER_ACTION, COMPACT_CONTINUATION_MARKER_CAUSE,
    COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX, COMPACT_CONTINUATION_MARKER_KIND,
    COMPACT_CONTINUATION_OUTCOME_KINDS, COMPACT_CONTINUATION_REFUSE_CODES,
    COMPACT_CONTINUATION_RELIEF_PATHS, COMPACT_CONTINUATION_SKIP_CODES,
    COMPACT_CONTINUATION_STATES, COMPACT_CONTINUATION_WARNING_CODES,
    COMPACT_CONTINUATION_WRITER_CLAIMS, CONTEXT_COMPACT_CONTINUE_REASON,
    CompactContinuationDecision, CompactContinuationInput,
    compact_continuation_marker_idempotency_key, js_string_cmp,
};
use crate::shared_tech::js_json::js_json_stringify_of;

/// Number.MAX_SAFE_INTEGER — JS safe-integer upper bound used by the TS validator.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

fn issue(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        path: path.into(),
        message: message.into(),
    }
}

/// Accept JSON numbers that are finite non-negative safe integers.
///
/// Matches JS `Number.isSafeInteger(n) && n >= 0`: a JSON spelling of `1.0` is
/// accepted (JS has one Number type; TS cannot distinguish it from `1`), while
/// fractional (`1.5`), negative, non-finite, and values above
/// `Number.MAX_SAFE_INTEGER` are rejected.
fn is_safe_non_neg_int(value: &Value) -> bool {
    as_safe_non_neg_int(value).is_some()
}

/// Extract a non-negative safe integer from a JSON number, including integral
/// float spellings such as `1.0` (serde_json may surface those as f64).
fn as_safe_non_neg_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return (0..=MAX_SAFE_INTEGER).contains(&i).then_some(i);
            }
            if let Some(u) = n.as_u64() {
                if u <= MAX_SAFE_INTEGER as u64 {
                    return Some(u as i64);
                }
                return None;
            }
            // Integral floats like 1.0 arrive as f64 through serde_json when
            // they were spelled with a fractional part of zero in JSON.
            if let Some(f) = n.as_f64() {
                if !f.is_finite() || f < 0.0 || f > MAX_SAFE_INTEGER as f64 {
                    return None;
                }
                if f.fract() == 0.0 {
                    return Some(f as i64);
                }
            }
            None
        }
        _ => None,
    }
}

fn is_bool(value: &Value) -> bool {
    value.is_boolean()
}

fn reject_unknown_keys(
    obj: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let allow: std::collections::HashSet<&str> = allowed.iter().copied().collect();
    for key in obj.keys() {
        if !allow.contains(key.as_str()) {
            issues.push(issue(
                format!("{path}.{key}"),
                "unknown field (closed-shape input rejects unknown keys)",
            ));
        }
    }
}

fn require_bool(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    match obj.get(key) {
        Some(v) if is_bool(v) => {}
        _ => issues.push(issue(format!("{path}.{key}"), "must be a boolean")),
    }
}

fn validate_seam(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("seam", "required object"));
        return;
    };
    reject_unknown_keys(
        obj,
        &[
            "modelResponseComplete",
            "requestedToolsSettled",
            "captureFlushed",
            "beforeNextProviderRequest",
            "insideTransportRetry",
            "inputEpochAtDecision",
            "inputEpochAtApply",
        ],
        "seam",
        issues,
    );
    for k in [
        "modelResponseComplete",
        "requestedToolsSettled",
        "captureFlushed",
        "beforeNextProviderRequest",
        "insideTransportRetry",
    ] {
        require_bool(obj, k, "seam", issues);
    }
    if !is_safe_non_neg_int(obj.get("inputEpochAtDecision").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "seam.inputEpochAtDecision",
            "must be a non-negative safe integer",
        ));
    }
    if !is_safe_non_neg_int(obj.get("inputEpochAtApply").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "seam.inputEpochAtApply",
            "must be a non-negative safe integer",
        ));
    }
}

fn validate_provider_usage(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("providerUsage", "required object"));
        return;
    };
    match obj.get("available") {
        Some(v) if is_bool(v) => {}
        _ => {
            issues.push(issue("providerUsage.available", "must be a boolean"));
            return;
        }
    }
    let available = obj.get("available").and_then(|v| v.as_bool()) == Some(true);
    if available {
        reject_unknown_keys(
            obj,
            &[
                "available",
                "inputTokens",
                "cacheCreationTokens",
                "cacheReadTokens",
                "total",
                "domain",
            ],
            "providerUsage",
            issues,
        );
    } else {
        reject_unknown_keys(
            obj,
            &["available", "reason", "domain"],
            "providerUsage",
            issues,
        );
    }
    if obj.get("domain").and_then(|v| v.as_str()) != Some("provider_reported_input") {
        issues.push(issue(
            "providerUsage.domain",
            "must be \"provider_reported_input\"",
        ));
    }
    if available {
        for k in [
            "inputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "total",
        ] {
            if !is_safe_non_neg_int(obj.get(k).unwrap_or(&Value::Null)) {
                issues.push(issue(
                    format!("providerUsage.{k}"),
                    "must be a non-negative safe integer",
                ));
            }
        }
        let input = obj.get("inputTokens").and_then(as_safe_non_neg_int);
        let cache_c = obj.get("cacheCreationTokens").and_then(as_safe_non_neg_int);
        let cache_r = obj.get("cacheReadTokens").and_then(as_safe_non_neg_int);
        let total = obj.get("total").and_then(as_safe_non_neg_int);
        if let (Some(i), Some(c), Some(r), Some(t)) = (input, cache_c, cache_r, total) {
            match i.checked_add(c).and_then(|x| x.checked_add(r)) {
                Some(sum) if sum <= MAX_SAFE_INTEGER => {
                    if sum != t {
                        issues.push(issue(
                            "providerUsage.total",
                            format!("must equal input+cacheCreation+cacheRead ({sum}), got {t}"),
                        ));
                    }
                }
                _ => issues.push(issue(
                    "providerUsage.total",
                    "component sum is not a safe integer",
                )),
            }
        }
    } else {
        match obj.get("reason").and_then(|v| v.as_str()) {
            Some("missing") | Some("invalid") => {}
            _ => issues.push(issue(
                "providerUsage.reason",
                "must be \"missing\" or \"invalid\" when unavailable",
            )),
        }
    }
}

fn validate_estimate(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("postMeasurementEstimate", "required object"));
        return;
    };
    reject_unknown_keys(
        obj,
        &["tokens", "source", "domain"],
        "postMeasurementEstimate",
        issues,
    );
    if !is_safe_non_neg_int(obj.get("tokens").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "postMeasurementEstimate.tokens",
            "must be a non-negative safe integer",
        ));
    }
    match obj.get("source").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {}
        _ => issues.push(issue(
            "postMeasurementEstimate.source",
            "must be a non-empty string label",
        )),
    }
    if obj.get("domain").and_then(|v| v.as_str()) != Some("source_labelled_estimate") {
        issues.push(issue(
            "postMeasurementEstimate.domain",
            "must be \"source_labelled_estimate\"",
        ));
    }
}

fn validate_policy(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("policy", "required object"));
        return;
    };
    reject_unknown_keys(
        obj,
        &[
            "upperTriggerTokens",
            "lowerTargetTokens",
            "hostCapability",
            "safeRunwayThresholdTokens",
            "safeRunwayThresholdSource",
            "compactRetryBudget",
        ],
        "policy",
        issues,
    );
    if !is_safe_non_neg_int(obj.get("upperTriggerTokens").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "policy.upperTriggerTokens",
            "must be a non-negative safe integer",
        ));
    }
    if !is_safe_non_neg_int(obj.get("lowerTargetTokens").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "policy.lowerTargetTokens",
            "must be a non-negative safe integer",
        ));
    }
    match obj.get("hostCapability").and_then(|v| v.as_str()) {
        Some(s) if COMPACT_CONTINUATION_HOST_CAPABILITIES.contains(&s) => {}
        _ => issues.push(issue(
            "policy.hostCapability",
            "must be full_state_machine or capability_limited",
        )),
    }
    if let Some(threshold) = obj.get("safeRunwayThresholdTokens")
        && !is_safe_non_neg_int(threshold)
    {
        issues.push(issue(
            "policy.safeRunwayThresholdTokens",
            "must be a non-negative safe integer when present",
        ));
    }
    if let Some(source) = obj.get("safeRunwayThresholdSource")
        && !source.as_str().is_some_and(|s| !s.is_empty())
    {
        issues.push(issue(
            "policy.safeRunwayThresholdSource",
            "must be a non-empty string when present",
        ));
    }
    if let Some(budget) = obj.get("compactRetryBudget")
        && !as_safe_non_neg_int(budget).is_some_and(|b| b >= 1)
    {
        issues.push(issue(
            "policy.compactRetryBudget",
            "must be a safe integer >= 1 when present",
        ));
    }
}

fn validate_continuation(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("continuation", "required object"));
        return;
    };
    let kind = obj.get("kind").and_then(|v| v.as_str());
    let kind_ok = matches!(
        kind,
        Some("none") | Some("pending_correlated_tool_result") | Some("active_non_tool")
    );
    if !kind_ok {
        issues.push(issue(
            "continuation.kind",
            "must be none | pending_correlated_tool_result | active_non_tool",
        ));
        return;
    }
    if kind == Some("none") || kind == Some("active_non_tool") {
        reject_unknown_keys(obj, &["kind"], "continuation", issues);
    } else {
        reject_unknown_keys(
            obj,
            &["kind", "protectedToolCallIds", "correlationValid"],
            "continuation",
            issues,
        );
    }
    if kind == Some("pending_correlated_tool_result") {
        // Reject dual-field shim / legacy single id.
        if obj.contains_key("toolCallId") {
            issues.push(issue(
                "continuation.toolCallId",
                "removed in contract 2.0.0; use protectedToolCallIds",
            ));
        }
        match obj.get("protectedToolCallIds").and_then(|v| v.as_array()) {
            Some(ids) if !ids.is_empty() => {
                let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
                let mut prev: Option<&str> = None;
                let mut string_count = 0usize;
                for (i, id) in ids.iter().enumerate() {
                    let Some(id) = id.as_str().filter(|v| !v.is_empty()) else {
                        issues.push(issue(
                            format!("continuation.protectedToolCallIds[{i}]"),
                            "must be non-empty string",
                        ));
                        continue;
                    };
                    string_count += 1;
                    if !seen.insert(id) {
                        issues.push(issue(
                            format!("continuation.protectedToolCallIds[{i}]"),
                            "duplicate id",
                        ));
                    }
                    if let Some(prev) = prev
                        && js_string_cmp(id, prev) == std::cmp::Ordering::Less
                    {
                        issues.push(issue(
                            "continuation.protectedToolCallIds",
                            "must be sorted ascending",
                        ));
                    }
                    prev = Some(id);
                }
                // TS: normalized (unique non-empty) length must equal input length.
                if seen.len() != ids.len() || string_count != ids.len() {
                    issues.push(issue(
                        "continuation.protectedToolCallIds",
                        "must be unique non-empty strings",
                    ));
                }
            }
            _ => issues.push(issue(
                "continuation.protectedToolCallIds",
                "required non-empty string array",
            )),
        }
        if !obj.get("correlationValid").map(is_bool).unwrap_or(false) {
            issues.push(issue("continuation.correlationValid", "must be a boolean"));
        }
    }
}

fn validate_invariants(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("invariants", "required object"));
        return;
    };
    reject_unknown_keys(
        obj,
        &[
            "captureComplete",
            "providerIdentityValid",
            "singleOpenTurn",
            "writerClaim",
            "writerOwnershipAuthority",
        ],
        "invariants",
        issues,
    );
    for k in ["captureComplete", "providerIdentityValid", "singleOpenTurn"] {
        require_bool(obj, k, "invariants", issues);
    }
    match obj.get("writerClaim").and_then(|v| v.as_str()) {
        Some(s) if COMPACT_CONTINUATION_WRITER_CLAIMS.contains(&s) => {}
        _ => issues.push(issue(
            "invariants.writerClaim",
            "must be none | lhc | native | conflict",
        )),
    }
    match obj.get("writerOwnershipAuthority") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s == "no_live_owner" || s == "live_owner" => {}
        _ => issues.push(issue(
            "invariants.writerOwnershipAuthority",
            "must be no_live_owner | live_owner | null",
        )),
    }
}

fn validate_forced_boundary(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("forcedContinuationBoundary", "required object"));
        return;
    };
    match obj.get("applied") {
        Some(v) if is_bool(v) => {}
        _ => {
            issues.push(issue(
                "forcedContinuationBoundary.applied",
                "must be a boolean",
            ));
            return;
        }
    }
    if obj.get("applied").and_then(|v| v.as_bool()) == Some(false) {
        reject_unknown_keys(obj, &["applied"], "forcedContinuationBoundary", issues);
        return;
    }
    reject_unknown_keys(
        obj,
        &[
            "applied",
            "continuationTurnId",
            "forcedThisSeam",
            "markerAlreadyPersisted",
        ],
        "forcedContinuationBoundary",
        issues,
    );
    match obj.get("continuationTurnId").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {
            if !s.starts_with('t') || s.len() < 2 || !s[1..].chars().all(|c| c.is_ascii_digit()) {
                issues.push(issue(
                    "forcedContinuationBoundary.continuationTurnId",
                    "must match turn id shape t<digits>",
                ));
            }
        }
        _ => issues.push(issue(
            "forcedContinuationBoundary.continuationTurnId",
            "required non-empty string when applied",
        )),
    }
    if !obj.get("forcedThisSeam").map(is_bool).unwrap_or(false) {
        issues.push(issue(
            "forcedContinuationBoundary.forcedThisSeam",
            "must be a boolean when applied",
        ));
    }
    if !obj
        .get("markerAlreadyPersisted")
        .map(is_bool)
        .unwrap_or(false)
    {
        issues.push(issue(
            "forcedContinuationBoundary.markerAlreadyPersisted",
            "must be a boolean when applied",
        ));
    }
    if obj.get("forcedThisSeam").and_then(|v| v.as_bool()) == Some(true)
        && obj.get("markerAlreadyPersisted").and_then(|v| v.as_bool()) == Some(true)
    {
        issues.push(issue(
            "forcedContinuationBoundary",
            "forcedThisSeam true cannot pair with markerAlreadyPersisted true (fresh turn_end marker cannot already exist)",
        ));
    }
}

fn validate_material(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("compactMaterial", "required object"));
        return;
    };
    reject_unknown_keys(
        obj,
        &[
            "derivationsMissingOrFailed",
            "lowerTargetMet",
            "compactStructurallyValid",
            "installSucceeds",
            "usefulReduction",
            "canProduceValidProviderRequest",
            "projectedPressureTokens",
            "renderedSavingsTokens",
            "renderedSavingsSource",
            "renderedSavingsDomain",
            "safeRunwayThresholdTokens",
            "safeRunwayThresholdSource",
            "projectedPressureSafe",
            "protectedEscalationApplied",
            "visibilityBoundaryBefore",
            "visibilityBoundaryAfter",
            "compactPointAtInstall",
            "maximalPruneInsufficient",
            "compactAttemptIndex",
            "hostValidationStatus",
        ],
        "compactMaterial",
        issues,
    );
    for k in [
        "derivationsMissingOrFailed",
        "lowerTargetMet",
        "compactStructurallyValid",
        "installSucceeds",
        "usefulReduction",
        "canProduceValidProviderRequest",
        "protectedEscalationApplied",
        "maximalPruneInsufficient",
    ] {
        require_bool(obj, k, "compactMaterial", issues);
    }
    match obj.get("projectedPressureTokens") {
        Some(Value::Null) => {}
        Some(v) if is_safe_non_neg_int(v) => {}
        _ => issues.push(issue(
            "compactMaterial.projectedPressureTokens",
            "must be null or non-negative safe integer",
        )),
    }
    if !is_safe_non_neg_int(obj.get("renderedSavingsTokens").unwrap_or(&Value::Null)) {
        issues.push(issue(
            "compactMaterial.renderedSavingsTokens",
            "must be a non-negative safe integer",
        ));
    }
    if !obj
        .get("renderedSavingsSource")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
    {
        issues.push(issue(
            "compactMaterial.renderedSavingsSource",
            "must be a non-empty string",
        ));
    }
    if obj.get("renderedSavingsDomain").and_then(|v| v.as_str()) != Some("source_labelled_estimate")
    {
        issues.push(issue(
            "compactMaterial.renderedSavingsDomain",
            "must be \"source_labelled_estimate\"",
        ));
    }
    match obj.get("safeRunwayThresholdTokens") {
        Some(Value::Null) => {}
        Some(v) if is_safe_non_neg_int(v) => {}
        _ => issues.push(issue(
            "compactMaterial.safeRunwayThresholdTokens",
            "must be null or non-negative safe integer",
        )),
    }
    match obj.get("safeRunwayThresholdSource") {
        Some(Value::Null) => {}
        Some(v) if v.as_str().is_some_and(|s| !s.is_empty()) => {}
        _ => issues.push(issue(
            "compactMaterial.safeRunwayThresholdSource",
            "must be null or non-empty string",
        )),
    }
    match obj.get("projectedPressureSafe") {
        Some(Value::Null) | Some(Value::Bool(_)) => {}
        _ => issues.push(issue(
            "compactMaterial.projectedPressureSafe",
            "must be boolean or null",
        )),
    }
    for k in [
        "visibilityBoundaryBefore",
        "visibilityBoundaryAfter",
        "compactPointAtInstall",
    ] {
        match obj.get(k) {
            Some(Value::Null) => {}
            Some(v) if is_safe_non_neg_int(v) => {}
            _ => issues.push(issue(
                format!("compactMaterial.{k}"),
                "must be null or non-negative safe integer",
            )),
        }
    }
    match obj.get("hostValidationStatus").and_then(|v| v.as_str()) {
        Some("not_required") | Some("awaiting") | Some("ok") | Some("failed") => {}
        _ => issues.push(issue(
            "compactMaterial.hostValidationStatus",
            "must be not_required|awaiting|ok|failed",
        )),
    }
    if let Some(idx) = obj.get("compactAttemptIndex")
        && !as_safe_non_neg_int(idx).is_some_and(|i| i >= 1)
    {
        issues.push(issue(
            "compactMaterial.compactAttemptIndex",
            "must be a safe integer >= 1 when present",
        ));
    }
}

/// Validate a CompactContinuationInput shape (fixture input side).
pub fn validate_compact_continuation_input(raw: &Value) -> ValidationResult {
    let mut issues = Vec::new();
    let Some(obj) = raw.as_object() else {
        return ValidationResult {
            ok: false,
            issues: vec![issue("$", "input must be an object")],
        };
    };
    match obj.get("contractVersion").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {}
        _ => issues.push(issue("contractVersion", "required non-empty string")),
    }
    reject_unknown_keys(
        obj,
        &[
            "contractVersion",
            "seam",
            "providerUsage",
            "postMeasurementEstimate",
            "policy",
            "continuation",
            "invariants",
            "forcedContinuationBoundary",
            "compactMaterial",
        ],
        "$",
        &mut issues,
    );
    validate_seam(obj.get("seam").unwrap_or(&Value::Null), &mut issues);
    validate_provider_usage(
        obj.get("providerUsage").unwrap_or(&Value::Null),
        &mut issues,
    );
    validate_estimate(
        obj.get("postMeasurementEstimate").unwrap_or(&Value::Null),
        &mut issues,
    );
    validate_policy(obj.get("policy").unwrap_or(&Value::Null), &mut issues);
    validate_continuation(obj.get("continuation").unwrap_or(&Value::Null), &mut issues);
    validate_invariants(obj.get("invariants").unwrap_or(&Value::Null), &mut issues);
    validate_forced_boundary(
        obj.get("forcedContinuationBoundary")
            .unwrap_or(&Value::Null),
        &mut issues,
    );
    validate_material(
        obj.get("compactMaterial").unwrap_or(&Value::Null),
        &mut issues,
    );

    // Reject unsafe combined token sums before arithmetic.
    if let (Some(usage), Some(est)) = (
        obj.get("providerUsage").and_then(|v| v.as_object()),
        obj.get("postMeasurementEstimate")
            .and_then(|v| v.as_object()),
    ) && usage.get("available").and_then(|v| v.as_bool()) == Some(true)
        && let (Some(total), Some(tokens)) = (
            usage.get("total").and_then(as_safe_non_neg_int),
            est.get("tokens").and_then(as_safe_non_neg_int),
        )
    {
        match total.checked_add(tokens) {
            Some(combined) if combined <= MAX_SAFE_INTEGER => {}
            _ => issues.push(issue(
                "postMeasurementEstimate.tokens",
                "provider total + estimate is not a safe integer; reject before arithmetic",
            )),
        }
    }

    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

const EFFECT_TYPES: &[&str] = &[
    "claim_writer",
    "release_writer",
    "force_turn_end",
    "compact",
    "preserve_tool_pairs_verbatim",
    "advance_visibility_boundary",
    "await_host_validation",
    "record_host_validation",
    "insert_continuation_marker",
    "install_serving_view",
    "record_receipt",
    "degrade_fidelity",
    "skip_seam",
    "warn",
    "omit_signed_reasoning",
    "reclaim_writer",
    "discard_pending_boundary",
    // Historical only — the refuse set is empty in this contract version (CX-S5).
    "refuse",
];

fn validate_effect(effect: &Value, path: &str, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = effect.as_object() else {
        issues.push(issue(path, "effect must be an object"));
        return;
    };
    let type_str = obj.get("type").and_then(|v| v.as_str());
    match type_str {
        Some(t) if EFFECT_TYPES.contains(&t) => {}
        other => {
            issues.push(issue(
                format!("{path}.type"),
                format!("unknown effect type {}", other.unwrap_or("null")),
            ));
            return;
        }
    }
    let type_str = type_str.unwrap();
    if type_str == "force_turn_end" {
        if obj.get("reason").and_then(|v| v.as_str()) != Some(CONTEXT_COMPACT_CONTINUE_REASON) {
            issues.push(issue(
                format!("{path}.reason"),
                format!("must be {CONTEXT_COMPACT_CONTINUE_REASON}"),
            ));
        }
        if obj.get("outcome").and_then(|v| v.as_str()) != Some("completed") {
            issues.push(issue(format!("{path}.outcome"), "must be \"completed\""));
        }
        if obj.get("opensContinuationTurn").and_then(|v| v.as_bool()) != Some(true) {
            issues.push(issue(
                format!("{path}.opensContinuationTurn"),
                "must be true",
            ));
        }
        if obj.get("continuationTurnCount").and_then(|v| v.as_i64()) != Some(1) {
            issues.push(issue(format!("{path}.continuationTurnCount"), "must be 1"));
        }
        match obj.get("continuationTurnId").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => {}
            _ => issues.push(issue(
                format!("{path}.continuationTurnId"),
                "required non-empty turn id",
            )),
        }
    }
    if type_str == "insert_continuation_marker" {
        if obj.get("kind").and_then(|v| v.as_str()) != Some(COMPACT_CONTINUATION_MARKER_KIND) {
            issues.push(issue(
                format!("{path}.kind"),
                format!("must be {COMPACT_CONTINUATION_MARKER_KIND}"),
            ));
        }
        match obj.get("continuationTurnId").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => {
                let expected_key = compact_continuation_marker_idempotency_key(s);
                if obj.get("idempotencyKey").and_then(|v| v.as_str()) != Some(expected_key.as_str())
                {
                    issues.push(issue(
                        format!("{path}.idempotencyKey"),
                        format!(
                            "must equal {COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX}<continuationTurnId> (expected {expected_key})"
                        ),
                    ));
                }
            }
            _ => issues.push(issue(
                format!("{path}.continuationTurnId"),
                "required non-empty turn id",
            )),
        }
        match obj.get("semantics").and_then(|v| v.as_object()) {
            Some(s) => {
                if s.get("cause").and_then(|v| v.as_str())
                    != Some(COMPACT_CONTINUATION_MARKER_CAUSE)
                {
                    issues.push(issue(
                        format!("{path}.semantics.cause"),
                        format!("must be {COMPACT_CONTINUATION_MARKER_CAUSE}"),
                    ));
                }
                if s.get("action").and_then(|v| v.as_str())
                    != Some(COMPACT_CONTINUATION_MARKER_ACTION)
                {
                    issues.push(issue(
                        format!("{path}.semantics.action"),
                        format!("must be {COMPACT_CONTINUATION_MARKER_ACTION}"),
                    ));
                }
                if s.get("newUserRequest").and_then(|v| v.as_bool()) != Some(false) {
                    issues.push(issue(
                        format!("{path}.semantics.newUserRequest"),
                        "must be false",
                    ));
                }
                if s.get("waitForUser").and_then(|v| v.as_bool()) != Some(false) {
                    issues.push(issue(
                        format!("{path}.semantics.waitForUser"),
                        "must be false",
                    ));
                }
            }
            None => issues.push(issue(format!("{path}.semantics"), "required object")),
        }
        if obj.get("userChatVisible").and_then(|v| v.as_bool()) != Some(false) {
            issues.push(issue(format!("{path}.userChatVisible"), "must be false"));
        }
        if obj.get("modelVisible").and_then(|v| v.as_bool()) != Some(true) {
            issues.push(issue(format!("{path}.modelVisible"), "must be true"));
        }
    }
    if type_str == "record_receipt" {
        if obj.get("userChatVisible").and_then(|v| v.as_bool()) != Some(false) {
            issues.push(issue(
                format!("{path}.userChatVisible"),
                "receipts must not be user chat",
            ));
        }
        if obj.get("durable").and_then(|v| v.as_bool()) != Some(true) {
            issues.push(issue(format!("{path}.durable"), "must be true"));
        }
    }
    if type_str == "preserve_tool_pairs_verbatim" {
        match obj.get("protectedToolCallIds").and_then(|v| v.as_array()) {
            Some(ids) if !ids.is_empty() => {
                for (i, id) in ids.iter().enumerate() {
                    if !id.as_str().is_some_and(|s| !s.is_empty()) {
                        issues.push(issue(
                            format!("{path}.protectedToolCallIds[{i}]"),
                            "must be non-empty string",
                        ));
                    }
                }
            }
            _ => issues.push(issue(
                format!("{path}.protectedToolCallIds"),
                "required non-empty string array",
            )),
        }
        if obj.get("location").and_then(|v| v.as_str()) != Some("open_turn_tail") {
            issues.push(issue(
                format!("{path}.location"),
                "must be \"open_turn_tail\"",
            ));
        }
    }
    if type_str == "advance_visibility_boundary" {
        for k in ["previousBoundary", "newBoundary", "compactPoint"] {
            if !is_safe_non_neg_int(obj.get(k).unwrap_or(&Value::Null)) {
                issues.push(issue(
                    format!("{path}.{k}"),
                    "must be a non-negative safe integer",
                ));
            }
        }
        if let (Some(prev), Some(new)) = (
            obj.get("previousBoundary").and_then(as_safe_non_neg_int),
            obj.get("newBoundary").and_then(as_safe_non_neg_int),
        ) && new < prev
        {
            issues.push(issue(
                format!("{path}.newBoundary"),
                "must be >= previousBoundary (monotonic)",
            ));
        }
    }
    if type_str == "await_host_validation"
        && obj.get("attemptIdScope").and_then(|v| v.as_str()) != Some("current_attempt")
    {
        issues.push(issue(
            format!("{path}.attemptIdScope"),
            "must be \"current_attempt\"",
        ));
    }
    if type_str == "record_host_validation"
        && !matches!(
            obj.get("result").and_then(|v| v.as_str()),
            Some("ok") | Some("failed")
        )
    {
        issues.push(issue(
            format!("{path}.result"),
            "must be \"ok\" or \"failed\"",
        ));
    }
    if type_str == "skip_seam" {
        match obj.get("code").and_then(|v| v.as_str()) {
            Some(c) if COMPACT_CONTINUATION_SKIP_CODES.contains(&c) => {}
            other => issues.push(issue(
                format!("{path}.code"),
                format!("unknown skip code {}", other.unwrap_or("null")),
            )),
        }
    }
    if type_str == "warn" {
        match obj.get("code").and_then(|v| v.as_str()) {
            Some(c) if COMPACT_CONTINUATION_WARNING_CODES.contains(&c) => {}
            other => issues.push(issue(
                format!("{path}.code"),
                format!("unknown warning code {}", other.unwrap_or("null")),
            )),
        }
        if !obj
            .get("reason")
            .and_then(|v| v.as_str())
            .is_some_and(|r| !r.is_empty())
        {
            issues.push(issue(
                format!("{path}.reason"),
                "warn requires a non-empty reason",
            ));
        }
    }
    if type_str == "omit_signed_reasoning"
        && !obj
            .get("reason")
            .and_then(|v| v.as_str())
            .is_some_and(|r| !r.is_empty())
    {
        issues.push(issue(
            format!("{path}.reason"),
            "omit_signed_reasoning requires a non-empty reason",
        ));
    }
    if type_str == "reclaim_writer" {
        match obj.get("priorClaim").and_then(|v| v.as_str()) {
            Some("native") | Some("conflict") => {}
            _ => issues.push(issue(
                format!("{path}.priorClaim"),
                "must be \"native\" or \"conflict\"",
            )),
        }
        if obj.get("hostAuthority").and_then(|v| v.as_str()) != Some("no_live_owner") {
            issues.push(issue(
                format!("{path}.hostAuthority"),
                "reclaim is legal only when host authority confirmed no_live_owner",
            ));
        }
    }
    if type_str == "discard_pending_boundary" {
        match obj.get("continuationTurnId") {
            Some(Value::Null) | Some(Value::String(_)) => {}
            _ => issues.push(issue(
                format!("{path}.continuationTurnId"),
                "must be a string or null",
            )),
        }
        if !obj
            .get("reason")
            .and_then(|v| v.as_str())
            .is_some_and(|r| !r.is_empty())
        {
            issues.push(issue(
                format!("{path}.reason"),
                "discard_pending_boundary requires a non-empty reason",
            ));
        }
    }
    if type_str == "refuse" {
        match obj.get("code").and_then(|v| v.as_str()) {
            Some(c) if COMPACT_CONTINUATION_REFUSE_CODES.contains(&c) => {}
            other => issues.push(issue(
                format!("{path}.code"),
                format!("unknown refuse code {}", other.unwrap_or("null")),
            )),
        }
    }
}

fn validate_residual(raw: &Value, issues: &mut Vec<ValidationIssue>) {
    let Some(obj) = raw.as_object() else {
        issues.push(issue("residual", "required object"));
        return;
    };
    for k in [
        "writerReleased",
        "priorServingViewIntact",
        "forcedContinuationBoundaryApplied",
        "continuationTurnOpened",
        "markerPersisted",
        "markerServed",
        "originalAgenticTurnStillOpen",
        "nextProviderRequestAllowed",
        "pendingBoundaryDiscarded",
        "coreInstallRetainedPendingHostValidation",
    ] {
        require_bool(obj, k, "residual", issues);
    }
    match obj.get("reliefPath").and_then(|v| v.as_str()) {
        Some(p) if COMPACT_CONTINUATION_RELIEF_PATHS.contains(&p) => {}
        _ => issues.push(issue("residual.reliefPath", "unknown relief path")),
    }
    if !matches!(obj.get("protectedToolCallIds"), Some(Value::Array(_))) {
        issues.push(issue("residual.protectedToolCallIds", "must be an array"));
    }
    match obj.get("hostValidationStatus").and_then(|v| v.as_str()) {
        Some("not_required") | Some("awaiting") | Some("ok") | Some("failed") => {}
        _ => issues.push(issue(
            "residual.hostValidationStatus",
            "must be not_required|awaiting|ok|failed",
        )),
    }
    for k in ["visibilityBoundaryBefore", "visibilityBoundaryAfter"] {
        match obj.get(k) {
            Some(Value::Null) => {}
            Some(v) if is_safe_non_neg_int(v) => {}
            _ => issues.push(issue(
                format!("residual.{k}"),
                "must be null or non-negative safe integer",
            )),
        }
    }
    if obj.get("writerReleased").and_then(|v| v.as_bool()) != Some(true) {
        issues.push(issue(
            "residual.writerReleased",
            "terminal receipts must release the writer",
        ));
    }
    if obj.get("markerServed").and_then(|v| v.as_bool()) == Some(true)
        && obj.get("markerPersisted").and_then(|v| v.as_bool()) != Some(true)
    {
        issues.push(issue(
            "residual.markerServed",
            "served requires markerPersisted",
        ));
    }
    // Always required present as string or null (TS validateResidual).
    match obj.get("continuationTurnId") {
        Some(Value::Null) | Some(Value::String(_)) => {}
        Some(_) => issues.push(issue(
            "residual.continuationTurnId",
            "must be string or null",
        )),
        None => issues.push(issue(
            "residual.continuationTurnId",
            "must be string or null",
        )),
    }
    if obj
        .get("forcedContinuationBoundaryApplied")
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        let id = obj.get("continuationTurnId");
        if id.is_none() || id == Some(&Value::Null) {
            issues.push(issue(
                "residual.continuationTurnId",
                "required when forcedContinuationBoundaryApplied",
            ));
        }
    }
}

/// Receipt structural rules shared by fixtures and live decisions.
pub fn validate_compact_continuation_receipt(raw: &Value) -> ValidationResult {
    let mut issues = Vec::new();
    let Some(obj) = raw.as_object() else {
        return ValidationResult {
            ok: false,
            issues: vec![issue("$", "receipt must be an object")],
        };
    };
    if obj.get("contractVersion").and_then(|v| v.as_str())
        != Some(COMPACT_CONTINUATION_CONTRACT_VERSION)
    {
        issues.push(issue("contractVersion", "oracle version mismatch"));
    }
    match obj.get("outcome").and_then(|v| v.as_str()) {
        Some(o) if COMPACT_CONTINUATION_OUTCOME_KINDS.contains(&o) => {}
        other => issues.push(issue(
            "outcome",
            format!("unknown outcome {}", other.unwrap_or("null")),
        )),
    }
    match obj.get("reasonCode").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => {}
        _ => issues.push(issue("reasonCode", "required non-empty string")),
    }
    match obj.get("turnEndReason") {
        Some(Value::Null) => {}
        Some(Value::String(s)) if s == CONTEXT_COMPACT_CONTINUE_REASON => {}
        _ => issues.push(issue(
            "turnEndReason",
            format!("must be null or {CONTEXT_COMPACT_CONTINUE_REASON}"),
        )),
    }

    match obj.get("effects") {
        Some(Value::Array(arr)) => {
            for (i, e) in arr.iter().enumerate() {
                validate_effect(e, &format!("effects[{i}]"), &mut issues);
            }
        }
        _ => issues.push(issue("effects", "must be an array")),
    }

    match obj.get("transitionPath") {
        Some(Value::Array(arr)) => {
            for (i, s) in arr.iter().enumerate() {
                match s.as_str() {
                    Some(st) if COMPACT_CONTINUATION_STATES.contains(&st) => {}
                    other => issues.push(issue(
                        format!("transitionPath[{i}]"),
                        format!("unknown state {}", other.unwrap_or("null")),
                    )),
                }
            }
        }
        _ => issues.push(issue("transitionPath", "must be an array")),
    }

    match obj.get("pressure").and_then(|v| v.as_object()) {
        Some(p) => {
            if p.get("providerBaseDomain").and_then(|v| v.as_str())
                != Some("provider_reported_input")
            {
                issues.push(issue(
                    "pressure.providerBaseDomain",
                    "must be \"provider_reported_input\"",
                ));
            }
            if p.get("estimateDomain").and_then(|v| v.as_str()) != Some("source_labelled_estimate")
            {
                issues.push(issue(
                    "pressure.estimateDomain",
                    "must be \"source_labelled_estimate\"",
                ));
            }
            // TS: providerBaseTokens === null && nextRequestPressureTokens !== null
            // treats absent as !== null and rejects. Require key present and null.
            if p.get("providerBaseTokens") == Some(&Value::Null) {
                match p.get("nextRequestPressureTokens") {
                    Some(Value::Null) => {}
                    _ => issues.push(issue(
                        "pressure.nextRequestPressureTokens",
                        "must be null when provider base is unavailable",
                    )),
                }
                match p.get("atOrAboveTrigger") {
                    Some(Value::Null) => {}
                    _ => issues.push(issue(
                        "pressure.atOrAboveTrigger",
                        "must be null when provider base is unavailable",
                    )),
                }
            }
        }
        None => issues.push(issue("pressure", "required object")),
    }

    match obj.get("lowerTarget").and_then(|v| v.as_object()) {
        Some(lt) => {
            if lt.get("domain").and_then(|v| v.as_str()) != Some("lhc_rendered_history") {
                issues.push(issue(
                    "lowerTarget.domain",
                    "must be \"lhc_rendered_history\"",
                ));
            }
            if lt.get("isSuccessGate").and_then(|v| v.as_bool()) != Some(false) {
                issues.push(issue("lowerTarget.isSuccessGate", "must be false"));
            }
        }
        None => issues.push(issue("lowerTarget", "required object")),
    }

    validate_residual(obj.get("residual").unwrap_or(&Value::Null), &mut issues);

    // Warnings mirror the ordered `warn` effects exactly (same codes, same order).
    match obj.get("warnings") {
        Some(Value::Array(warnings)) => {
            for (i, w) in warnings.iter().enumerate() {
                let Some(w) = w.as_object() else {
                    issues.push(issue(format!("warnings[{i}]"), "must be an object"));
                    continue;
                };
                match w.get("code").and_then(|v| v.as_str()) {
                    Some(c) if COMPACT_CONTINUATION_WARNING_CODES.contains(&c) => {}
                    other => issues.push(issue(
                        format!("warnings[{i}].code"),
                        format!("unknown warning code {}", other.unwrap_or("null")),
                    )),
                }
                if !w
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .is_some_and(|r| !r.is_empty())
                {
                    issues.push(issue(
                        format!("warnings[{i}].reason"),
                        "required non-empty string",
                    ));
                }
            }
            if let Some(Value::Array(effects)) = obj.get("effects") {
                let warn_effects: Vec<&Value> = effects
                    .iter()
                    .filter(|e| {
                        e.as_object()
                            .and_then(|o| o.get("type"))
                            .and_then(|v| v.as_str())
                            == Some("warn")
                    })
                    .collect();
                if warn_effects.len() != warnings.len() {
                    issues.push(issue(
                        "warnings",
                        "must mirror the warn effects one-for-one",
                    ));
                } else {
                    for (i, e) in warn_effects.iter().enumerate() {
                        let (Some(e), Some(w)) = (e.as_object(), warnings[i].as_object()) else {
                            continue;
                        };
                        if e.get("code") != w.get("code") || e.get("reason") != w.get("reason") {
                            issues.push(issue(
                                format!("warnings[{i}]"),
                                "must match the corresponding warn effect",
                            ));
                        }
                    }
                }
            }
        }
        _ => issues.push(issue("warnings", "must be an array")),
    }

    match obj.get("retry").and_then(|v| v.as_object()) {
        Some(r) => {
            let attempt_index = as_safe_non_neg_int(r.get("attemptIndex").unwrap_or(&Value::Null))
                .filter(|i| *i >= 1);
            let budget =
                as_safe_non_neg_int(r.get("budget").unwrap_or(&Value::Null)).filter(|b| *b >= 1);
            if attempt_index.is_none() {
                issues.push(issue("retry.attemptIndex", "must be a safe integer >= 1"));
            }
            if budget.is_none() {
                issues.push(issue("retry.budget", "must be a safe integer >= 1"));
            }
            let authorized = r.get("retryAuthorized").and_then(|v| v.as_bool());
            if !r.get("retryAuthorized").map(is_bool).unwrap_or(false) {
                issues.push(issue("retry.retryAuthorized", "must be a boolean"));
            }
            if authorized == Some(true)
                && let (Some(idx), Some(bud)) = (attempt_index, budget)
                && idx >= bud
            {
                issues.push(issue(
                    "retry.retryAuthorized",
                    "cannot authorize retry beyond the bounded budget",
                ));
            }
            if authorized == Some(true)
                && obj.get("outcome").and_then(|v| v.as_str()) != Some("retry_compact")
            {
                issues.push(issue(
                    "retry.retryAuthorized",
                    "authorized retry requires outcome retry_compact",
                ));
            }
            if obj.get("outcome").and_then(|v| v.as_str()) == Some("retry_compact")
                && authorized != Some(true)
            {
                issues.push(issue(
                    "retry.retryAuthorized",
                    "retry_compact requires an authorized retry",
                ));
            }
        }
        None => issues.push(issue("retry", "required object")),
    }

    // Never-strand rule: no non-skip outcome may withhold the next provider
    // request except while a host validation acknowledgment is still awaited.
    if let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
        && obj.get("skipped").and_then(|v| v.as_bool()) != Some(true)
        && residual
            .get("nextProviderRequestAllowed")
            .and_then(|v| v.as_bool())
            == Some(false)
        && residual
            .get("hostValidationStatus")
            .and_then(|v| v.as_str())
            != Some("awaiting")
    {
        issues.push(issue(
            "residual.nextProviderRequestAllowed",
            "the compact path never strands: only an awaited host validation may withhold the next provider request",
        ));
    }

    if !obj.get("refused").map(is_bool).unwrap_or(false) {
        issues.push(issue("refused", "must be a boolean"));
    }
    if !obj.get("skipped").map(is_bool).unwrap_or(false) {
        issues.push(issue("skipped", "must be a boolean"));
    }

    let refused = obj.get("refused").and_then(|v| v.as_bool()) == Some(true);
    let skipped = obj.get("skipped").and_then(|v| v.as_bool()) == Some(true);

    if refused {
        if obj.get("outcome").and_then(|v| v.as_str()) != Some("refuse") {
            issues.push(issue(
                "outcome",
                "refused receipts must have outcome refuse",
            ));
        }
        match obj.get("refuseCode").and_then(|v| v.as_str()) {
            Some(c) if COMPACT_CONTINUATION_REFUSE_CODES.contains(&c) => {}
            _ => issues.push(issue("refuseCode", "required refuse code when refused")),
        }
        if skipped {
            issues.push(issue(
                "skipped",
                "refused and skipped are mutually exclusive",
            ));
        }
    } else if !matches!(obj.get("refuseCode"), Some(Value::Null) | None) {
        issues.push(issue("refuseCode", "must be null when not refused"));
    }

    if skipped {
        if obj.get("outcome").and_then(|v| v.as_str()) != Some("skip_seam") {
            issues.push(issue(
                "outcome",
                "skipped receipts must have outcome skip_seam",
            ));
        }
        match obj.get("skipCode").and_then(|v| v.as_str()) {
            Some(c) if COMPACT_CONTINUATION_SKIP_CODES.contains(&c) => {}
            _ => issues.push(issue("skipCode", "required skip code when skipped")),
        }
        if refused {
            issues.push(issue(
                "refused",
                "refused and skipped are mutually exclusive",
            ));
        }
        if let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual
                .get("nextProviderRequestAllowed")
                .and_then(|v| v.as_bool())
                != Some(false)
        {
            issues.push(issue(
                "residual.nextProviderRequestAllowed",
                "skip means wait/re-evaluate; must not authorize next provider request",
            ));
        }
    } else if !matches!(obj.get("skipCode"), Some(Value::Null) | None) {
        issues.push(issue("skipCode", "must be null when not skipped"));
    }

    if let Some(Value::Array(effects)) = obj.get("effects") {
        let types: Vec<Option<&str>> = effects
            .iter()
            .map(|e| {
                e.as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
            })
            .collect();
        let has = |t: &str| types.contains(&Some(t));
        let has_force = has("force_turn_end");
        let has_marker = has("insert_continuation_marker");
        let has_preserve = has("preserve_tool_pairs_verbatim");
        let has_install = has("install_serving_view");
        let has_claim = has("claim_writer");
        let has_release = has("release_writer");
        let has_compact = has("compact");
        let has_degrade = has("degrade_fidelity");

        if has_force
            && obj.get("turnEndReason").and_then(|v| v.as_str())
                != Some(CONTEXT_COMPACT_CONTINUE_REASON)
        {
            issues.push(issue(
                "turnEndReason",
                "force_turn_end requires turnEndReason context_compact_continue",
            ));
        }
        if has_force && has_marker {
            let force_fx = effects.iter().find(|e| {
                e.as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("force_turn_end")
            });
            let mark_fx = effects.iter().find(|e| {
                e.as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("insert_continuation_marker")
            });
            if let (Some(f), Some(m)) = (force_fx, mark_fx) {
                let ft = f
                    .as_object()
                    .and_then(|o| o.get("continuationTurnId"))
                    .and_then(|v| v.as_str());
                let mt = m
                    .as_object()
                    .and_then(|o| o.get("continuationTurnId"))
                    .and_then(|v| v.as_str());
                if ft != mt {
                    issues.push(issue(
                        "effects",
                        "force_turn_end and marker continuationTurnId must match",
                    ));
                }
            }
        }

        if let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual
                .get("forcedContinuationBoundaryApplied")
                .and_then(|v| v.as_bool())
                == Some(true)
        {
            if obj.get("turnEndReason").and_then(|v| v.as_str())
                != Some(CONTEXT_COMPACT_CONTINUE_REASON)
            {
                issues.push(issue(
                    "turnEndReason",
                    "forcedContinuationBoundaryApplied requires turnEndReason context_compact_continue",
                ));
            }
            if let Some(cont) = obj.get("continuation").and_then(|v| v.as_object())
                && cont.get("opened").and_then(|v| v.as_bool()) != Some(true)
            {
                issues.push(issue(
                    "continuation.opened",
                    "forced boundary must open exactly one continuation turn",
                ));
            }
        }

        // Mutual exclusions: ordinary preserve vs marker/force. Contract 2.0.0
        // protected escalation intentionally combines force + marker +
        // preserve_tool_pairs_verbatim (and optional boundary advance).
        let has_advance = has("advance_visibility_boundary");
        let protected_escalation_effects = has_preserve && (has_force || has_marker || has_advance);
        if has_preserve && has_marker && !protected_escalation_effects {
            issues.push(issue(
                "effects",
                "preserve_tool and continuation marker are mutually exclusive",
            ));
        }
        if has_preserve && has_force && !protected_escalation_effects {
            issues.push(issue(
                "effects",
                "preserve_tool path must not force turn_end",
            ));
        }
        if has("open_continuation_turn") {
            issues.push(issue(
                "effects",
                "open_continuation_turn is not a separate effect; force_turn_end opens the turn atomically",
            ));
        }

        let idx = |t: &str| types.iter().position(|x| *x == Some(t));
        if has_claim
            && let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual.get("writerReleased").and_then(|v| v.as_bool()) == Some(true)
            && !has_release
        {
            issues.push(issue(
                "effects",
                "claim_writer with residual.writerReleased requires release_writer",
            ));
        }
        if has_claim && has_release && idx("claim_writer") > idx("release_writer") {
            issues.push(issue("effects", "claim_writer must precede release_writer"));
        }
        if has_force && has_compact && idx("force_turn_end") > idx("compact") {
            issues.push(issue(
                "effects",
                "force_turn_end must precede compact so the closed turn is eligible",
            ));
        }
        if has_compact && has_install && idx("compact") > idx("install_serving_view") {
            issues.push(issue(
                "effects",
                "compact must precede install_serving_view",
            ));
        }
        if has_degrade && has_compact && idx("degrade_fidelity") < idx("compact") {
            issues.push(issue(
                "effects",
                "degrade_fidelity must be classified at/after compact assembly",
            ));
        }
        if has_degrade && has_install && idx("degrade_fidelity") > idx("install_serving_view") {
            issues.push(issue(
                "effects",
                "degrade_fidelity must precede install (classified at assembly)",
            ));
        }
        if has_install
            && let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual
                .get("priorServingViewIntact")
                .and_then(|v| v.as_bool())
                == Some(true)
        {
            issues.push(issue(
                "residual.priorServingViewIntact",
                "successful install_serving_view means prior serving view is not intact",
            ));
        }
        if !has_install
            && let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual
                .get("priorServingViewIntact")
                .and_then(|v| v.as_bool())
                == Some(false)
            && matches!(
                obj.get("outcome").and_then(|v| v.as_str()),
                Some("refuse") | Some("retry_compact") | Some("continue_current_body")
            )
        {
            issues.push(issue(
                "residual.priorServingViewIntact",
                "install failure must not imply a partially installed view",
            ));
        }
        // A failed install never claims a served marker or a successful install,
        // whatever the outcome vocabulary of the receipt that recorded it.
        let install_failed = obj.get("refuseCode").and_then(|v| v.as_str())
            == Some("install_failed")
            || matches!(obj.get("warnings"), Some(Value::Array(ws)) if ws.iter().any(|w| {
                w.as_object()
                    .and_then(|o| o.get("code"))
                    .and_then(|v| v.as_str())
                    == Some("install_attempt_failed")
            }));
        if install_failed {
            if has_install {
                issues.push(issue(
                    "effects",
                    "a failed install must not include successful install_serving_view",
                ));
            }
            if let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
                && residual.get("markerServed").and_then(|v| v.as_bool()) == Some(true)
            {
                issues.push(issue(
                    "residual.markerServed",
                    "a failed install means the marker was not served",
                ));
            }
        }
        if has_marker
            && let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
            && residual.get("markerPersisted").and_then(|v| v.as_bool()) != Some(true)
        {
            issues.push(issue(
                "residual.markerPersisted",
                "insert_continuation_marker requires markerPersisted",
            ));
        }

        if let Some(cont) = obj.get("continuation").and_then(|v| v.as_object()) {
            if cont.get("markerServed").and_then(|v| v.as_bool()) == Some(true) && !has_marker {
                issues.push(issue(
                    "continuation.markerServed",
                    "true requires insert_continuation_marker",
                ));
            }
            if cont.get("markerServed").and_then(|v| v.as_bool()) == Some(true)
                && let Some(residual) = obj.get("residual").and_then(|v| v.as_object())
                && residual.get("markerServed").and_then(|v| v.as_bool()) != Some(true)
            {
                issues.push(issue(
                    "continuation.markerServed",
                    "must match residual.markerServed",
                ));
            }
            if cont.get("opened").and_then(|v| v.as_bool()) == Some(true)
                && cont
                    .get("sameAgenticTurnPreserved")
                    .and_then(|v| v.as_bool())
                    != Some(false)
            {
                issues.push(issue(
                    "continuation.sameAgenticTurnPreserved",
                    "opened continuation must close the prior agentic turn",
                ));
            }
        }

        if obj.get("outcome").and_then(|v| v.as_str()) == Some("compact_continue_turn") {
            if obj.get("turnEndReason").and_then(|v| v.as_str())
                != Some(CONTEXT_COMPACT_CONTINUE_REASON)
            {
                issues.push(issue(
                    "turnEndReason",
                    "compact_continue_turn requires context_compact_continue",
                ));
            }
            if !has_marker {
                issues.push(issue(
                    "effects",
                    "compact_continue_turn requires continuation marker",
                ));
            }
        }
    }

    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

/// Cross-check that a Decision is internally consistent.
pub fn validate_compact_continuation_decision(
    decision: &CompactContinuationDecision,
) -> ValidationResult {
    let mut issues = Vec::new();
    let receipt_value = serde_json::to_value(&decision.receipt).unwrap_or(Value::Null);
    let r = validate_compact_continuation_receipt(&receipt_value);
    issues.extend(r.issues);

    if decision.outcome != decision.receipt.outcome {
        issues.push(issue(
            "outcome",
            "decision.outcome must match receipt.outcome",
        ));
    }
    let effects_a = js_json_stringify_of(&decision.effects).unwrap_or_default();
    let effects_b = js_json_stringify_of(&decision.receipt.effects).unwrap_or_default();
    if effects_a != effects_b {
        issues.push(issue(
            "effects",
            "decision.effects must match receipt.effects",
        ));
    }
    let path_a = js_json_stringify_of(&decision.transition_path).unwrap_or_default();
    let path_b = js_json_stringify_of(&decision.receipt.transition_path).unwrap_or_default();
    if path_a != path_b {
        issues.push(issue(
            "transitionPath",
            "decision.transitionPath must match receipt",
        ));
    }
    if decision.transition_path.last().copied() != Some(decision.terminal_state) {
        issues.push(issue(
            "terminalState",
            "must equal last transitionPath entry",
        ));
    }
    if !COMPACT_CONTINUATION_STATES.contains(&decision.terminal_state.as_str()) {
        issues.push(issue(
            "terminalState",
            format!("unknown state {}", decision.terminal_state.as_str()),
        ));
    }

    let path: Vec<&str> = decision
        .transition_path
        .iter()
        .map(|s| s.as_str())
        .collect();
    if path.contains(&"compacting")
        && !path.contains(&"path_preserve_tool")
        && !path.contains(&"path_continue_turn")
    {
        issues.push(issue(
            "transitionPath",
            "compacting paths must include path_preserve_tool or path_continue_turn",
        ));
    }
    if decision.receipt.pressure.provider_base_tokens.is_none() && path.contains(&"below_trigger") {
        issues.push(issue(
            "transitionPath",
            "missing provider usage must not route through below_trigger",
        ));
    }

    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

/// Re-run comparison against an expected decision object (fixture expected side).
pub fn assert_decision_parity(
    actual: &CompactContinuationDecision,
    expected: &CompactContinuationDecision,
) -> ValidationResult {
    let mut issues = Vec::new();
    let a = js_json_stringify_of(actual).unwrap_or_default();
    let e = js_json_stringify_of(expected).unwrap_or_default();
    if a != e {
        if actual.outcome != expected.outcome {
            issues.push(issue(
                "outcome",
                format!(
                    "actual {} !== expected {}",
                    actual.outcome.as_str(),
                    expected.outcome.as_str()
                ),
            ));
        }
        if actual.terminal_state != expected.terminal_state {
            issues.push(issue(
                "terminalState",
                format!(
                    "actual {} !== expected {}",
                    actual.terminal_state.as_str(),
                    expected.terminal_state.as_str()
                ),
            ));
        }
        let ap = js_json_stringify_of(&actual.transition_path).unwrap_or_default();
        let ep = js_json_stringify_of(&expected.transition_path).unwrap_or_default();
        if ap != ep {
            issues.push(issue(
                "transitionPath",
                format!("actual {ap} !== expected {ep}"),
            ));
        }
        let ae = js_json_stringify_of(&actual.effects).unwrap_or_default();
        let ee = js_json_stringify_of(&expected.effects).unwrap_or_default();
        if ae != ee {
            issues.push(issue("effects", "effects diverge from expected"));
        }
        let ar = js_json_stringify_of(&actual.receipt).unwrap_or_default();
        let er = js_json_stringify_of(&expected.receipt).unwrap_or_default();
        if ar != er {
            issues.push(issue("receipt", "receipt diverges from expected"));
        }
        if issues.is_empty() {
            issues.push(issue("$", "decision JSON differs from expected"));
        }
    }
    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

/// After successful validation, rewrite finite safe integral float spellings
/// (e.g. JSON `1.0`) into integer JSON numbers so serde `i64` fields accept them.
///
/// **Order is load-bearing:** call only after
/// [`validate_compact_continuation_input`] succeeds. This never weakens
/// validation — fractional, negative, non-finite, and over-safe values remain
/// rejected by the validator and never reach this rewrite. The closed
/// compact-continuation input contains only integer numeric fields, so a
/// recursive walk is safe and equivalent to path-by-path conversion (JS has
/// one Number type; TS cannot distinguish `1` from `1.0`).
fn normalize_integral_floats_for_serde(value: &mut Value) {
    match value {
        Value::Number(n) => {
            // Already an integer encoding — leave alone.
            if n.is_i64() || n.is_u64() {
                return;
            }
            if let Some(i) = as_safe_non_neg_int(value) {
                *value = Value::Number(serde_json::Number::from(i));
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_integral_floats_for_serde(item);
            }
        }
        Value::Object(map) => {
            for v in map.values_mut() {
                normalize_integral_floats_for_serde(v);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

/// Safe typed conversion from raw JSON (TS `asCompactContinuationInput`).
///
/// Returns `Err` with validation issues when the input is not a legal
/// closed-shape `CompactContinuationInput`.
///
/// After validation succeeds, integral JSON float spellings accepted by the
/// validator (e.g. `1.0`) are normalized to integer numbers before serde
/// conversion into `i64` fields — see [`normalize_integral_floats_for_serde`].
/// This keeps the public raw-host boundary equivalent to TypeScript (one
/// Number type) without accepting values validation rejected.
pub fn as_compact_continuation_input(raw: &Value) -> Result<CompactContinuationInput, String> {
    let v = validate_compact_continuation_input(raw);
    if !v.ok {
        let msg = v
            .issues
            .iter()
            .map(|i| format!("{}: {}", i.path, i.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("invalid fixture input: {msg}"));
    }
    let mut normalized = raw.clone();
    normalize_integral_floats_for_serde(&mut normalized);
    serde_json::from_value(normalized)
        .map_err(|e| format!("invalid fixture input: deserialize failed: {e}"))
}
