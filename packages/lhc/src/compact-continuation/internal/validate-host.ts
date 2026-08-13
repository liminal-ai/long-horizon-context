/**
 * Closed validation of compact-continuation host facts before I/O.
 */

import type { ErrorResult } from "../../shared-tech/errors.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate host facts shape. Returns undefined when valid.
 * Uses invalid_compact_continuation_input for all malformation.
 */
export function validateHostFacts(raw: unknown): ErrorResult | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "host facts must be a non-null object",
    };
  }
  const facts = raw as Record<string, unknown>;

  if (!isNonEmptyString(facts["attemptId"])) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "attemptId must be a non-empty string",
    };
  }
  if (!isNonEmptyString(facts["actor"]) || !isNonEmptyString(facts["harness"])) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "actor and harness must be non-empty strings",
    };
  }
  if (typeof facts["captureComplete"] !== "boolean" || typeof facts["providerIdentityValid"] !== "boolean") {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "captureComplete and providerIdentityValid must be booleans",
    };
  }

  const writerClaim = facts["writerClaim"];
  if (writerClaim !== "none" && writerClaim !== "lhc" && writerClaim !== "native" && writerClaim !== "conflict") {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: `writerClaim must be none|lhc|native|conflict, got ${String(writerClaim)}`,
    };
  }

  const seam = facts["seam"];
  if (seam === null || typeof seam !== "object" || Array.isArray(seam)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "seam must be an object",
    };
  }
  const s = seam as Record<string, unknown>;
  for (const key of [
    "modelResponseComplete",
    "requestedToolsSettled",
    "captureFlushed",
    "beforeNextProviderRequest",
    "insideTransportRetry",
  ] as const) {
    if (typeof s[key] !== "boolean") {
      return {
        errorClass: "caller_error",
        code: "invalid_compact_continuation_input",
        reason: `seam.${key} must be a boolean`,
      };
    }
  }
  if (!isFiniteNumber(s["inputEpochAtDecision"]) || !isFiniteNumber(s["inputEpochAtApply"])) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "seam input epochs must be finite numbers",
    };
  }

  const policy = facts["policy"];
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "policy must be an object",
    };
  }
  const p = policy as Record<string, unknown>;
  if (!isFiniteNumber(p["upperTriggerTokens"]) || !isFiniteNumber(p["lowerTargetTokens"])) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "policy upper/lower token targets must be finite numbers",
    };
  }
  if (p["hostCapability"] !== "full_state_machine" && p["hostCapability"] !== "capability_limited") {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "policy.hostCapability must be full_state_machine|capability_limited",
    };
  }

  const usage = facts["providerUsage"];
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "providerUsage must be an object",
    };
  }
  const u = usage as Record<string, unknown>;
  if (typeof u["available"] !== "boolean") {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "providerUsage.available must be a boolean",
    };
  }
  if (u["available"] === true) {
    for (const key of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "total"] as const) {
      if (!isFiniteNumber(u[key])) {
        return {
          errorClass: "caller_error",
          code: "invalid_compact_continuation_input",
          reason: `providerUsage.${key} must be a finite number when available`,
        };
      }
    }
  }

  const est = facts["postMeasurementEstimate"];
  if (est === null || typeof est !== "object" || Array.isArray(est)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "postMeasurementEstimate must be an object",
    };
  }
  const e = est as Record<string, unknown>;
  if (!isFiniteNumber(e["tokens"]) || !isNonEmptyString(e["source"])) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "postMeasurementEstimate.tokens must be finite and source non-empty",
    };
  }

  const cont = facts["continuation"];
  if (cont === null || typeof cont !== "object" || Array.isArray(cont)) {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: "continuation must be an object",
    };
  }
  const c = cont as Record<string, unknown>;
  if (c["kind"] === "none" || c["kind"] === "active_non_tool") {
    // ok
  } else if (c["kind"] === "pending_correlated_tool_result") {
    if (!isNonEmptyString(c["toolCallId"]) || typeof c["correlationValid"] !== "boolean") {
      return {
        errorClass: "caller_error",
        code: "invalid_compact_continuation_input",
        reason: "pending_correlated_tool_result requires toolCallId and correlationValid",
      };
    }
  } else {
    return {
      errorClass: "caller_error",
      code: "invalid_compact_continuation_input",
      reason: `unknown continuation.kind ${String(c["kind"])}`,
    };
  }

  // Closed-ish: reject unknown top-level keys that are clearly not ours.
  const allowed = new Set([
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
  for (const key of Object.keys(facts)) {
    if (!allowed.has(key)) {
      return {
        errorClass: "caller_error",
        code: "invalid_compact_continuation_input",
        reason: `unknown host fact field "${key}"`,
      };
    }
  }

  return undefined;
}
