/**
 * LIM-60: compact-continuation contract + parity fixtures.
 * Pure whole-seam oracle — no thread I/O. Runtime stages are LIM-61.
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
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
  COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE,
  COMPACT_CONTINUATION_SKIP_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_TRANSITION_ORDER,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationSeam,
  type CompactMaterialFacts,
  compactContinuationMarkerIdempotencyKey,
  decideCompactContinuation,
  type ForcedContinuationBoundary,
  type ProviderUsageAuthority,
  validateCompactContinuationDecision,
  validateCompactContinuationInput,
  validateCompactContinuationReceipt,
  type WorkContinuation,
} from "../src/shared-tech/compact-continuation/index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "compact-continuation", "v1");

/** Closed fixture vocabulary: validateCompactContinuationInput expectation. */
const INPUT_VALIDATION_VALUES = ["accept", "reject"] as const;
type InputValidation = (typeof INPUT_VALIDATION_VALUES)[number];

type FixtureCase = {
  name: string;
  contractVersion: string;
  description: string;
  coverage: string[];
  inputValidation: InputValidation;
  input: unknown;
  expected: CompactContinuationDecision;
};

type Manifest = {
  contractVersion: string;
  contractId: string;
  cases: Array<{
    file: string;
    name: string;
    coverage: string[];
    inputValidation: InputValidation;
  }>;
  requiredCoverage: string[];
};

function assertInputValidation(value: unknown, label: string): asserts value is InputValidation {
  expect(
    INPUT_VALIDATION_VALUES.includes(value as InputValidation),
    `${label}: inputValidation must be "accept" | "reject", got ${JSON.stringify(value)}`,
  ).toBe(true);
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(fixturesRoot, "manifest.json"), "utf8")) as Manifest;
}

function loadCase(rel: string): FixtureCase {
  return JSON.parse(readFileSync(join(fixturesRoot, rel), "utf8")) as FixtureCase;
}

function baseInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      available: true,
      inputTokens: 105_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      total: 105_000,
      domain: "provider_reported_input",
    },
    postMeasurementEstimate: {
      tokens: 0,
      source: "lhc_token_estimate",
      domain: "source_labelled_estimate",
    },
    policy: {
      upperTriggerTokens: 100_000,
      lowerTargetTokens: 40_000,
      hostCapability: "full_state_machine",
    },
    continuation: { kind: "active_non_tool" },
    invariants: {
      captureComplete: true,
      providerIdentityValid: true,
      singleOpenTurn: true,
      writerClaim: "none",
    },
    forcedContinuationBoundary: { applied: false },
    compactMaterial: {
      derivationsMissingOrFailed: false,
      lowerTargetMet: true,
      compactStructurallyValid: true,
      installSucceeds: true,
      usefulReduction: true,
      canProduceValidProviderRequest: true,
    },
    ...over,
  };
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
    expect(COMPACT_CONTINUATION_REFUSE_CODES).toContain("unsupported_contract_version");
    expect(COMPACT_CONTINUATION_REFUSE_CODES).toContain("invalid_pending_boundary_continuation");
    expect(COMPACT_CONTINUATION_REFUSE_CODES).not.toContain("transport_retry");
    expect(COMPACT_CONTINUATION_REFUSE_CODES).not.toContain("not_at_settled_seam");
    expect(COMPACT_CONTINUATION_SKIP_CODES).toContain("transport_retry");
    expect(COMPACT_CONTINUATION_SKIP_CODES).toContain("input_epoch_changed");
    expect(COMPACT_CONTINUATION_SKIP_CODES).toContain("not_at_settled_seam");
    expect(COMPACT_CONTINUATION_TRANSITION_ORDER[0]).toBe("seam_eligibility");
    expect(COMPACT_CONTINUATION_TRANSITION_ORDER).toContain("forced_boundary_state_legality");
    expect(COMPACT_CONTINUATION_TRANSITION_ORDER).toContain("force_boundary_if_continue_turn");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("install_failure_wins_over_no_reduction_classification");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("forced_boundary_repair_takes_precedence_over_fresh_pressure");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("marker_persisted_is_residual_state_not_attempt_scoped");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("settled_seam_lhc_claim_early_refuse_records_claim_and_release");
    expect(COMPACT_CONTINUATION_INVARIANTS).toContain("preserve_tool_install_failure_includes_preserve_effect");
    expect(COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX).toBe("lhc.compact_continuation:");
    expect(compactContinuationMarkerIdempotencyKey("t3")).toBe("lhc.compact_continuation:t3");
    expect(COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE).toMatch(/per-variant closed structs/);
    // Component input types are exported for LIM-61 / lhc-rs consumers (type-level pin).
    const _seam = null as CompactContinuationSeam | null;
    const _usage = null as ProviderUsageAuthority | null;
    const _work = null as WorkContinuation | null;
    const _material = null as CompactMaterialFacts | null;
    const _boundary = null as ForcedContinuationBoundary | null;
    void _seam;
    void _usage;
    void _work;
    void _material;
    void _boundary;
  });
});

describe("compact-continuation parity fixtures", () => {
  const manifest = loadManifest();

  it("manifest version and required coverage are complete", () => {
    expect(manifest.contractVersion).toBe(COMPACT_CONTINUATION_CONTRACT_VERSION);
    expect(manifest.contractId).toBe("lhc.compact_continuation");
    expect(manifest.cases.length).toBeGreaterThanOrEqual(18);

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

      assertInputValidation(entry.inputValidation, `manifest ${entry.name}`);
      assertInputValidation(fixture.inputValidation, `fixture ${fixture.name}`);
      expect(fixture.inputValidation, "fixture/manifest inputValidation must agree").toBe(entry.inputValidation);

      const inputCheck = validateCompactContinuationInput(fixture.input);
      // Branch on first-class inputValidation only — never on coverage-tag strings.
      // Rejected inputs may still carry total-oracle expected for direct typed callers.
      if (fixture.inputValidation === "reject") {
        expect(inputCheck.ok, "fixture must remain input-invalid").toBe(false);
      } else {
        expect(inputCheck.ok, JSON.stringify(inputCheck.issues)).toBe(true);
      }

      const expectedCheck = validateCompactContinuationDecision(fixture.expected);
      expect(expectedCheck.ok, JSON.stringify(expectedCheck.issues)).toBe(true);

      const receiptCheck = validateCompactContinuationReceipt(fixture.expected.receipt);
      expect(receiptCheck.ok, JSON.stringify(receiptCheck.issues)).toBe(true);

      const input =
        fixture.inputValidation === "reject"
          ? (fixture.input as ReturnType<typeof asCompactContinuationInput>)
          : asCompactContinuationInput(fixture.input);
      const actual = decideCompactContinuation(input);

      const parity = assertDecisionParity(actual, fixture.expected);
      expect(parity.ok, JSON.stringify(parity.issues)).toBe(true);
      expect(actual).toEqual(fixture.expected);
    });
  }
});

describe("compact-continuation decision invariants", () => {
  it("never fabricates next-request pressure without provider base", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
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
        }),
      ),
    );
    expect(actual.outcome).toBe("continue_normal");
    expect(actual.receipt.pressure.nextRequestPressureTokens).toBeNull();
    expect(actual.receipt.pressure.atOrAboveTrigger).toBeNull();
    expect(actual.transitionPath).not.toContain("below_trigger");
  });

  it("active non-tool path forces boundary before compact and hides marker from user chat", () => {
    const fixture = loadCase("cases/active_non_tool_above_trigger.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    expect(actual.outcome).toBe("compact_continue_turn");
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
    const types = actual.effects.map((e) => e.type);
    expect(types.indexOf("force_turn_end")).toBeLessThan(types.indexOf("compact"));
    expect(types).not.toContain("open_continuation_turn");
    const force = actual.effects.find((e) => e.type === "force_turn_end");
    expect(force).toMatchObject({
      opensContinuationTurn: true,
      continuationTurnCount: 1,
      reason: CONTEXT_COMPACT_CONTINUE_REASON,
    });
    const marker = actual.effects.find((e) => e.type === "insert_continuation_marker");
    expect(marker).toMatchObject({
      kind: COMPACT_CONTINUATION_MARKER_KIND,
      continuationTurnId: "t2",
      idempotencyKey: compactContinuationMarkerIdempotencyKey("t2"),
      semantics: {
        cause: COMPACT_CONTINUATION_MARKER_CAUSE,
        action: COMPACT_CONTINUATION_MARKER_ACTION,
        newUserRequest: false,
        waitForUser: false,
      },
      modelVisible: true,
      userChatVisible: false,
    });
    expect(actual.effects.some((e) => e.type === "preserve_tool_pair_verbatim")).toBe(false);
    expect(actual.receipt.continuation.opened).toBe(true);
    expect(actual.receipt.residual.continuationTurnOpened).toBe(true);
    expect(actual.receipt.residual.markerPersisted).toBe(true);
    expect(actual.receipt.residual.markerServed).toBe(true);
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

  it("post-boundary compact failure keeps boundary durable and releases writer", () => {
    const fixture = loadCase("cases/compact_failed_continue_turn.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("compact_failed");
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
    expect(actual.receipt.residual).toMatchObject({
      writerReleased: true,
      priorServingViewIntact: true,
      forcedContinuationBoundaryApplied: true,
      continuationTurnOpened: true,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: false,
    });
    const types = actual.effects.map((e) => e.type);
    expect(types).toContain("claim_writer");
    expect(types).toContain("force_turn_end");
    expect(types).toContain("compact");
    expect(types).toContain("release_writer");
    expect(types).not.toContain("insert_continuation_marker");
    expect(types).not.toContain("install_serving_view");
    expect(types.indexOf("claim_writer")).toBeLessThan(types.indexOf("release_writer"));
  });

  it("pending forced boundary repair does not re-force turn_end", () => {
    const fixture = loadCase("cases/pending_forced_boundary_repair.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    expect(actual.outcome).toBe("compact_continue_turn");
    expect(actual.effects.some((e) => e.type === "force_turn_end")).toBe(false);
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
    expect(actual.receipt.continuation.opened).toBe(true);
    expect(actual.effects.some((e) => e.type === "insert_continuation_marker")).toBe(true);
  });

  it("capability_limited does not change the full-host decision effects", () => {
    const boundary = {
      applied: true as const,
      continuationTurnId: "t2",
      forcedThisSeam: true,
      markerAlreadyPersisted: false,
    };
    const full = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: boundary,
          policy: {
            upperTriggerTokens: 100_000,
            lowerTargetTokens: 40_000,
            hostCapability: "full_state_machine",
          },
        }),
      ),
    );
    const limited = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: boundary,
          policy: {
            upperTriggerTokens: 100_000,
            lowerTargetTokens: 40_000,
            hostCapability: "capability_limited",
          },
        }),
      ),
    );
    expect(limited.outcome).toBe(full.outcome);
    expect(limited.effects).toEqual(full.effects);
    expect(limited.transitionPath).toEqual(full.transitionPath);
  });

  it("unsupported contract version refuses without accepting the input as v1", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput({
        ...baseInput(),
        contractVersion: "0.9.0",
      }),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("unsupported_contract_version");
    expect(actual.receipt.reasonCode).toContain("0.9.0");
    expect(actual.receipt.contractVersion).toBe(COMPACT_CONTINUATION_CONTRACT_VERSION);
  });

  it("not_at_settled_seam is a skip not a refuse and does not authorize next request", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          seam: {
            modelResponseComplete: true,
            requestedToolsSettled: true,
            captureFlushed: false,
            beforeNextProviderRequest: true,
            insideTransportRetry: false,
            inputEpochAtDecision: 0,
            inputEpochAtApply: 0,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("skip_seam");
    expect(actual.receipt.skipCode).toBe("not_at_settled_seam");
    expect(actual.receipt.refused).toBe(false);
    expect(actual.receipt.residual.nextProviderRequestAllowed).toBe(false);
  });

  it("degrade_fidelity is ordered after compact and before install", () => {
    const fixture = loadCase("cases/derivation_gaps_degraded_compact.json");
    const actual = decideCompactContinuation(asCompactContinuationInput(fixture.input));
    const types = actual.effects.map((e) => e.type);
    expect(types.indexOf("compact")).toBeLessThan(types.indexOf("degrade_fidelity"));
    expect(types.indexOf("degrade_fidelity")).toBeLessThan(types.indexOf("install_serving_view"));
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

  it("rejects non-boolean seam fields in deep input validation", () => {
    const bad = baseInput({
      seam: {
        modelResponseComplete: "yes",
        requestedToolsSettled: true,
        captureFlushed: true,
        beforeNextProviderRequest: true,
        insideTransportRetry: false,
        inputEpochAtDecision: 0,
        inputEpochAtApply: 0,
      },
    });
    const v = validateCompactContinuationInput(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.path.includes("modelResponseComplete"))).toBe(true);
  });

  it("rejects unsafe combined pressure sum", () => {
    const bad = baseInput({
      providerUsage: {
        available: true,
        inputTokens: Number.MAX_SAFE_INTEGER,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        total: Number.MAX_SAFE_INTEGER,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: {
        tokens: 1,
        source: "x",
        domain: "source_labelled_estimate",
      },
    });
    const v = validateCompactContinuationInput(bad);
    expect(v.ok).toBe(false);
  });

  // ── Independent behavioral probes (not regenerated-fixture-only) ─────────

  it("install failure wins over no-reduction on continue-turn", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: true,
            markerAlreadyPersisted: false,
          },
          compactMaterial: {
            derivationsMissingOrFailed: false,
            lowerTargetMet: true,
            compactStructurallyValid: true,
            installSucceeds: false,
            usefulReduction: false,
            canProduceValidProviderRequest: true,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("install_failed");
    expect(actual.effects.map((e) => e.type)).not.toContain("install_serving_view");
    expect(actual.effects.map((e) => e.type)).toContain("insert_continuation_marker");
    expect(actual.receipt.residual).toMatchObject({
      priorServingViewIntact: true,
      markerPersisted: true,
      markerServed: false,
      nextProviderRequestAllowed: false,
      forcedContinuationBoundaryApplied: true,
      writerReleased: true,
    });
  });

  it("install failure wins over no-reduction on preserve-tool", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          continuation: {
            kind: "pending_correlated_tool_result",
            toolCallId: "call-42",
            correlationValid: true,
          },
          compactMaterial: {
            derivationsMissingOrFailed: false,
            lowerTargetMet: true,
            compactStructurallyValid: true,
            installSucceeds: false,
            usefulReduction: false,
            canProduceValidProviderRequest: true,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("install_failed");
    expect(actual.effects.map((e) => e.type)).not.toContain("install_serving_view");
    expect(actual.receipt.residual).toMatchObject({
      priorServingViewIntact: true,
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      nextProviderRequestAllowed: false,
    });
  });

  it("pending boundary resumes repair despite missing provider usage", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          providerUsage: {
            available: false,
            reason: "missing",
            domain: "provider_reported_input",
          },
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          continuation: { kind: "active_non_tool" },
        }),
      ),
    );
    expect(actual.outcome).toBe("compact_continue_turn");
    expect(actual.outcome).not.toBe("continue_normal");
    expect(actual.effects.some((e) => e.type === "force_turn_end")).toBe(false);
    expect(actual.receipt.residual.forcedContinuationBoundaryApplied).toBe(true);
  });

  it("pending boundary resumes repair despite below-trigger pressure", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          providerUsage: {
            available: true,
            inputTokens: 10_000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            total: 10_000,
            domain: "provider_reported_input",
          },
          policy: {
            upperTriggerTokens: 100_000,
            lowerTargetTokens: 40_000,
            hostCapability: "full_state_machine",
          },
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          continuation: { kind: "active_non_tool" },
        }),
      ),
    );
    expect(actual.outcome).toBe("compact_continue_turn");
    expect(actual.transitionPath).not.toContain("below_trigger");
  });

  it("pending boundary with kind none refuses as invalid continuation state", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          continuation: { kind: "none" },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("invalid_pending_boundary_continuation");
    expect(actual.receipt.residual.forcedContinuationBoundaryApplied).toBe(true);
    expect(actual.receipt.residual.continuationTurnOpened).toBe(true);
    expect(actual.receipt.residual.originalAgenticTurnStillOpen).toBe(false);
    expect(actual.receipt.residual.nextProviderRequestAllowed).toBe(false);
  });

  it("pending boundary with tool continuation refuses as invalid continuation state", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          continuation: {
            kind: "pending_correlated_tool_result",
            toolCallId: "call-1",
            correlationValid: true,
          },
        }),
      ),
    );
    expect(actual.receipt.refuseCode).toBe("invalid_pending_boundary_continuation");
  });

  it("skip with pending boundary preserves residual boundary truth", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          seam: {
            modelResponseComplete: true,
            requestedToolsSettled: true,
            captureFlushed: false,
            beforeNextProviderRequest: true,
            insideTransportRetry: false,
            inputEpochAtDecision: 0,
            inputEpochAtApply: 0,
          },
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          continuation: { kind: "active_non_tool" },
        }),
      ),
    );
    expect(actual.outcome).toBe("skip_seam");
    expect(actual.receipt.residual).toMatchObject({
      forcedContinuationBoundaryApplied: true,
      continuationTurnOpened: true,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: false,
      markerPersisted: false,
      markerServed: false,
    });
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
  });

  it("transport_retry skip does not authorize a fresh next request", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          seam: {
            modelResponseComplete: true,
            requestedToolsSettled: true,
            captureFlushed: true,
            beforeNextProviderRequest: true,
            insideTransportRetry: true,
            inputEpochAtDecision: 0,
            inputEpochAtApply: 0,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("skip_seam");
    expect(actual.receipt.skipCode).toBe("transport_retry");
    expect(actual.receipt.residual.nextProviderRequestAllowed).toBe(false);
  });

  it("writerClaim lhc is accepted and still records claim_writer (idempotent reassert)", () => {
    const boundary = {
      applied: true as const,
      continuationTurnId: "t2",
      forcedThisSeam: true,
      markerAlreadyPersisted: false,
    };
    const none = decideCompactContinuation(
      asCompactContinuationInput(baseInput({ forcedContinuationBoundary: boundary })),
    );
    const lhc = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: boundary,
          invariants: {
            captureComplete: true,
            providerIdentityValid: true,
            singleOpenTurn: true,
            writerClaim: "lhc",
          },
        }),
      ),
    );
    expect(lhc.outcome).toBe(none.outcome);
    expect(lhc.effects).toEqual(none.effects);
    expect(lhc.effects.some((e) => e.type === "claim_writer")).toBe(true);
  });

  it("rejects unknown fields on closed-shape input objects", () => {
    const bad = baseInput({ mystery: true });
    const v = validateCompactContinuationInput(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.message.includes("unknown field"))).toBe(true);

    const badUsage = baseInput({
      providerUsage: {
        available: false,
        reason: "missing",
        domain: "provider_reported_input",
        inputTokens: 1,
      },
    });
    const v2 = validateCompactContinuationInput(badUsage);
    expect(v2.ok).toBe(false);
  });

  it("install_failed continue-turn has marker persisted then release without install", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: true,
            markerAlreadyPersisted: false,
          },
          compactMaterial: {
            derivationsMissingOrFailed: false,
            lowerTargetMet: true,
            compactStructurallyValid: true,
            installSucceeds: false,
            usefulReduction: true,
            canProduceValidProviderRequest: true,
          },
        }),
      ),
    );
    const types = actual.effects.map((e) => e.type);
    expect(types.indexOf("compact")).toBeLessThan(types.indexOf("insert_continuation_marker"));
    expect(types).not.toContain("install_serving_view");
    expect(types).toContain("release_writer");
    expect(actual.receipt.residual.markerPersisted).toBe(true);
    expect(actual.receipt.residual.markerServed).toBe(false);
  });

  it("active_non_tool above trigger without applied boundary refuses invalid_pending", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          continuation: { kind: "active_non_tool" },
          forcedContinuationBoundary: { applied: false },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("invalid_pending_boundary_continuation");
    expect(actual.receipt.residual.forcedContinuationBoundaryApplied).toBe(false);
    expect(actual.effects.map((e) => e.type)).toEqual(["refuse", "record_receipt"]);
  });

  it("singleOpenTurn false refuses open_turn_invariant_broken", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          invariants: {
            captureComplete: true,
            providerIdentityValid: true,
            singleOpenTurn: false,
            writerClaim: "none",
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("open_turn_invariant_broken");
    expect(actual.receipt.residual.writerReleased).toBe(true);
  });

  it("repair after prior marker + compact failure reports residual markerPersisted", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t4",
            forcedThisSeam: false,
            markerAlreadyPersisted: true,
          },
          compactMaterial: {
            derivationsMissingOrFailed: false,
            lowerTargetMet: true,
            compactStructurallyValid: false,
            installSucceeds: true,
            usefulReduction: true,
            canProduceValidProviderRequest: true,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("compact_failed");
    expect(actual.effects.some((e) => e.type === "force_turn_end")).toBe(false);
    expect(actual.effects.some((e) => e.type === "insert_continuation_marker")).toBe(false);
    expect(actual.receipt.residual).toMatchObject({
      markerPersisted: true,
      markerServed: false,
      forcedContinuationBoundaryApplied: true,
      continuationTurnId: "t4",
      writerReleased: true,
      priorServingViewIntact: true,
      nextProviderRequestAllowed: false,
    });
  });

  it("writerClaim lhc + incomplete capture records claim then release", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          invariants: {
            captureComplete: false,
            providerIdentityValid: true,
            singleOpenTurn: true,
            writerClaim: "lhc",
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("incomplete_capture");
    expect(actual.receipt.residual.writerReleased).toBe(true);
    const types = actual.effects.map((e) => e.type);
    expect(types).toEqual(["claim_writer", "refuse", "record_receipt", "release_writer"]);
    expect(types.indexOf("claim_writer")).toBeLessThan(types.indexOf("release_writer"));
  });

  it("install_failed preserve-tool includes preserve_tool_pair_verbatim and keeps turn open", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          continuation: {
            kind: "pending_correlated_tool_result",
            toolCallId: "call-99",
            correlationValid: true,
          },
          compactMaterial: {
            derivationsMissingOrFailed: false,
            lowerTargetMet: true,
            compactStructurallyValid: true,
            installSucceeds: false,
            usefulReduction: true,
            canProduceValidProviderRequest: true,
          },
        }),
      ),
    );
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("install_failed");
    const types = actual.effects.map((e) => e.type);
    expect(types).toContain("preserve_tool_pair_verbatim");
    expect(types.indexOf("compact")).toBeLessThan(types.indexOf("preserve_tool_pair_verbatim"));
    expect(types.indexOf("preserve_tool_pair_verbatim")).toBeLessThan(types.indexOf("refuse"));
    expect(types).not.toContain("insert_continuation_marker");
    expect(types).not.toContain("install_serving_view");
    expect(actual.receipt.residual).toMatchObject({
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: true,
      priorServingViewIntact: true,
      writerReleased: true,
    });
    expect(actual.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "preserve_tool_pair_verbatim",
          toolCallId: "call-99",
          location: "open_turn_tail",
        }),
      ]),
    );
  });
});

describe("marker identity per forced boundary", () => {
  it("two different continuation turn ids produce different marker keys and effects", () => {
    const a = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: true,
            markerAlreadyPersisted: false,
          },
        }),
      ),
    );
    const b = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t5",
            forcedThisSeam: true,
            markerAlreadyPersisted: false,
          },
        }),
      ),
    );
    expect(a.outcome).toBe("compact_continue_turn");
    expect(b.outcome).toBe("compact_continue_turn");
    const keyA = a.effects.find((e) => e.type === "insert_continuation_marker");
    const keyB = b.effects.find((e) => e.type === "insert_continuation_marker");
    expect(keyA).toMatchObject({
      continuationTurnId: "t2",
      idempotencyKey: "lhc.compact_continuation:t2",
    });
    expect(keyB).toMatchObject({
      continuationTurnId: "t5",
      idempotencyKey: "lhc.compact_continuation:t5",
    });
    expect(keyA && "idempotencyKey" in keyA ? keyA.idempotencyKey : null).not.toBe(
      keyB && "idempotencyKey" in keyB ? keyB.idempotencyKey : null,
    );
    expect(a.receipt.residual.continuationTurnId).toBe("t2");
    expect(b.receipt.residual.continuationTurnId).toBe("t5");
  });

  it("same-boundary repair reasserts the same marker key without force_turn_end", () => {
    const repair = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t4",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
        }),
      ),
    );
    expect(repair.outcome).toBe("compact_continue_turn");
    expect(repair.effects.some((e) => e.type === "force_turn_end")).toBe(false);
    const marker = repair.effects.find((e) => e.type === "insert_continuation_marker");
    expect(marker).toMatchObject({
      continuationTurnId: "t4",
      idempotencyKey: compactContinuationMarkerIdempotencyKey("t4"),
      semantics: {
        cause: COMPACT_CONTINUATION_MARKER_CAUSE,
        action: COMPACT_CONTINUATION_MARKER_ACTION,
        newUserRequest: false,
        waitForUser: false,
      },
    });
  });

  it("applied boundary legality precedes native writer conflict", () => {
    const actual = decideCompactContinuation(
      asCompactContinuationInput(
        baseInput({
          continuation: { kind: "none" },
          forcedContinuationBoundary: {
            applied: true,
            continuationTurnId: "t2",
            forcedThisSeam: false,
            markerAlreadyPersisted: false,
          },
          invariants: {
            captureComplete: true,
            providerIdentityValid: true,
            singleOpenTurn: true,
            writerClaim: "native",
          },
        }),
      ),
    );
    expect(actual.receipt.refuseCode).toBe("invalid_pending_boundary_continuation");
    expect(actual.receipt.refuseCode).not.toBe("native_writer_conflict");
  });

  it("rejects applied boundary missing markerAlreadyPersisted", () => {
    const bad = baseInput({
      forcedContinuationBoundary: {
        applied: true,
        continuationTurnId: "t2",
        forcedThisSeam: true,
      },
    });
    const v = validateCompactContinuationInput(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.path.includes("markerAlreadyPersisted"))).toBe(true);
  });

  it("rejects fresh force + markerAlreadyPersisted (validate + total evaluator residual truth)", () => {
    const raw = baseInput({
      continuation: { kind: "active_non_tool" },
      forcedContinuationBoundary: {
        applied: true,
        continuationTurnId: "t2",
        forcedThisSeam: true,
        markerAlreadyPersisted: true,
      },
      // Also present so legality precedence over writer_claim is pinned.
      invariants: {
        captureComplete: true,
        providerIdentityValid: true,
        singleOpenTurn: true,
        writerClaim: "native",
      },
    });

    const v = validateCompactContinuationInput(raw);
    expect(v.ok).toBe(false);
    expect(
      v.issues.some(
        (i) =>
          i.path === "forcedContinuationBoundary" &&
          i.message.includes("forcedThisSeam true cannot pair with markerAlreadyPersisted true"),
      ),
    ).toBe(true);

    // Total evaluator refuses even for direct typed callers that skip as*.
    const actual = decideCompactContinuation(raw as ReturnType<typeof asCompactContinuationInput>);
    expect(actual.outcome).toBe("refuse");
    expect(actual.receipt.refuseCode).toBe("invalid_pending_boundary_continuation");
    expect(actual.receipt.refuseCode).not.toBe("native_writer_conflict");
    expect(actual.transitionPath).toEqual(["at_seam", "checking_invariants", "terminal_refuse"]);
    expect(actual.receipt.residual).toMatchObject({
      forcedContinuationBoundaryApplied: true,
      continuationTurnOpened: true,
      continuationTurnId: "t2",
      markerPersisted: false,
      markerServed: false,
      originalAgenticTurnStillOpen: false,
      nextProviderRequestAllowed: false,
      priorServingViewIntact: true,
      writerReleased: true,
    });
    expect(actual.receipt.continuation).toMatchObject({
      opened: true,
      markerServed: false,
      sameAgenticTurnPreserved: false,
    });
    expect(actual.receipt.turnEndReason).toBe(CONTEXT_COMPACT_CONTINUE_REASON);
    // Receipt/decision remain validator-clean even though input is illegal.
    expect(validateCompactContinuationDecision(actual).ok).toBe(true);
    expect(validateCompactContinuationReceipt(actual.receipt).ok).toBe(true);
  });
});
