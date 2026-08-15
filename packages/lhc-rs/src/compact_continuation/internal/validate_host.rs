//! Closed validation of compact-continuation host facts before I/O.

use serde_json::{Map, Value};

use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult};
use crate::shared_tech::view::ViewProfile;
use crate::thread_view::internal::profiles::profile_violation;

fn is_non_empty_string(value: &Value) -> bool {
    matches!(value, Value::String(s) if !s.is_empty())
}

fn is_non_neg_int(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i >= 0
            } else if let Some(f) = n.as_f64() {
                f.fract() == 0.0 && f >= 0.0 && f.is_finite()
            } else {
                false
            }
        }
        _ => false,
    }
}

fn is_positive_int(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i > 0
            } else if let Some(f) = n.as_f64() {
                f.fract() == 0.0 && f > 0.0 && f.is_finite()
            } else {
                false
            }
        }
        _ => false,
    }
}

fn reject(reason: &str) -> ErrorResult {
    ErrorResult {
        error_class: ErrorClass::CallerError,
        code: ErrorCode::InvalidCompactContinuationInput,
        reason: reason.to_string(),
        event_index: None,
    }
}

fn closed_object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, ErrorResult> {
    let Some(obj) = value.as_object() else {
        return Err(reject(&format!("{path} must be a non-null object")));
    };
    let allow: std::collections::HashSet<&str> = allowed.iter().copied().collect();
    for key in obj.keys() {
        if !allow.contains(key.as_str()) {
            return Err(reject(&format!("unknown field {path}.{key}")));
        }
    }
    Ok(obj)
}

const SEAM_KEYS: &[&str] = &[
    "modelResponseComplete",
    "requestedToolsSettled",
    "captureFlushed",
    "beforeNextProviderRequest",
    "insideTransportRetry",
    "inputEpochAtDecision",
    "inputEpochAtApply",
];
const POLICY_KEYS: &[&str] = &[
    "upperTriggerTokens",
    "lowerTargetTokens",
    "hostCapability",
    "safeRunwayThresholdTokens",
    "safeRunwayThresholdSource",
];
const ESTIMATE_KEYS: &[&str] = &["tokens", "source", "domain"];
const COMPACT_KEYS: &[&str] = &["profile", "params"];
const PARAMS_KEYS: &[&str] = &["lowerBound", "percentages"];
const PCT_KEYS: &[&str] = &["full", "smooth", "detailed", "brief"];

/// Validate host facts shape. Returns `None` when valid.
/// Public surface: `testHooks` is rejected (unknown field).
pub fn validate_host_facts(raw: &Value) -> Option<ErrorResult> {
    let top = match closed_object(
        raw,
        "hostFacts",
        &[
            "attemptId",
            "seam",
            "providerUsage",
            "postMeasurementEstimate",
            "policy",
            "continuation",
            "writerClaim",
            "captureComplete",
            "providerIdentityValid",
            "singleOpenTurn",
            "actor",
            "harness",
            "compact",
        ],
    ) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };

    if !top.get("attemptId").is_some_and(is_non_empty_string) {
        return Some(reject("attemptId must be a non-empty string"));
    }
    if !top.get("actor").is_some_and(is_non_empty_string)
        || !top.get("harness").is_some_and(is_non_empty_string)
    {
        return Some(reject("actor and harness must be non-empty strings"));
    }
    if !matches!(top.get("captureComplete"), Some(Value::Bool(_)))
        || !matches!(top.get("providerIdentityValid"), Some(Value::Bool(_)))
    {
        return Some(reject(
            "captureComplete and providerIdentityValid must be booleans",
        ));
    }
    if let Some(s) = top.get("singleOpenTurn") {
        if !matches!(s, Value::Bool(_)) {
            return Some(reject("singleOpenTurn must be a boolean when present"));
        }
    }

    let writer_claim = top.get("writerClaim").and_then(|v| v.as_str());
    if !matches!(
        writer_claim,
        Some("none") | Some("lhc") | Some("native") | Some("conflict")
    ) {
        return Some(reject(&format!(
            "writerClaim must be none|lhc|native|conflict, got {}",
            writer_claim.unwrap_or("null")
        )));
    }

    let seam_val = top.get("seam").cloned().unwrap_or(Value::Null);
    let seam = match closed_object(&seam_val, "seam", SEAM_KEYS) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };
    for key in [
        "modelResponseComplete",
        "requestedToolsSettled",
        "captureFlushed",
        "beforeNextProviderRequest",
        "insideTransportRetry",
    ] {
        if !matches!(seam.get(key), Some(Value::Bool(_))) {
            return Some(reject(&format!("seam.{key} must be a boolean")));
        }
    }
    if !seam.get("inputEpochAtDecision").is_some_and(is_non_neg_int)
        || !seam.get("inputEpochAtApply").is_some_and(is_non_neg_int)
    {
        return Some(reject("seam input epochs must be non-negative integers"));
    }

    let policy_val = top.get("policy").cloned().unwrap_or(Value::Null);
    let policy = match closed_object(&policy_val, "policy", POLICY_KEYS) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };
    if !policy.get("upperTriggerTokens").is_some_and(is_non_neg_int)
        || !policy.get("lowerTargetTokens").is_some_and(is_non_neg_int)
    {
        return Some(reject("policy token targets must be non-negative integers"));
    }
    if !matches!(
        policy.get("hostCapability").and_then(|v| v.as_str()),
        Some("full_state_machine") | Some("capability_limited")
    ) {
        return Some(reject(
            "policy.hostCapability must be full_state_machine|capability_limited",
        ));
    }
    if let Some(threshold) = policy.get("safeRunwayThresholdTokens")
        && !is_non_neg_int(threshold)
    {
        return Some(reject(
            "policy.safeRunwayThresholdTokens must be a non-negative integer when present",
        ));
    }
    if let Some(source) = policy.get("safeRunwayThresholdSource")
        && !is_non_empty_string(source)
    {
        return Some(reject(
            "policy.safeRunwayThresholdSource must be a non-empty string when present",
        ));
    }

    let usage_val = top.get("providerUsage").cloned().unwrap_or(Value::Null);
    let usage = match closed_object(
        &usage_val,
        "providerUsage",
        &[
            "available",
            "inputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "total",
            "domain",
            "reason",
        ],
    ) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };
    if !matches!(usage.get("available"), Some(Value::Bool(_))) {
        return Some(reject("providerUsage.available must be a boolean"));
    }
    if usage.get("available") == Some(&Value::Bool(true)) {
        for key in [
            "inputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "total",
        ] {
            if !usage.get(key).is_some_and(is_non_neg_int) {
                return Some(reject(&format!(
                    "providerUsage.{key} must be a non-negative integer when available"
                )));
            }
        }
        if usage.get("domain").and_then(|v| v.as_str()) != Some("provider_reported_input") {
            return Some(reject(
                "providerUsage.domain must be provider_reported_input",
            ));
        }
        if usage.get("reason").is_some() {
            return Some(reject(
                "providerUsage.reason must not be present when available",
            ));
        }
    } else {
        if !matches!(
            usage.get("reason").and_then(|v| v.as_str()),
            Some("missing") | Some("invalid")
        ) {
            return Some(reject(
                "providerUsage.reason must be missing|invalid when unavailable",
            ));
        }
        if usage.get("domain").and_then(|v| v.as_str()) != Some("provider_reported_input") {
            return Some(reject(
                "providerUsage.domain must be provider_reported_input",
            ));
        }
        for key in [
            "inputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "total",
        ] {
            if usage.get(key).is_some() {
                return Some(reject(&format!(
                    "providerUsage.{key} must not be present when unavailable"
                )));
            }
        }
    }

    let est_val = top
        .get("postMeasurementEstimate")
        .cloned()
        .unwrap_or(Value::Null);
    let est = match closed_object(&est_val, "postMeasurementEstimate", ESTIMATE_KEYS) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };
    if !est.get("tokens").is_some_and(is_non_neg_int)
        || !est.get("source").is_some_and(is_non_empty_string)
    {
        return Some(reject(
            "postMeasurementEstimate.tokens must be a non-negative integer and source non-empty",
        ));
    }
    if est.get("domain").and_then(|v| v.as_str()) != Some("source_labelled_estimate") {
        return Some(reject(
            "postMeasurementEstimate.domain must be source_labelled_estimate",
        ));
    }

    let cont_val = top.get("continuation").cloned().unwrap_or(Value::Null);
    let cont = match closed_object(
        &cont_val,
        "continuation",
        // toolCallId listed only so the closed-object gate does not mask the
        // specific dual-field-shim rejection below.
        &[
            "kind",
            "protectedToolCallIds",
            "correlationValid",
            "toolCallId",
        ],
    ) {
        Ok(o) => o,
        Err(e) => return Some(e),
    };
    match cont.get("kind").and_then(|v| v.as_str()) {
        Some("none") | Some("active_non_tool") => {
            if cont.len() != 1 {
                return Some(reject(&format!(
                    "continuation kind {} must not carry extra fields",
                    cont.get("kind").and_then(|v| v.as_str()).unwrap_or("?")
                )));
            }
        }
        Some("pending_correlated_tool_result") => {
            if cont.contains_key("toolCallId") {
                return Some(reject(
                    "continuation.toolCallId removed in contract 2.0.0; use protectedToolCallIds",
                ));
            }
            let Some(Value::Array(ids)) = cont.get("protectedToolCallIds") else {
                return Some(reject(
                    "pending_correlated_tool_result requires non-empty protectedToolCallIds",
                ));
            };
            if ids.is_empty() {
                return Some(reject(
                    "pending_correlated_tool_result requires non-empty protectedToolCallIds",
                ));
            }
            let mut prev: Option<&str> = None;
            let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
            for id in ids {
                let Some(id) = id.as_str().filter(|s| !s.is_empty()) else {
                    return Some(reject(
                        "protectedToolCallIds entries must be non-empty strings",
                    ));
                };
                if !seen.insert(id) {
                    return Some(reject("protectedToolCallIds must be unique"));
                }
                if let Some(prev) = prev
                    && crate::shared_tech::compact_continuation::js_string_cmp(id, prev)
                        == std::cmp::Ordering::Less
                {
                    return Some(reject("protectedToolCallIds must be sorted ascending"));
                }
                prev = Some(id);
            }
            if !matches!(cont.get("correlationValid"), Some(Value::Bool(_))) {
                return Some(reject(
                    "pending_correlated_tool_result requires correlationValid boolean",
                ));
            }
        }
        other => {
            return Some(reject(&format!(
                "unknown continuation.kind {}",
                other.unwrap_or("null")
            )));
        }
    }

    if let Some(compact_val) = top.get("compact") {
        let compact = match closed_object(compact_val, "compact", COMPACT_KEYS) {
            Ok(o) => o,
            Err(e) => return Some(e),
        };
        if let Some(profile) = compact.get("profile") {
            if !is_non_empty_string(profile) {
                return Some(reject(
                    "compact.profile must be a non-empty string when present",
                ));
            }
        }
        if let Some(params_val) = compact.get("params") {
            let params = match closed_object(params_val, "compact.params", PARAMS_KEYS) {
                Ok(o) => o,
                Err(e) => return Some(e),
            };
            if let Some(lb) = params.get("lowerBound") {
                if !is_positive_int(lb) {
                    return Some(reject(
                        "compact.params.lowerBound must be a positive integer when present",
                    ));
                }
            }
            if let Some(pct_val) = params.get("percentages") {
                let pct = match closed_object(pct_val, "compact.params.percentages", PCT_KEYS) {
                    Ok(o) => o,
                    Err(e) => return Some(e),
                };
                for key in PCT_KEYS {
                    if let Some(v) = pct.get(*key) {
                        if !is_non_neg_int(v) {
                            return Some(reject(&format!(
                                "compact.params.percentages.{key} must be a non-negative integer when present"
                            )));
                        }
                    }
                }
                if PCT_KEYS.iter().all(|k| pct.get(*k).is_some()) {
                    let lower = params
                        .get("lowerBound")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(1.0);
                    let complete = ViewProfile {
                        name: "host-compact-params".into(),
                        lower_bound: lower,
                        percentages: crate::shared_tech::view::ViewProfilePercentages {
                            full: pct.get("full").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            smooth: pct.get("smooth").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            detailed: pct.get("detailed").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            brief: pct.get("brief").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        },
                    };
                    if let Some(violation) = profile_violation(&complete) {
                        return Some(reject(&format!("compact.params: {violation}")));
                    }
                }
            }
        }
    }

    None
}
