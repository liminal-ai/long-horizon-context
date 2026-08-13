/**
 * Generates LIM-60 compact-continuation parity fixtures from the pure decision function.
 * Usage (from packages/lhc): pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const mod = await import(join(pkgRoot, "src/shared-tech/compact-continuation/index.ts"));
const { COMPACT_CONTINUATION_CONTRACT_VERSION, decideCompactContinuation } = mod;

const V = COMPACT_CONTINUATION_CONTRACT_VERSION;
const baseDir = join(pkgRoot, "fixtures/compact-continuation/v1");

const basePolicy = {
  upperTriggerTokens: 100_000,
  lowerTargetTokens: 40_000,
  hostCapability: "full_state_machine",
};

const goodSeam = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
  insideTransportRetry: false,
  inputEpochAtDecision: 1,
  inputEpochAtApply: 1,
};

const goodInvariants = {
  captureComplete: true,
  providerIdentityValid: true,
  singleOpenTurn: true,
  writerClaim: "none",
};

const goodMaterial = {
  derivationsMissingOrFailed: false,
  lowerTargetMet: true,
  compactStructurallyValid: true,
  installSucceeds: true,
  usefulReduction: true,
  canProduceValidProviderRequest: true,
};

const providerAbove = {
  available: true,
  inputTokens: 90_000,
  cacheCreationTokens: 5_000,
  cacheReadTokens: 10_000,
  total: 105_000,
  domain: "provider_reported_input",
};

const providerBelow = {
  available: true,
  inputTokens: 70_000,
  cacheCreationTokens: 0,
  cacheReadTokens: 5_000,
  total: 75_000,
  domain: "provider_reported_input",
};

const est = (tokens = 0, source = "lhc_token_estimate") => ({
  tokens,
  source,
  domain: "source_labelled_estimate",
});

function makeInput(over = {}) {
  return {
    contractVersion: V,
    seam: { ...goodSeam, ...(over.seam || {}) },
    providerUsage: over.providerUsage ?? providerAbove,
    postMeasurementEstimate: over.postMeasurementEstimate ?? est(0),
    policy: { ...basePolicy, ...(over.policy || {}) },
    continuation: over.continuation ?? { kind: "active_non_tool" },
    invariants: { ...goodInvariants, ...(over.invariants || {}) },
    compactMaterial: { ...goodMaterial, ...(over.compactMaterial || {}) },
  };
}

const cases = [
  {
    name: "no_authoritative_provider_usage",
    coverage: ["no_authoritative_provider_usage"],
    description: "Missing provider usage never fabricates an upper trigger; continue normally.",
    input: makeInput({
      providerUsage: { available: false, reason: "missing", domain: "provider_reported_input" },
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "below_trigger",
    coverage: ["below_trigger"],
    description: "Provider base + estimate below upper trigger continues normally.",
    input: makeInput({
      providerUsage: providerBelow,
      postMeasurementEstimate: est(10_000),
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "normal_completion_below_pressure",
    coverage: ["normal_completion"],
    description: "Work complete below pressure: normal_complete, no empty continuation turn.",
    input: makeInput({
      providerUsage: providerBelow,
      postMeasurementEstimate: est(0),
      continuation: { kind: "none" },
    }),
  },
  {
    name: "normal_completion_above_pressure",
    coverage: ["normal_completion"],
    description: "Work complete above pressure still closes normally; no empty continuation turn.",
    input: makeInput({
      providerUsage: providerAbove,
      postMeasurementEstimate: est(5_000),
      continuation: { kind: "none" },
    }),
  },
  {
    name: "pending_tool_result_above_trigger",
    coverage: ["pending_tool_result_continuation"],
    description: "Above trigger with pending correlated tool result: keep turn open, preserve pair, no marker.",
    input: makeInput({
      providerUsage: providerAbove,
      postMeasurementEstimate: est(2_000),
      continuation: {
        kind: "pending_correlated_tool_result",
        toolCallId: "call-42",
        correlationValid: true,
      },
    }),
  },
  {
    name: "active_non_tool_above_trigger",
    coverage: ["active_non_tool_continuation"],
    description: "Above trigger active non-tool: force context_compact_continue, one continuation turn, marker.",
    input: makeInput({
      providerUsage: providerAbove,
      postMeasurementEstimate: est(1_000),
      continuation: { kind: "active_non_tool" },
    }),
  },
  {
    name: "derivation_gaps_degraded_compact",
    coverage: ["derivation_gaps_degraded"],
    description: "Missing/failed derivations degrade fidelity but do not block a valid compact.",
    input: makeInput({
      providerUsage: providerAbove,
      continuation: { kind: "active_non_tool" },
      compactMaterial: {
        ...goodMaterial,
        derivationsMissingOrFailed: true,
        lowerTargetMet: true,
      },
    }),
  },
  {
    name: "lower_target_missed_valid_request",
    coverage: ["lower_target_missed"],
    description: "Lower target missed is not a success gate; valid request still installs (degraded).",
    input: makeInput({
      providerUsage: providerAbove,
      continuation: { kind: "active_non_tool" },
      compactMaterial: {
        ...goodMaterial,
        lowerTargetMet: false,
        usefulReduction: true,
      },
    }),
  },
  {
    name: "incomplete_capture",
    coverage: ["incomplete_capture"],
    description: "Incomplete capture refuses; invariants cannot be proven.",
    input: makeInput({
      invariants: { ...goodInvariants, captureComplete: false },
    }),
  },
  {
    name: "invalid_tool_correlation",
    coverage: ["invalid_tool_correlation"],
    description: "Pending tool path with unproven correlation refuses.",
    input: makeInput({
      continuation: {
        kind: "pending_correlated_tool_result",
        toolCallId: "call-bad",
        correlationValid: false,
      },
    }),
  },
  {
    name: "invalid_provider_identity",
    coverage: ["invalid_provider_identity"],
    description: "Unproven provider identity refuses.",
    input: makeInput({
      invariants: { ...goodInvariants, providerIdentityValid: false },
    }),
  },
  {
    name: "compact_failed",
    coverage: ["compact_install_failure"],
    description: "Structurally invalid compact assembly refuses.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, compactStructurallyValid: false },
    }),
  },
  {
    name: "install_failed",
    coverage: ["compact_install_failure"],
    description: "Install failure after valid compact refuses.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, installSucceeds: false },
    }),
  },
  {
    name: "native_writer_conflict",
    coverage: ["native_writer_conflict"],
    description: "Native/conflict writer claim refuses silent mid-turn fallback.",
    input: makeInput({
      invariants: { ...goodInvariants, writerClaim: "conflict" },
    }),
  },
  {
    name: "input_epoch_changed",
    coverage: ["stale_epoch_or_transport_retry"],
    description: "Input epoch change between decision and apply skips the seam safely.",
    input: makeInput({
      seam: { ...goodSeam, inputEpochAtDecision: 1, inputEpochAtApply: 2 },
    }),
  },
  {
    name: "transport_retry_attempt",
    coverage: ["stale_epoch_or_transport_retry"],
    description: "Inside transport retry: skip; never mutate.",
    input: makeInput({
      seam: { ...goodSeam, insideTransportRetry: true },
    }),
  },
  {
    name: "no_useful_reduction",
    coverage: ["no_useful_reduction"],
    description: "No useful reduction without structural failure is a first-class non-error outcome.",
    input: makeInput({
      continuation: { kind: "active_non_tool" },
      compactMaterial: { ...goodMaterial, usefulReduction: false },
    }),
  },
  {
    name: "pressure_from_estimate_crosses_trigger",
    coverage: ["below_trigger", "active_non_tool_continuation"],
    description: "Provider base alone below trigger; labelled estimate pushes next-request pressure over.",
    input: makeInput({
      providerUsage: {
        available: true,
        inputTokens: 80_000,
        cacheCreationTokens: 10_000,
        cacheReadTokens: 5_000,
        total: 95_000,
        domain: "provider_reported_input",
      },
      postMeasurementEstimate: est(10_000, "host_byte_estimate"),
      continuation: { kind: "active_non_tool" },
    }),
  },
];

mkdirSync(join(baseDir, "cases"), { recursive: true });

const manifestCases = [];
for (const c of cases) {
  const expected = decideCompactContinuation(c.input);
  const body = {
    name: c.name,
    contractVersion: V,
    description: c.description,
    coverage: c.coverage,
    input: c.input,
    expected,
  };
  const file = `cases/${c.name}.json`;
  writeFileSync(join(baseDir, file), JSON.stringify(body, null, 2) + "\n");
  manifestCases.push({ file, name: c.name, coverage: c.coverage });
  console.log("wrote", file, "→", expected.outcome);
}

const requiredCoverage = [
  "no_authoritative_provider_usage",
  "below_trigger",
  "normal_completion",
  "pending_tool_result_continuation",
  "active_non_tool_continuation",
  "derivation_gaps_degraded",
  "lower_target_missed",
  "incomplete_capture",
  "invalid_tool_correlation",
  "invalid_provider_identity",
  "compact_install_failure",
  "native_writer_conflict",
  "stale_epoch_or_transport_retry",
  "no_useful_reduction",
];

const manifest = {
  contractVersion: V,
  contractId: "lhc.compact_continuation",
  description:
    "Table-driven parity fixtures for the compact-continuation state machine (LIM-60). TypeScript and Rust consumers must match expected decisions exactly.",
  cases: manifestCases,
  requiredCoverage,
};
writeFileSync(join(baseDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest:", manifestCases.length, "cases");
