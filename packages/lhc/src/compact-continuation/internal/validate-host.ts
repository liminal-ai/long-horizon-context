/**
 * Closed validation of compact-continuation host facts before I/O.
 * Mirrors project closed-shape posture (unknown fields rejected).
 *
 * Token counts and epochs are non-negative integers. Provider `total` is the
 * authoritative provider-reported total (not re-derived as a component sum).
 * Public validation rejects `testHooks` — hooks are internal/test-only.
 */

import type { ErrorResult } from "../../shared-tech/errors.js";
import { profileViolation } from "../../thread-view/internal/profiles.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function reject(reason: string): ErrorResult {
  return {
    errorClass: "caller_error",
    code: "invalid_compact_continuation_input",
    reason,
  };
}

function closedObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
): { ok: true; obj: Record<string, unknown> } | { ok: false; error: ErrorResult } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: reject(`${path} must be a non-null object`) };
  }
  const obj = value as Record<string, unknown>;
  const allow = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allow.has(key)) {
      return { ok: false, error: reject(`unknown field ${path}.${key}`) };
    }
  }
  return { ok: true, obj };
}

const SEAM_KEYS = [
  "modelResponseComplete",
  "requestedToolsSettled",
  "captureFlushed",
  "beforeNextProviderRequest",
  "insideTransportRetry",
  "inputEpochAtDecision",
  "inputEpochAtApply",
] as const;

const POLICY_KEYS = [
  "upperTriggerTokens",
  "lowerTargetTokens",
  "hostCapability",
  "safeRunwayThresholdTokens",
  "safeRunwayThresholdSource",
] as const;
const ESTIMATE_KEYS = ["tokens", "source", "domain"] as const;
const COMPACT_KEYS = ["profile", "params"] as const;
const PARAMS_KEYS = ["lowerBound", "percentages"] as const;
const PCT_KEYS = ["full", "smooth", "detailed", "brief"] as const;

/**
 * Validate host facts shape. Returns undefined when valid.
 * Public surface: `testHooks` is rejected (unknown field).
 */
export function validateHostFacts(raw: unknown): ErrorResult | undefined {
  const top = closedObject(raw, "hostFacts", [
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
  ]);
  if (!top.ok) return top.error;
  const facts = top.obj;

  if (!isNonEmptyString(facts["attemptId"])) return reject("attemptId must be a non-empty string");
  if (!isNonEmptyString(facts["actor"]) || !isNonEmptyString(facts["harness"])) {
    return reject("actor and harness must be non-empty strings");
  }
  if (typeof facts["captureComplete"] !== "boolean" || typeof facts["providerIdentityValid"] !== "boolean") {
    return reject("captureComplete and providerIdentityValid must be booleans");
  }
  if (facts["singleOpenTurn"] !== undefined && typeof facts["singleOpenTurn"] !== "boolean") {
    return reject("singleOpenTurn must be a boolean when present");
  }

  const writerClaim = facts["writerClaim"];
  if (writerClaim !== "none" && writerClaim !== "lhc" && writerClaim !== "native" && writerClaim !== "conflict") {
    return reject(`writerClaim must be none|lhc|native|conflict, got ${String(writerClaim)}`);
  }

  const seam = closedObject(facts["seam"], "seam", SEAM_KEYS);
  if (!seam.ok) return seam.error;
  for (const key of [
    "modelResponseComplete",
    "requestedToolsSettled",
    "captureFlushed",
    "beforeNextProviderRequest",
    "insideTransportRetry",
  ] as const) {
    if (typeof seam.obj[key] !== "boolean") return reject(`seam.${key} must be a boolean`);
  }
  if (!isNonNegInt(seam.obj["inputEpochAtDecision"]) || !isNonNegInt(seam.obj["inputEpochAtApply"])) {
    return reject("seam input epochs must be non-negative integers");
  }

  const policy = closedObject(facts["policy"], "policy", POLICY_KEYS);
  if (!policy.ok) return policy.error;
  if (!isNonNegInt(policy.obj["upperTriggerTokens"]) || !isNonNegInt(policy.obj["lowerTargetTokens"])) {
    return reject("policy token targets must be non-negative integers");
  }
  if (policy.obj["hostCapability"] !== "full_state_machine" && policy.obj["hostCapability"] !== "capability_limited") {
    return reject("policy.hostCapability must be full_state_machine|capability_limited");
  }
  if (policy.obj["safeRunwayThresholdTokens"] !== undefined && !isNonNegInt(policy.obj["safeRunwayThresholdTokens"])) {
    return reject("policy.safeRunwayThresholdTokens must be a non-negative integer when present");
  }
  if (
    policy.obj["safeRunwayThresholdSource"] !== undefined &&
    (typeof policy.obj["safeRunwayThresholdSource"] !== "string" ||
      policy.obj["safeRunwayThresholdSource"].length === 0)
  ) {
    return reject("policy.safeRunwayThresholdSource must be a non-empty string when present");
  }

  const usage = closedObject(facts["providerUsage"], "providerUsage", [
    "available",
    "inputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "total",
    "domain",
    "reason",
  ]);
  if (!usage.ok) return usage.error;
  if (typeof usage.obj["available"] !== "boolean") return reject("providerUsage.available must be a boolean");
  if (usage.obj["available"] === true) {
    for (const key of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "total"] as const) {
      if (!isNonNegInt(usage.obj[key])) {
        return reject(`providerUsage.${key} must be a non-negative integer when available`);
      }
    }
    // `total` is the authoritative provider-reported total. Hosts may surface a
    // provider total that is not a sum of the component fields (billing/cache
    // accounting differs by provider). Do not invent a sum rule here.
    if (usage.obj["domain"] !== "provider_reported_input") {
      return reject("providerUsage.domain must be provider_reported_input");
    }
    // Reject unknown optional components when available (reason not allowed).
    if (usage.obj["reason"] !== undefined) {
      return reject("providerUsage.reason must not be present when available");
    }
  } else {
    if (usage.obj["reason"] !== "missing" && usage.obj["reason"] !== "invalid") {
      return reject("providerUsage.reason must be missing|invalid when unavailable");
    }
    if (usage.obj["domain"] !== "provider_reported_input") {
      return reject("providerUsage.domain must be provider_reported_input");
    }
    for (const key of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "total"] as const) {
      if (usage.obj[key] !== undefined) {
        return reject(`providerUsage.${key} must not be present when unavailable`);
      }
    }
  }

  const est = closedObject(facts["postMeasurementEstimate"], "postMeasurementEstimate", ESTIMATE_KEYS);
  if (!est.ok) return est.error;
  if (!isNonNegInt(est.obj["tokens"]) || !isNonEmptyString(est.obj["source"])) {
    return reject("postMeasurementEstimate.tokens must be a non-negative integer and source non-empty");
  }
  if (est.obj["domain"] !== "source_labelled_estimate") {
    return reject("postMeasurementEstimate.domain must be source_labelled_estimate");
  }

  const cont = closedObject(facts["continuation"], "continuation", [
    "kind",
    "protectedToolCallIds",
    "correlationValid",
    "toolCallId", // rejected below — dual-field shim forbidden
  ]);
  if (!cont.ok) return cont.error;
  if (cont.obj["kind"] === "none" || cont.obj["kind"] === "active_non_tool") {
    if (Object.keys(cont.obj).length !== 1) {
      return reject(`continuation kind ${String(cont.obj["kind"])} must not carry extra fields`);
    }
  } else if (cont.obj["kind"] === "pending_correlated_tool_result") {
    if (cont.obj["toolCallId"] !== undefined) {
      return reject("continuation.toolCallId removed in contract 2.0.0; use protectedToolCallIds");
    }
    const ids = cont.obj["protectedToolCallIds"];
    if (!Array.isArray(ids) || ids.length === 0) {
      return reject("pending_correlated_tool_result requires non-empty protectedToolCallIds");
    }
    let prev: string | null = null;
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) {
        return reject("protectedToolCallIds entries must be non-empty strings");
      }
      if (seen.has(id)) return reject("protectedToolCallIds must be unique");
      seen.add(id);
      if (prev !== null && id < prev) return reject("protectedToolCallIds must be sorted ascending");
      prev = id;
    }
    if (typeof cont.obj["correlationValid"] !== "boolean") {
      return reject("pending_correlated_tool_result requires correlationValid boolean");
    }
  } else {
    return reject(`unknown continuation.kind ${String(cont.obj["kind"])}`);
  }

  if (facts["compact"] !== undefined) {
    const compact = closedObject(facts["compact"], "compact", COMPACT_KEYS);
    if (!compact.ok) return compact.error;
    if (compact.obj["profile"] !== undefined && !isNonEmptyString(compact.obj["profile"])) {
      return reject("compact.profile must be a non-empty string when present");
    }
    if (compact.obj["params"] !== undefined) {
      const params = closedObject(compact.obj["params"], "compact.params", PARAMS_KEYS);
      if (!params.ok) return params.error;
      if (params.obj["lowerBound"] !== undefined && !isPositiveInt(params.obj["lowerBound"])) {
        return reject("compact.params.lowerBound must be a positive integer when present");
      }
      if (params.obj["percentages"] !== undefined) {
        const pct = closedObject(params.obj["percentages"], "compact.params.percentages", PCT_KEYS);
        if (!pct.ok) return pct.error;
        for (const key of PCT_KEYS) {
          if (pct.obj[key] !== undefined && !isNonNegInt(pct.obj[key])) {
            return reject(`compact.params.percentages.${key} must be a non-negative integer when present`);
          }
        }
        // When all four percentages are supplied, enforce profile sum/range rules.
        if (PCT_KEYS.every((k) => pct.obj[k] !== undefined)) {
          const complete = {
            name: "host-compact-params",
            lowerBound: (params.obj["lowerBound"] as number | undefined) ?? 1,
            percentages: {
              full: pct.obj["full"] as number,
              smooth: pct.obj["smooth"] as number,
              detailed: pct.obj["detailed"] as number,
              brief: pct.obj["brief"] as number,
            },
          };
          const violation = profileViolation(complete);
          if (violation !== null) {
            return reject(`compact.params: ${violation}`);
          }
        }
      }
    }
  }

  return undefined;
}
