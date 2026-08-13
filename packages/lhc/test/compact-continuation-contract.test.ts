/**
 * LIM-60: compact-continuation contract + parity fixtures.
 * Pure decision table — no thread I/O. Runtime evaluator is LIM-61.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  asCompactContinuationInput,
  assertDecisionParity,
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_INVARIANTS,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_TRANSITION_ORDER,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  decideCompactContinuation,
  validateCompactContinuationDecision,
  validateCompactContinuationInput,
  validateCompactContinuationReceipt,
} from "../src/shared-tech/compact-continuation/index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "compact-continuation", "v1");

type FixtureCase = {
  name: string;
  contractVersion: string;
  description: string;
  coverage: string[];
  input: unknown;
  expected: CompactContinuationDecision;
};

type Manifest = {
  contractVersion: string;
  contractId: string;
  cases: Array<{ file: string; name: string; coverage: string[] }>;
  requiredCoverage: string[];
};

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(fixturesRoot, "manifest.json"), "utf8")) as Manifest;
}

function loadCase(rel: string): FixtureCase {
  return JSON.parse(readFileSync(join(fixturesRoot, rel), "utf8")) as FixtureCase;
}

describe("compact-continuation contract surface", () => {
  it("pins version and stable strings", () => {
    expect(COMPACT_CONTINUATION_CONTRACT_VERSION).toBe("1.0.0");
    expect(CONTEXT_COMPACT_CONTINUE_REASON).toBe("context_compact_continue");
    expect(COMPACT_CONTINUATION_MARKER_KIND).toBe("lhc.compact_continuation");
  });

  it("exports closed vocabularies used by ports", () => {
    expect(COMPACT_CONTINUATION_STATES.length).toBeGreaterThan(10);
    expect(COMPACT_CONTINUATION_OUTCOME_KINDS).toContain("compact_continue_turn");
    expect(COMPACT_CONTINUATION_OUTCOME_KINDS).toContain("compact_preserve_tool");
    expect(COMPACT_CONTINUATION_REFUSE_CODES).toContain("native_writer_conflict");
    expect(COMPACT_CONTINUATION_TRANSITION_ORDER[0]).toBe("seam_eligibility");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("stable_turn_end_reason_context_compact_continue");
  });
});

describe("compact-continuation parity fixtures", () => {
  const manifest = loadManifest();

  it("manifest version and required coverage are complete", () => {
    expect(manifest.contractVersion).toBe(COMPACT_CONTINUATION_CONTRACT_VERSION);
    expect(manifest.contractId).toBe("lhc.compact_continuation");
    expect(manifest.cases.length).toBeGreaterThanOrEqual(14);

    const covered = new Set(manifest.cases.flatMap((c) => c.coverage));
    for (const tag of manifest.requiredCoverage) {
      expect(covered.has(tag), `missing coverage tag: ${tag}`).toBe(true);
    }
  });

  it("every cases/*.json file is listed in the manifest", () => {
    const onDisk = readdirSync(join(fixturesRoot, "cases"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => `cases/${f}`)
      .sort();
    const listed = manifest.cases.map((c) => c.file).sort();
    expect(listed).toEqual(onDisk);
  });

  for (const entry of loadManifest().cases) {
    it(`case ${entry.name}: input/expected validate and decision matches exactly`, () => {
      const fixture = loadCase(entry.file);
      expect(fixture.contractVersion).toBe(COMPACT_CONTINUATION_CONTRACT_VERSION);
      expect(fixture.name).toBe(entry.name);

      const inputCheck = validateCompactContinuationInput(fixture.input);
      expect(inputCheck.ok, JSON.stringify(inputCheck.issues)).toBe(true);

      const expectedCheck = validateCompactContinuationDecision(fixture.expected);
      expect(expectedCheck.ok, JSON.stringify(expectedCheck.issues)).toBe(true);

      const receiptCheck = validateCompactContinuationReceipt(fixture.expected.receipt);
      expect(receiptCheck.ok, JSON.stringify(receiptCheck.issues)).toBe(true);

      const input = asCompactContinuationInput(fixture.input);
      const actual = decideCompactContinuation(input);

      const parity = assertDecisionParity(actual, fixture.expected);
      expect(parity.ok, JSON.stringify(parity.issues)).toBe(true);
      // Exact JSON equality for cross-language oracle discipline.
      expect(actual).toEqual(fixture.expected);
    });
  }
});

describe("compact-continuation decision invariants", () => {
  it("never fabricates next-request pressure without provider base", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput({
        contractVersion: COMPACT_CONTINUATION_CONTRACT_VERSION,
        seam: {
          modelResponseComplete: true,
          requestedToolsSettled: true,
          captureFlushed: true,
          beforeNextProviderRequest: true,
          insideTransportRetry: false,
          inputEpochAtDecision: 0,
          inputEpochAtApply: 0,
        },
        providerUsage: {
          available: false,
          reason: "missing",
          domain: "provider_reported_input",
        },
        postMeasurementEstimate: {
          tokens: 50_000,
          source: "lhc_token_estimate",
          domain: "source_labelled_estimate",
        },
        policy: {
          upperTriggerTokens: 10_000,
          lowerTargetTokens: 5_000,
          hostCapability: "full_state_machine",
        },
        continuation: { kind: "active_non_tool" },
        invariants: {
          captureComplete: true,
          providerIdentityValid: true,
          singleOpenTurn: true,
          writerClaim: "none",
        },
        compactMaterial: {
          derivationsMissingOrFailed: false,
          lowerTargetMet: true,
          compactStructurallyValid: true,
          installSucceeds: true,
          usefulReduction: true,
          canProduceValidProviderRequest: true,
        },
      }),
    );
    expect(actual.outcome).toBe("continue_normal");
    expect(actual.receipt.pressure.nextRequestPressureTokens).toBeNull();
    expect(actual.receipt.pressure.atOrAboveTrigger).toBeNull();
  });

  it("active non-tool path forces stable reason and hides marker from user chat", () => {
    const fixture = loadCase("cases/active_non_tool_above_trigger.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    expect(actual.outcome).toBe("compact_continue_turn");
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
    const marker = actual.effects.find((e) => e.type === "insert_continuation_marker");
    expect(marker).toMatchObject({
      kind: COMPACT_CONTINUATION_MARKER_KIND,
      modelVisible: true,
      userChatVisible: false,
    });
    expect(actual.effects.some((e) => e.type === "preserve_tool_pair_verbatim")).toBe(false);
  });

  it("pending tool path preserves pair and inserts no continuation marker", () => {
    const fixture = loadCase("cases/pending_tool_result_above_trigger.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    expect(actual.outcome).toBe("compact_preserve_tool");
    expect(actual.receipt.turnEndReason).toBeNull();
    expect(actual.receipt.continuation.sameAgenticTurnPreserved).toBe(true);
    expect(actual.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
    expect(actual.effects.some((e) => e.type === "force_turn_end")).toBe(false);
    expect(actual.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "preserve_tool_pair_verbatim",
          toolCallId: "call-42",
        }),
      ]),
    );
  });

  it("receipts are never user-chat visible", () => {
    for (const entry of loadManifest().cases) {
      const fixture = loadCase(entry.file);
      for (const effect of fixture.expected.effects) {
        if (effect.type === "record_receipt") {
          expect(effect.userChatVisible).toBe(false);
          expect(effect.durable).toBe(true);
        }
      }
    }
  });

  it("lower target is never a success gate on receipts", () => {
    for (const entry of loadManifest().cases) {
      const fixture = loadCase(entry.file);
      expect(fixture.expected.receipt.lowerTarget.isSuccessGate).toBe(false);
      expect(fixture.expected.receipt.lowerTarget.domain).toBe("lhc_rendered_history");
    }
  });
});
