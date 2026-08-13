/**
 * Closed validation of compact-continuation host facts before I/O.
 * Mirrors project closed-shape posture (unknown fields rejected).
 */

import type { ErrorResult } from "../../shared-tech/errors.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

const POLICY_KEYS = ["upperTriggerTokens", "lowerTargetTokens", "hostCapability"] as const;
const ESTIMATE_KEYS = ["tokens", "source", "domain"] as const;
const COMPACT_KEYS = ["profile", "params"] as const;
const PARAMS_KEYS = ["lowerBound", "percentages"] as const;
const PCT_KEYS = ["full", "smooth", "detailed", "brief"] as const;
const HOOK_KEYS = [
  "forceCompactStructurallyValid",
  "forceInstallSucceeds",
  "forceUsefulReduction",
  "forceCanProduceValidProviderRequest",
  "forceDerivationsMissingOrFailed",
  "skipRealCompact",
  "failInstallBeforeWrite",
  "interruptAfterBoundary",
  "interruptAfterMarker",
  "interruptAfterTurnEndCommit",
  "failFinalizeWrite",
  "failReceiptWrite",
  "failFinalizeAfterReceipt",
  "failFinalizeAtRelease",
] as const;

/**
 * Validate host facts shape. Returns undefined when valid.
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
    "testHooks",
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
  if (!isNonNegFinite(policy.obj["upperTriggerTokens"]) || !isNonNegFinite(policy.obj["lowerTargetTokens"])) {
    return reject("policy token targets must be non-negative finite numbers");
  }
  if (policy.obj["hostCapability"] !== "full_state_machine" && policy.obj["hostCapability"] !== "capability_limited") {
    return reject("policy.hostCapability must be full_state_machine|capability_limited");
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
      if (!isNonNegFinite(usage.obj[key])) {
        return reject(`providerUsage.${key} must be a non-negative finite number when available`);
      }
    }
    if (usage.obj["domain"] !== "provider_reported_input") {
      return reject("providerUsage.domain must be provider_reported_input");
    }
  } else {
    if (usage.obj["reason"] !== "missing" && usage.obj["reason"] !== "invalid") {
      return reject("providerUsage.reason must be missing|invalid when unavailable");
    }
    if (usage.obj["domain"] !== "provider_reported_input") {
      return reject("providerUsage.domain must be provider_reported_input");
    }
  }

  const est = closedObject(facts["postMeasurementEstimate"], "postMeasurementEstimate", ESTIMATE_KEYS);
  if (!est.ok) return est.error;
  if (!isNonNegFinite(est.obj["tokens"]) || !isNonEmptyString(est.obj["source"])) {
    return reject("postMeasurementEstimate.tokens must be non-negative finite and source non-empty");
  }
  if (est.obj["domain"] !== "source_labelled_estimate") {
    return reject("postMeasurementEstimate.domain must be source_labelled_estimate");
  }

  const cont = closedObject(facts["continuation"], "continuation", ["kind", "toolCallId", "correlationValid"]);
  if (!cont.ok) return cont.error;
  if (cont.obj["kind"] === "none" || cont.obj["kind"] === "active_non_tool") {
    if (Object.keys(cont.obj).length !== 1) {
      return reject(`continuation kind ${String(cont.obj["kind"])} must not carry extra fields`);
    }
  } else if (cont.obj["kind"] === "pending_correlated_tool_result") {
    if (!isNonEmptyString(cont.obj["toolCallId"]) || typeof cont.obj["correlationValid"] !== "boolean") {
      return reject("pending_correlated_tool_result requires toolCallId and correlationValid");
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
      if (params.obj["lowerBound"] !== undefined && !isNonNegFinite(params.obj["lowerBound"])) {
        return reject("compact.params.lowerBound must be non-negative finite");
      }
      if (params.obj["percentages"] !== undefined) {
        const pct = closedObject(params.obj["percentages"], "compact.params.percentages", PCT_KEYS);
        if (!pct.ok) return pct.error;
        for (const key of PCT_KEYS) {
          if (pct.obj[key] !== undefined && !isNonNegFinite(pct.obj[key])) {
            return reject(`compact.params.percentages.${key} must be non-negative finite`);
          }
        }
      }
    }
  }

  if (facts["testHooks"] !== undefined) {
    const hooks = closedObject(facts["testHooks"], "testHooks", HOOK_KEYS);
    if (!hooks.ok) return hooks.error;
    for (const [key, value] of Object.entries(hooks.obj)) {
      if (typeof value !== "boolean") return reject(`testHooks.${key} must be a boolean`);
    }
  }

  return undefined;
}
