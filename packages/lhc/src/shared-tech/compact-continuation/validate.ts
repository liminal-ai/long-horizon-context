/**
 * Structural validation for compact-continuation parity fixtures and receipts.
 * Pure: no I/O. Suitable for TypeScript tests now and Rust ports later.
 */

import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_HOST_CAPABILITIES,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_SKIP_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_WRITER_CLAIMS,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationEffect,
  type CompactContinuationInput,
  type CompactContinuationOutcomeKind,
  type CompactContinuationState,
} from "./contract.js";

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

const OUTCOME_SET = new Set<string>(COMPACT_CONTINUATION_OUTCOME_KINDS);
const STATE_SET = new Set<string>(COMPACT_CONTINUATION_STATES);
const REFUSE_SET = new Set<string>(COMPACT_CONTINUATION_REFUSE_CODES);
const SKIP_SET = new Set<string>(COMPACT_CONTINUATION_SKIP_CODES);
const WRITER_SET = new Set<string>(COMPACT_CONTINUATION_WRITER_CLAIMS);
const CAP_SET = new Set<string>(COMPACT_CONTINUATION_HOST_CAPABILITIES);
const CONTINUATION_KINDS = new Set(["none", "pending_correlated_tool_result", "active_non_tool"]);

const EFFECT_TYPES = new Set([
  "claim_writer",
  "release_writer",
  "force_turn_end",
  "compact",
  "preserve_tool_pair_verbatim",
  "insert_continuation_marker",
  "install_serving_view",
  "record_receipt",
  "degrade_fidelity",
  "skip_seam",
  "refuse",
]);

function requireBool(obj: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  if (!isBool(obj[key])) {
    issues.push(issue(`${path}.${key}`, "must be a boolean"));
  }
}

function validateSeam(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("seam", "required object"));
    return;
  }
  for (const k of [
    "modelResponseComplete",
    "requestedToolsSettled",
    "captureFlushed",
    "beforeNextProviderRequest",
    "insideTransportRetry",
  ] as const) {
    requireBool(raw, k, "seam", issues);
  }
  if (!isSafeNonNegInt(raw["inputEpochAtDecision"])) {
    issues.push(issue("seam.inputEpochAtDecision", "must be a non-negative safe integer"));
  }
  if (!isSafeNonNegInt(raw["inputEpochAtApply"])) {
    issues.push(issue("seam.inputEpochAtApply", "must be a non-negative safe integer"));
  }
}

function validateProviderUsage(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("providerUsage", "required object"));
    return;
  }
  if (!isBool(raw["available"])) {
    issues.push(issue("providerUsage.available", "must be a boolean"));
    return;
  }
  if (raw["domain"] !== "provider_reported_input") {
    issues.push(issue("providerUsage.domain", 'must be "provider_reported_input"'));
  }
  if (raw["available"] === true) {
    for (const k of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "total"] as const) {
      if (!isSafeNonNegInt(raw[k])) {
        issues.push(issue(`providerUsage.${k}`, "must be a non-negative safe integer"));
      }
    }
    if (
      isSafeNonNegInt(raw["inputTokens"]) &&
      isSafeNonNegInt(raw["cacheCreationTokens"]) &&
      isSafeNonNegInt(raw["cacheReadTokens"]) &&
      isSafeNonNegInt(raw["total"])
    ) {
      const sum = raw["inputTokens"] + raw["cacheCreationTokens"] + raw["cacheReadTokens"];
      if (!Number.isSafeInteger(sum)) {
        issues.push(issue("providerUsage.total", "component sum is not a safe integer"));
      } else if (sum !== raw["total"]) {
        issues.push(
          issue("providerUsage.total", `must equal input+cacheCreation+cacheRead (${sum}), got ${raw["total"]}`),
        );
      }
    }
  } else {
    if (raw["reason"] !== "missing" && raw["reason"] !== "invalid") {
      issues.push(issue("providerUsage.reason", 'must be "missing" or "invalid" when unavailable'));
    }
  }
}

function validateEstimate(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("postMeasurementEstimate", "required object"));
    return;
  }
  if (!isSafeNonNegInt(raw["tokens"])) {
    issues.push(issue("postMeasurementEstimate.tokens", "must be a non-negative safe integer"));
  }
  if (typeof raw["source"] !== "string" || raw["source"].length === 0) {
    issues.push(issue("postMeasurementEstimate.source", "must be a non-empty string label"));
  }
  if (raw["domain"] !== "source_labelled_estimate") {
    issues.push(issue("postMeasurementEstimate.domain", 'must be "source_labelled_estimate"'));
  }
}

function validatePolicy(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("policy", "required object"));
    return;
  }
  if (!isSafeNonNegInt(raw["upperTriggerTokens"])) {
    issues.push(issue("policy.upperTriggerTokens", "must be a non-negative safe integer"));
  }
  if (!isSafeNonNegInt(raw["lowerTargetTokens"])) {
    issues.push(issue("policy.lowerTargetTokens", "must be a non-negative safe integer"));
  }
  if (typeof raw["hostCapability"] !== "string" || !CAP_SET.has(raw["hostCapability"])) {
    issues.push(issue("policy.hostCapability", "must be full_state_machine or capability_limited"));
  }
}

function validateContinuation(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("continuation", "required object"));
    return;
  }
  const kind = raw["kind"];
  if (typeof kind !== "string" || !CONTINUATION_KINDS.has(kind)) {
    issues.push(issue("continuation.kind", "must be none | pending_correlated_tool_result | active_non_tool"));
    return;
  }
  if (kind === "pending_correlated_tool_result") {
    if (typeof raw["toolCallId"] !== "string" || raw["toolCallId"].length === 0) {
      issues.push(issue("continuation.toolCallId", "required non-empty string"));
    }
    if (!isBool(raw["correlationValid"])) {
      issues.push(issue("continuation.correlationValid", "must be a boolean"));
    }
  }
}

function validateInvariants(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("invariants", "required object"));
    return;
  }
  for (const k of ["captureComplete", "providerIdentityValid", "singleOpenTurn"] as const) {
    requireBool(raw, k, "invariants", issues);
  }
  if (typeof raw["writerClaim"] !== "string" || !WRITER_SET.has(raw["writerClaim"])) {
    issues.push(issue("invariants.writerClaim", "must be none | lhc | native | conflict"));
  }
}

function validateMaterial(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("compactMaterial", "required object"));
    return;
  }
  for (const k of [
    "derivationsMissingOrFailed",
    "lowerTargetMet",
    "compactStructurallyValid",
    "installSucceeds",
    "usefulReduction",
    "canProduceValidProviderRequest",
  ] as const) {
    requireBool(raw, k, "compactMaterial", issues);
  }
}

/** Validate a CompactContinuationInput shape (fixture input side). */
export function validateCompactContinuationInput(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "input must be an object")] };
  }
  if (typeof raw["contractVersion"] !== "string" || raw["contractVersion"].length === 0) {
    issues.push(issue("contractVersion", "required non-empty string"));
  }
  validateSeam(raw["seam"], issues);
  validateProviderUsage(raw["providerUsage"], issues);
  validateEstimate(raw["postMeasurementEstimate"], issues);
  validatePolicy(raw["policy"], issues);
  validateContinuation(raw["continuation"], issues);
  validateInvariants(raw["invariants"], issues);
  if (!isBool(raw["pendingForcedContinuationBoundary"])) {
    issues.push(issue("pendingForcedContinuationBoundary", "must be a boolean"));
  }
  validateMaterial(raw["compactMaterial"], issues);

  // Reject unsafe combined token sums before arithmetic (pressure = base + estimate).
  if (
    isObject(raw["providerUsage"]) &&
    raw["providerUsage"]["available"] === true &&
    isSafeNonNegInt(raw["providerUsage"]["total"]) &&
    isObject(raw["postMeasurementEstimate"]) &&
    isSafeNonNegInt(raw["postMeasurementEstimate"]["tokens"])
  ) {
    const combined = raw["providerUsage"]["total"] + raw["postMeasurementEstimate"]["tokens"];
    if (!Number.isSafeInteger(combined)) {
      issues.push(
        issue(
          "postMeasurementEstimate.tokens",
          "provider total + estimate is not a safe integer; reject before arithmetic",
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateEffect(effect: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(effect)) {
    issues.push(issue(path, "effect must be an object"));
    return;
  }
  const type = effect["type"];
  if (typeof type !== "string" || !EFFECT_TYPES.has(type)) {
    issues.push(issue(`${path}.type`, `unknown effect type ${String(type)}`));
    return;
  }
  if (type === "force_turn_end") {
    if (effect["reason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
      issues.push(issue(`${path}.reason`, `must be ${CONTEXT_COMPACT_CONTINUE_REASON}`));
    }
    if (effect["outcome"] !== "completed") {
      issues.push(issue(`${path}.outcome`, 'must be "completed"'));
    }
    if (effect["opensContinuationTurn"] !== true) {
      issues.push(issue(`${path}.opensContinuationTurn`, "must be true"));
    }
    if (effect["continuationTurnCount"] !== 1) {
      issues.push(issue(`${path}.continuationTurnCount`, "must be 1"));
    }
  }
  if (type === "insert_continuation_marker") {
    if (effect["kind"] !== COMPACT_CONTINUATION_MARKER_KIND) {
      issues.push(issue(`${path}.kind`, `must be ${COMPACT_CONTINUATION_MARKER_KIND}`));
    }
    if (effect["userChatVisible"] !== false) {
      issues.push(issue(`${path}.userChatVisible`, "must be false"));
    }
    if (effect["modelVisible"] !== true) {
      issues.push(issue(`${path}.modelVisible`, "must be true"));
    }
  }
  if (type === "record_receipt") {
    if (effect["userChatVisible"] !== false) {
      issues.push(issue(`${path}.userChatVisible`, "receipts must not be user chat"));
    }
    if (effect["durable"] !== true) {
      issues.push(issue(`${path}.durable`, "must be true"));
    }
  }
  if (type === "preserve_tool_pair_verbatim") {
    if (typeof effect["toolCallId"] !== "string" || effect["toolCallId"].length === 0) {
      issues.push(issue(`${path}.toolCallId`, "required non-empty string"));
    }
    if (effect["location"] !== "open_turn_tail") {
      issues.push(issue(`${path}.location`, 'must be "open_turn_tail"'));
    }
  }
  if (type === "skip_seam") {
    if (typeof effect["code"] !== "string" || !SKIP_SET.has(effect["code"])) {
      issues.push(issue(`${path}.code`, `unknown skip code ${String(effect["code"])}`));
    }
  }
  if (type === "refuse") {
    if (typeof effect["code"] !== "string" || !REFUSE_SET.has(effect["code"])) {
      issues.push(issue(`${path}.code`, `unknown refuse code ${String(effect["code"])}`));
    }
  }
}

function validateResidual(raw: unknown, issues: ValidationIssue[]): void {
  if (!isObject(raw)) {
    issues.push(issue("residual", "required object"));
    return;
  }
  for (const k of [
    "writerReleased",
    "priorServingViewIntact",
    "forcedContinuationBoundaryApplied",
    "continuationTurnOpened",
    "markerServed",
    "originalAgenticTurnStillOpen",
    "nextProviderRequestAllowed",
  ] as const) {
    requireBool(raw, k, "residual", issues);
  }
  if (raw["writerReleased"] !== true) {
    issues.push(issue("residual.writerReleased", "terminal receipts must release the writer"));
  }
}

/** Receipt structural rules shared by fixtures and live decisions. */
export function validateCompactContinuationReceipt(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "receipt must be an object")] };
  }
  if (raw["contractVersion"] !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    issues.push(issue("contractVersion", "oracle version mismatch"));
  }
  if (typeof raw["outcome"] !== "string" || !OUTCOME_SET.has(raw["outcome"])) {
    issues.push(issue("outcome", `unknown outcome ${String(raw["outcome"])}`));
  }
  if (typeof raw["reasonCode"] !== "string" || raw["reasonCode"].length === 0) {
    issues.push(issue("reasonCode", "required non-empty string"));
  }
  if (raw["turnEndReason"] !== null && raw["turnEndReason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
    issues.push(issue("turnEndReason", `must be null or ${CONTEXT_COMPACT_CONTINUE_REASON}`));
  }

  if (!Array.isArray(raw["effects"])) {
    issues.push(issue("effects", "must be an array"));
  } else {
    for (const [i, e] of raw["effects"].entries()) {
      validateEffect(e, `effects[${i}]`, issues);
    }
  }

  if (!Array.isArray(raw["transitionPath"])) {
    issues.push(issue("transitionPath", "must be an array"));
  } else {
    for (const [i, s] of raw["transitionPath"].entries()) {
      if (typeof s !== "string" || !STATE_SET.has(s)) {
        issues.push(issue(`transitionPath[${i}]`, `unknown state ${String(s)}`));
      }
    }
  }

  if (!isObject(raw["pressure"])) {
    issues.push(issue("pressure", "required object"));
  } else {
    const p = raw["pressure"];
    if (p["providerBaseDomain"] !== "provider_reported_input") {
      issues.push(issue("pressure.providerBaseDomain", 'must be "provider_reported_input"'));
    }
    if (p["estimateDomain"] !== "source_labelled_estimate") {
      issues.push(issue("pressure.estimateDomain", 'must be "source_labelled_estimate"'));
    }
    if (p["providerBaseTokens"] === null && p["nextRequestPressureTokens"] !== null) {
      issues.push(issue("pressure.nextRequestPressureTokens", "must be null when provider base is unavailable"));
    }
    if (p["providerBaseTokens"] === null && p["atOrAboveTrigger"] !== null) {
      issues.push(issue("pressure.atOrAboveTrigger", "must be null when provider base is unavailable"));
    }
  }

  if (!isObject(raw["lowerTarget"])) {
    issues.push(issue("lowerTarget", "required object"));
  } else {
    if (raw["lowerTarget"]["domain"] !== "lhc_rendered_history") {
      issues.push(issue("lowerTarget.domain", 'must be "lhc_rendered_history"'));
    }
    if (raw["lowerTarget"]["isSuccessGate"] !== false) {
      issues.push(issue("lowerTarget.isSuccessGate", "must be false"));
    }
  }

  validateResidual(raw["residual"], issues);

  if (!isBool(raw["refused"])) {
    issues.push(issue("refused", "must be a boolean"));
  }
  if (!isBool(raw["skipped"])) {
    issues.push(issue("skipped", "must be a boolean"));
  }

  if (raw["refused"] === true) {
    if (raw["outcome"] !== "refuse") {
      issues.push(issue("outcome", "refused receipts must have outcome refuse"));
    }
    if (typeof raw["refuseCode"] !== "string" || !REFUSE_SET.has(raw["refuseCode"])) {
      issues.push(issue("refuseCode", "required refuse code when refused"));
    }
    if (raw["skipped"] === true) {
      issues.push(issue("skipped", "refused and skipped are mutually exclusive"));
    }
  } else if (raw["refuseCode"] !== null && raw["refuseCode"] !== undefined) {
    issues.push(issue("refuseCode", "must be null when not refused"));
  }

  if (raw["skipped"] === true) {
    if (raw["outcome"] !== "skip_seam") {
      issues.push(issue("outcome", "skipped receipts must have outcome skip_seam"));
    }
    if (typeof raw["skipCode"] !== "string" || !SKIP_SET.has(raw["skipCode"])) {
      issues.push(issue("skipCode", "required skip code when skipped"));
    }
    if (raw["refused"] === true) {
      issues.push(issue("refused", "refused and skipped are mutually exclusive"));
    }
  } else if (raw["skipCode"] !== null && raw["skipCode"] !== undefined) {
    issues.push(issue("skipCode", "must be null when not skipped"));
  }

  // Force-boundary effects must tie to turnEndReason.
  if (Array.isArray(raw["effects"])) {
    const types = raw["effects"].map((e) => (isObject(e) ? e["type"] : null));
    const hasForce = types.includes("force_turn_end");
    const hasMarker = types.includes("insert_continuation_marker");
    const hasPreserve = types.includes("preserve_tool_pair_verbatim");
    const hasInstall = types.includes("install_serving_view");
    const hasClaim = types.includes("claim_writer");
    const hasRelease = types.includes("release_writer");
    const hasCompact = types.includes("compact");
    const hasDegrade = types.includes("degrade_fidelity");

    if (hasForce && raw["turnEndReason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
      issues.push(issue("turnEndReason", "force_turn_end requires turnEndReason context_compact_continue"));
    }

    // Outcomes that imply a forced boundary (including degraded + post-boundary refuse).
    const boundaryOutcomes = new Set(["compact_continue_turn", "degraded_compact", "no_reduction", "refuse"]);
    if (isObject(raw["residual"]) && raw["residual"]["forcedContinuationBoundaryApplied"] === true) {
      if (raw["turnEndReason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
        issues.push(
          issue("turnEndReason", "forcedContinuationBoundaryApplied requires turnEndReason context_compact_continue"),
        );
      }
      if (isObject(raw["continuation"]) && raw["continuation"]["opened"] !== true) {
        issues.push(issue("continuation.opened", "forced boundary must open exactly one continuation turn"));
      }
    }

    // Mutual exclusions: preserve vs marker / force.
    if (hasPreserve && hasMarker) {
      issues.push(issue("effects", "preserve_tool and continuation marker are mutually exclusive"));
    }
    if (hasPreserve && hasForce) {
      issues.push(issue("effects", "preserve_tool path must not force turn_end"));
    }
    if (hasForce && hasPreserve) {
      issues.push(issue("effects", "continue-turn path must not preserve tool pair"));
    }

    // force_turn_end implies opensContinuationTurn semantics (no separate open effect).
    if (hasForce && types.includes("open_continuation_turn")) {
      issues.push(
        issue("effects", "open_continuation_turn is not a separate effect; force_turn_end opens the turn atomically"),
      );
    }

    // Meaningful order: claim before release; force before compact when both present;
    // degrade after compact and before install; compact before install.
    if (hasClaim && hasRelease) {
      if (types.indexOf("claim_writer") > types.indexOf("release_writer")) {
        issues.push(issue("effects", "claim_writer must precede release_writer"));
      }
    }
    if (hasForce && hasCompact) {
      if (types.indexOf("force_turn_end") > types.indexOf("compact")) {
        issues.push(issue("effects", "force_turn_end must precede compact so the closed turn is eligible"));
      }
    }
    if (hasCompact && hasInstall) {
      if (types.indexOf("compact") > types.indexOf("install_serving_view")) {
        issues.push(issue("effects", "compact must precede install_serving_view"));
      }
    }
    if (hasDegrade && hasCompact) {
      if (types.indexOf("degrade_fidelity") < types.indexOf("compact")) {
        issues.push(issue("effects", "degrade_fidelity must be classified at/after compact assembly"));
      }
    }
    if (hasDegrade && hasInstall) {
      if (types.indexOf("degrade_fidelity") > types.indexOf("install_serving_view")) {
        issues.push(issue("effects", "degrade_fidelity must precede install (classified at assembly)"));
      }
    }
    if (hasInstall && isObject(raw["residual"]) && raw["residual"]["priorServingViewIntact"] === true) {
      issues.push(
        issue(
          "residual.priorServingViewIntact",
          "successful install_serving_view means prior serving view is not intact",
        ),
      );
    }
    if (
      !hasInstall &&
      isObject(raw["residual"]) &&
      raw["residual"]["priorServingViewIntact"] === false &&
      raw["outcome"] === "refuse"
    ) {
      issues.push(
        issue("residual.priorServingViewIntact", "install failure must not imply a partially installed view"),
      );
    }

    // Continuation receipt fields vs effects.
    if (isObject(raw["continuation"])) {
      if (raw["continuation"]["markerServed"] === true && !hasMarker) {
        issues.push(issue("continuation.markerServed", "true requires insert_continuation_marker"));
      }
      if (raw["continuation"]["markerServed"] === false && hasMarker) {
        issues.push(issue("continuation.markerServed", "false contradicts insert_continuation_marker"));
      }
      if (raw["continuation"]["opened"] === true && raw["continuation"]["sameAgenticTurnPreserved"] !== false) {
        issues.push(
          issue("continuation.sameAgenticTurnPreserved", "opened continuation must close the prior agentic turn"),
        );
      }
    }

    // Success continue-turn outcomes require force (or residual pending boundary) + marker.
    if (raw["outcome"] === "compact_continue_turn") {
      if (raw["turnEndReason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
        issues.push(issue("turnEndReason", "compact_continue_turn requires context_compact_continue"));
      }
      if (!hasMarker) {
        issues.push(issue("effects", "compact_continue_turn requires continuation marker"));
      }
    }

    // silence unused (boundaryOutcomes reserved for future tighter checks)
    void boundaryOutcomes;
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Cross-check that a Decision is internally consistent and that receipt
 * mirrors decision fields used by parity fixtures.
 */
export function validateCompactContinuationDecision(decision: CompactContinuationDecision): ValidationResult {
  const issues: ValidationIssue[] = [];
  const r = validateCompactContinuationReceipt(decision.receipt);
  issues.push(...r.issues);

  if (decision.outcome !== decision.receipt.outcome) {
    issues.push(issue("outcome", "decision.outcome must match receipt.outcome"));
  }
  if (JSON.stringify(decision.effects) !== JSON.stringify(decision.receipt.effects)) {
    issues.push(issue("effects", "decision.effects must match receipt.effects"));
  }
  if (JSON.stringify(decision.transitionPath) !== JSON.stringify(decision.receipt.transitionPath)) {
    issues.push(issue("transitionPath", "decision.transitionPath must match receipt"));
  }
  if (decision.terminalState !== decision.transitionPath[decision.transitionPath.length - 1]) {
    issues.push(issue("terminalState", "must equal last transitionPath entry"));
  }
  if (!STATE_SET.has(decision.terminalState)) {
    issues.push(issue("terminalState", `unknown state ${decision.terminalState}`));
  }

  // Compact/no_reduction/failure paths must include selected branch state.
  const path = decision.transitionPath;
  if (path.includes("compacting")) {
    if (!path.includes("path_preserve_tool") && !path.includes("path_continue_turn")) {
      issues.push(issue("transitionPath", "compacting paths must include path_preserve_tool or path_continue_turn"));
    }
  }

  // Missing provider usage must not pass through below_trigger.
  if (decision.receipt.pressure.providerBaseTokens === null && path.includes("below_trigger")) {
    issues.push(issue("transitionPath", "missing provider usage must not route through below_trigger"));
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Re-run the pure decision and compare against an expected decision object
 * (fixture expected side). Used by table-driven parity tests.
 */
export function assertDecisionParity(
  actual: CompactContinuationDecision,
  expected: CompactContinuationDecision,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    if (actual.outcome !== expected.outcome) {
      issues.push(issue("outcome", `actual ${actual.outcome} !== expected ${expected.outcome}`));
    }
    if (actual.terminalState !== expected.terminalState) {
      issues.push(issue("terminalState", `actual ${actual.terminalState} !== expected ${expected.terminalState}`));
    }
    if (JSON.stringify(actual.transitionPath) !== JSON.stringify(expected.transitionPath)) {
      issues.push(
        issue(
          "transitionPath",
          `actual ${JSON.stringify(actual.transitionPath)} !== expected ${JSON.stringify(expected.transitionPath)}`,
        ),
      );
    }
    if (JSON.stringify(actual.effects) !== JSON.stringify(expected.effects)) {
      issues.push(issue("effects", "effects diverge from expected"));
    }
    if (JSON.stringify(actual.receipt) !== JSON.stringify(expected.receipt)) {
      issues.push(issue("receipt", "receipt diverges from expected"));
    }
    if (issues.length === 0) {
      issues.push(issue("$", "decision JSON differs from expected"));
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Type-narrowing helper for tests: load fixture JSON as typed input. */
export function asCompactContinuationInput(raw: unknown): CompactContinuationInput {
  const v = validateCompactContinuationInput(raw);
  if (!v.ok) {
    throw new Error(`invalid fixture input: ${v.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  return raw as CompactContinuationInput;
}

export type { CompactContinuationEffect, CompactContinuationOutcomeKind, CompactContinuationState };
