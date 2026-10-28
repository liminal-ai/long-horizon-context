import { createHash } from "node:crypto";
import {
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  type CompactContinuationPolicy,
} from "../../shared-tech/compact-continuation/index.js";
import type { ViewCompactParams } from "../../shared-tech/index.js";
import type { CompactContinuationHostFacts } from "./run.js";
import type { AttemptRow, WriterClaimRow } from "./store.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function computeOperationIdentity(facts: CompactContinuationHostFacts): Record<string, unknown> {
  const continuationIdentity: Record<string, unknown> =
    facts.continuation.kind === "pending_correlated_tool_result"
      ? {
          kind: facts.continuation.kind,
          protectedToolCallIds: [...facts.continuation.protectedToolCallIds].sort(),
        }
      : { kind: facts.continuation.kind };
  return {
    contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
    attemptId: facts.attemptId,
    actor: facts.actor,
    harness: facts.harness,
    continuation: continuationIdentity,
    policy: facts.policy,
    ...(facts.compact !== undefined ? { compact: facts.compact } : {}),
  };
}

export function computeRetryPosture(
  facts: CompactContinuationHostFacts,
  durableWriter: WriterClaimRow,
): Record<string, unknown> {
  return {
    seam: facts.seam,
    providerUsage: facts.providerUsage,
    postMeasurementEstimate: facts.postMeasurementEstimate,
    captureComplete: facts.captureComplete,
    providerIdentityValid: facts.providerIdentityValid,
    hostWriterClaim: facts.writerClaim,
    durableWriter: {
      claim: durableWriter.claim,
      attemptId: durableWriter.attemptId,
    },
    ...(facts.continuation.kind === "pending_correlated_tool_result"
      ? { correlationValid: facts.continuation.correlationValid }
      : {}),
  };
}

export function computeAttemptIntent(facts: CompactContinuationHostFacts): Record<string, unknown> {
  return computeOperationIdentity(facts);
}

export function hashAttemptIntent(intent: Record<string, unknown>): { intentHash: string; intentJson: string } {
  const intentJson = stableStringify(intent);
  const intentHash = createHash("sha256").update(intentJson).digest("hex");
  return { intentHash, intentJson };
}

export function hashRecord(value: Record<string, unknown>): { hash: string; json: string } {
  const json = stableStringify(value);
  const hash = createHash("sha256").update(json).digest("hex");
  return { hash, json };
}

export type StoredOperationIdentity = {
  contractVersion: string;
  attemptId: string;
  actor: string;
  harness: string;
  continuation:
    | { kind: "none" }
    | { kind: "active_non_tool" }
    | { kind: "pending_correlated_tool_result"; protectedToolCallIds: string[] };
  policy: CompactContinuationPolicy;
  compact?: { profile?: string; params?: ViewCompactParams };
  intentHash: string;
  intentJson: string;
  createdAt: string;
};

function requireStringField(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${ctx}: missing or empty string field '${key}'`);
  }
  return v;
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${ctx}: missing or non-finite number field '${key}'`);
  }
  return v;
}

export function parseStoredOperationIdentity(row: AttemptRow): StoredOperationIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.intentJson);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`compact-continuation attempt intent JSON corrupt for attemptId=${row.attemptId}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`compact-continuation attempt intent JSON must be an object for attemptId=${row.attemptId}`);
  }
  const obj = parsed as Record<string, unknown>;
  const contractVersion = requireStringField(obj, "contractVersion", "operation identity");
  const attemptId = requireStringField(obj, "attemptId", "operation identity");
  if (attemptId !== row.attemptId) {
    throw new Error(`operation identity attemptId mismatch: row=${row.attemptId} json=${attemptId}`);
  }
  const actor = requireStringField(obj, "actor", "operation identity");
  const harness = requireStringField(obj, "harness", "operation identity");

  const contRaw = obj["continuation"];
  if (contRaw === null || typeof contRaw !== "object" || Array.isArray(contRaw)) {
    throw new Error("operation identity: continuation must be an object");
  }
  const contObj = contRaw as Record<string, unknown>;
  const contKind = requireStringField(contObj, "kind", "operation identity.continuation");
  let continuation: StoredOperationIdentity["continuation"];
  if (contKind === "none") {
    continuation = { kind: "none" };
  } else if (contKind === "active_non_tool") {
    continuation = { kind: "active_non_tool" };
  } else if (contKind === "pending_correlated_tool_result") {
    const idsRaw = contObj["protectedToolCallIds"];
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      throw new Error("operation identity: protectedToolCallIds must be a non-empty array");
    }
    const protectedToolCallIds: string[] = [];
    for (const id of idsRaw) {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("operation identity: protectedToolCallIds entries must be non-empty strings");
      }
      protectedToolCallIds.push(id);
    }
    continuation = {
      kind: "pending_correlated_tool_result",
      protectedToolCallIds: [...protectedToolCallIds].sort(),
    };
  } else {
    throw new Error(`operation identity: unknown continuation.kind '${contKind}'`);
  }

  const policyRaw = obj["policy"];
  if (policyRaw === null || typeof policyRaw !== "object" || Array.isArray(policyRaw)) {
    throw new Error("operation identity: policy must be an object");
  }
  const policyObj = policyRaw as Record<string, unknown>;
  const hostCapability = requireStringField(policyObj, "hostCapability", "operation identity.policy");
  if (hostCapability !== "full_state_machine" && hostCapability !== "capability_limited") {
    throw new Error(`operation identity: invalid policy.hostCapability '${hostCapability}'`);
  }
  const policy: CompactContinuationPolicy = {
    upperTriggerTokens: requireFiniteNumber(policyObj, "upperTriggerTokens", "operation identity.policy"),
    lowerTargetTokens: requireFiniteNumber(policyObj, "lowerTargetTokens", "operation identity.policy"),
    hostCapability,
  };
  if (policyObj["safeRunwayThresholdTokens"] !== undefined) {
    policy.safeRunwayThresholdTokens = requireFiniteNumber(
      policyObj,
      "safeRunwayThresholdTokens",
      "operation identity.policy",
    );
  }
  if (policyObj["safeRunwayThresholdSource"] !== undefined) {
    const src = policyObj["safeRunwayThresholdSource"];
    if (typeof src !== "string" || src.length === 0) {
      throw new Error("operation identity: policy.safeRunwayThresholdSource must be a non-empty string");
    }
    policy.safeRunwayThresholdSource = src;
  }

  let compact: StoredOperationIdentity["compact"];
  if (obj["compact"] !== undefined) {
    const compactRaw = obj["compact"];
    if (compactRaw === null || typeof compactRaw !== "object" || Array.isArray(compactRaw)) {
      throw new Error("operation identity: compact must be an object when present");
    }
    const compactObj = compactRaw as Record<string, unknown>;
    const out: { profile?: string; params?: ViewCompactParams } = {};
    if (compactObj["profile"] !== undefined) {
      if (typeof compactObj["profile"] !== "string") {
        throw new Error("operation identity: compact.profile must be a string");
      }
      out.profile = compactObj["profile"];
    }
    if (compactObj["params"] !== undefined) {
      if (
        compactObj["params"] === null ||
        typeof compactObj["params"] !== "object" ||
        Array.isArray(compactObj["params"])
      ) {
        throw new Error("operation identity: compact.params must be an object");
      }
      out.params = compactObj["params"] as ViewCompactParams;
    }
    compact = out;
  }

  const recomputed = createHash("sha256").update(row.intentJson).digest("hex");
  if (recomputed !== row.intentHash) {
    throw new Error(
      `operation identity intent_hash mismatch for attemptId=${row.attemptId}: stored=${row.intentHash} recomputed=${recomputed}`,
    );
  }

  return {
    contractVersion,
    attemptId,
    actor,
    harness,
    continuation,
    policy,
    ...(compact !== undefined ? { compact } : {}),
    intentHash: row.intentHash,
    intentJson: row.intentJson,
    createdAt: row.createdAt,
  };
}
