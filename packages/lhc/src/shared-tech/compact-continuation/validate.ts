/**
 * Structural validation for compact-continuation parity fixtures and receipts.
 * Pure: no I/O. Suitable for TypeScript tests now and Rust ports later.
 */

import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_STATES,
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

const OUTCOME_SET = new Set<string>(COMPACT_CONTINUATION_OUTCOME_KINDS);
const STATE_SET = new Set<string>(COMPACT_CONTINUATION_STATES);
const REFUSE_SET = new Set<string>(COMPACT_CONTINUATION_REFUSE_CODES);

const EFFECT_TYPES = new Set([
  "claim_writer",
  "release_writer",
  "force_turn_end",
  "open_continuation_turn",
  "compact",
  "preserve_tool_pair_verbatim",
  "insert_continuation_marker",
  "install_serving_view",
  "record_receipt",
  "degrade_fidelity",
  "skip_seam",
  "refuse",
]);

/** Validate a CompactContinuationInput shape (fixture input side). */
export function validateCompactContinuationInput(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "input must be an object")] };
  }
  if (raw["contractVersion"] !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    issues.push(
      issue(
        "contractVersion",
        `expected ${COMPACT_CONTINUATION_CONTRACT_VERSION}, got ${String(raw["contractVersion"])}`,
      ),
    );
  }
  if (!isObject(raw["seam"])) issues.push(issue("seam", "required object"));
  if (!isObject(raw["providerUsage"])) issues.push(issue("providerUsage", "required object"));
  if (!isObject(raw["postMeasurementEstimate"])) {
    issues.push(issue("postMeasurementEstimate", "required object"));
  }
  if (!isObject(raw["policy"])) issues.push(issue("policy", "required object"));
  if (!isObject(raw["continuation"])) issues.push(issue("continuation", "required object"));
  if (!isObject(raw["invariants"])) issues.push(issue("invariants", "required object"));
  if (!isObject(raw["compactMaterial"])) issues.push(issue("compactMaterial", "required object"));

  if (isObject(raw["policy"])) {
    if (!isSafeNonNegInt(raw["policy"]["upperTriggerTokens"])) {
      issues.push(issue("policy.upperTriggerTokens", "must be a non-negative safe integer"));
    }
    if (!isSafeNonNegInt(raw["policy"]["lowerTargetTokens"])) {
      issues.push(issue("policy.lowerTargetTokens", "must be a non-negative safe integer"));
    }
  }

  if (isObject(raw["providerUsage"]) && raw["providerUsage"]["available"] === true) {
    const pu = raw["providerUsage"];
    for (const k of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "total"] as const) {
      if (!isSafeNonNegInt(pu[k])) {
        issues.push(issue(`providerUsage.${k}`, "must be a non-negative safe integer"));
      }
    }
    if (
      isSafeNonNegInt(pu["inputTokens"]) &&
      isSafeNonNegInt(pu["cacheCreationTokens"]) &&
      isSafeNonNegInt(pu["cacheReadTokens"]) &&
      isSafeNonNegInt(pu["total"])
    ) {
      const sum = pu["inputTokens"] + pu["cacheCreationTokens"] + pu["cacheReadTokens"];
      if (sum !== pu["total"]) {
        issues.push(
          issue("providerUsage.total", `must equal input+cacheCreation+cacheRead (${sum}), got ${pu["total"]}`),
        );
      }
    }
    if (pu["domain"] !== "provider_reported_input") {
      issues.push(issue("providerUsage.domain", 'must be "provider_reported_input"'));
    }
  }

  if (isObject(raw["postMeasurementEstimate"])) {
    const est = raw["postMeasurementEstimate"];
    if (!isSafeNonNegInt(est["tokens"])) {
      issues.push(issue("postMeasurementEstimate.tokens", "must be a non-negative safe integer"));
    }
    if (typeof est["source"] !== "string" || est["source"].length === 0) {
      issues.push(issue("postMeasurementEstimate.source", "must be a non-empty string label"));
    }
    if (est["domain"] !== "source_labelled_estimate") {
      issues.push(issue("postMeasurementEstimate.domain", 'must be "source_labelled_estimate"'));
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
  if (type === "open_continuation_turn" && effect["count"] !== 1) {
    issues.push(issue(`${path}.count`, "must open exactly one continuation turn"));
  }
  if (type === "refuse") {
    if (typeof effect["code"] !== "string" || !REFUSE_SET.has(effect["code"])) {
      issues.push(issue(`${path}.code`, `unknown refuse code ${String(effect["code"])}`));
    }
  }
}

/** Receipt structural rules shared by fixtures and live decisions. */
export function validateCompactContinuationReceipt(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "receipt must be an object")] };
  }
  if (raw["contractVersion"] !== COMPACT_CONTINUATION_CONTRACT_VERSION) {
    issues.push(issue("contractVersion", "version mismatch"));
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
    // Never invent pressure when no provider base.
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
  if (raw["refused"] === true) {
    if (raw["outcome"] !== "refuse") {
      issues.push(issue("outcome", "refused receipts must have outcome refuse"));
    }
    if (typeof raw["refuseCode"] !== "string" || !REFUSE_SET.has(raw["refuseCode"])) {
      issues.push(issue("refuseCode", "required refuse code when refused"));
    }
  }
  if (raw["outcome"] === "compact_continue_turn" || raw["reasonCode"] === CONTEXT_COMPACT_CONTINUE_REASON) {
    if (raw["turnEndReason"] !== CONTEXT_COMPACT_CONTINUE_REASON) {
      issues.push(issue("turnEndReason", "continuation-turn path must force context_compact_continue"));
    }
  }
  if (isObject(raw["continuation"]) && raw["continuation"]["opened"] === true) {
    if (raw["continuation"]["markerServed"] !== true) {
      issues.push(issue("continuation.markerServed", "opened continuation requires marker"));
    }
    if (raw["continuation"]["sameAgenticTurnPreserved"] !== false) {
      issues.push(
        issue("continuation.sameAgenticTurnPreserved", "opened continuation must close the prior agentic turn"),
      );
    }
  }
  // Receipts must never include a user-chat-only telemetry message effect.
  if (Array.isArray(raw["effects"])) {
    for (const [i, e] of raw["effects"].entries()) {
      if (isObject(e) && e["type"] === "record_receipt" && e["userChatVisible"] === true) {
        issues.push(issue(`effects[${i}]`, "receipt must not be ordinary user chat"));
      }
    }
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

  // Effect ordering invariants for successful compact paths.
  const types = decision.effects.map((e) => e.type);
  if (types.includes("claim_writer") && types.includes("release_writer")) {
    if (types.indexOf("claim_writer") > types.indexOf("release_writer")) {
      issues.push(issue("effects", "claim_writer must precede release_writer"));
    }
  }
  if (types.includes("force_turn_end")) {
    if (!types.includes("open_continuation_turn") || !types.includes("insert_continuation_marker")) {
      issues.push(issue("effects", "force_turn_end requires open_continuation_turn and insert_continuation_marker"));
    }
    if (types.includes("preserve_tool_pair_verbatim")) {
      issues.push(issue("effects", "preserve_tool path must not force turn_end / continuation marker"));
    }
  }
  if (types.includes("preserve_tool_pair_verbatim") && types.includes("insert_continuation_marker")) {
    issues.push(issue("effects", "tool-preserve path must not insert continuation marker"));
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
    // Field-level diffs for readable failures.
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
