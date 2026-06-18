// Epic 05 Story 5 — TC-4.1, TC-4.2, TC-4.3: the opt-in real-inference suite
// and the real-adapter lifecycle capstone (AC-4.1, AC-4.2, AC-1.2).
//
// The suite keys on OPENROUTER_API_KEY, resolved ONCE at module load by the
// suite-level guard from process.env plus ~/.lhc/.env: exactly one ran/not-ran line lands in run output, and
// the accounting tests below always run, so absence of the key can never
// produce a silent pass — unkeyed runs show one NOT-RAN line, a green
// accounting leg that asserted the not-ran record, and the keyed legs
// reported as skipped (never as passes). This is the CI-default posture:
// zero network calls. With the key present, the seven derivation kinds
// round-trip a real endpoint, the same seam-conformance helpers that ran
// against the fake host run against the real one unchanged (DD-13), and the
// Epic 04 lifecycle sequence completes under the real adapter with
// structural assertions: ready forms, non-marker content, real-model
// provenance, mutation regeneration, coherent checkpoints.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Derivation, HealthReport, MutationResult, OpResult } from "../src/index.js";
import {
  assertModelCallContract,
  assertRoutingThroughSdk,
  createOpenRouterCall,
  DEFAULT_OPENROUTER_MODEL,
  DELETED_MESSAGE_TEXT,
  DERIVATION_TYPES,
  EDITED_MESSAGE_TEXT,
  emitRealSuiteAccounting,
  INFERENCE_DERIVATION_TYPES,
  type InferenceDerivationType,
  type LifecycleRun,
  loadLocalLhcEnv,
  probeInput,
  type RoutingRunResult,
  readDerivedForms,
  realSuiteAccountingEmissions,
  resolveRealSuiteEnv,
  runLifecycle,
  type TempStore,
  tempStore,
  validAssignments,
} from "./fixtures/index.js";

// ── the suite-level guard: one resolution, one visible line ───────
const suiteEnv = resolveRealSuiteEnv({ ...loadLocalLhcEnv(), ...process.env });
const keyed = !("notRan" in suiteEnv);
const realKey = "notRan" in suiteEnv ? undefined : suiteEnv.key;
const realModel = "notRan" in suiteEnv ? DEFAULT_OPENROUTER_MODEL : suiteEnv.model;
emitRealSuiteAccounting(suiteEnv);

// Deterministic inference callback markers, two grains: the design's anchored
// derivation-content pattern, and a digest-bearing scan pattern for "appears
// anywhere" sweeps over served views and materialized files.
const MARKER_AT_START = /^(?:smoothed|toolcall|toolresult|rendering|projection|detailed|brief)\(/;
const MARKER_ANYWHERE = /(?:smoothed|toolcall|toolresult|rendering|projection|detailed|brief)\([0-9a-f]{8}:/;

function ok<T>(result: OpResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// All seven kinds assigned to the one real lane; prompt names stay the
// registry defaults validAssignments already wires.
function realAssignments(model: string): ReturnType<typeof validAssignments> {
  const overrides: Partial<Record<InferenceDerivationType, { provider: string; model: string }>> = {};
  for (const kind of INFERENCE_DERIVATION_TYPES) {
    overrides[kind] = { provider: "openrouter", model };
  }
  return validAssignments(overrides);
}

// ── TC-4.1: accounting — these tests run keyed or not ─────────────

describe("TC-4.1 / AC-4.1: ran/not-ran accounting is always visible", () => {
  it("the unkeyed guard returns a not-ran record with reason, never a pass-shaped record", () => {
    const record = resolveRealSuiteEnv({});
    expect("notRan" in record).toBe(true);
    if (!("notRan" in record)) throw new Error("unreachable");
    expect(record.notRan).toContain("OPENROUTER_API_KEY");
    // Distinguishable from a pass: the not-ran shape carries no key/model —
    // nothing downstream can construct a keyed run from it.
    expect("key" in record).toBe(false);
    expect("model" in record).toBe(false);
  });

  it("a whitespace-only key is unset, not a silent keyed run", () => {
    const record = resolveRealSuiteEnv({ OPENROUTER_API_KEY: "   " });
    expect("notRan" in record).toBe(true);
  });

  it("a keyed env resolves key and model, defaulting the model when unset", () => {
    const defaulted = resolveRealSuiteEnv({ OPENROUTER_API_KEY: "test-key" });
    expect(defaulted).toEqual({ key: "test-key", model: DEFAULT_OPENROUTER_MODEL });
    const explicit = resolveRealSuiteEnv({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "vendor/cheap-model",
    });
    expect(explicit).toEqual({ key: "test-key", model: "vendor/cheap-model" });
  });

  it("the suite-level guard emitted exactly one ran/not-ran line into run output", () => {
    const emissions = realSuiteAccountingEmissions();
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(
      keyed ? `RAN: real-inference (model ${realModel})` : "NOT-RAN: real-inference (OPENROUTER_API_KEY unset)",
    );
  });
});

// ── TC-4.1 / TC-4.3: keyed seven-kind round-trips + conformance ───

describe.runIf(keyed)("TC-4.1 / TC-4.3 (keyed): seven real round-trips through the shared seam helpers", () => {
  const call = realKey === undefined ? undefined : createOpenRouterCall(realKey, realModel);
  const assignments = realAssignments(realModel);
  let store: TempStore;
  let routing: RoutingRunResult;

  beforeAll(async () => {
    store = tempStore();
    if (call === undefined) throw new Error("keyed leg started without a key");
    // TC-4.3: the SAME routing helper Story 2's fake-host seam test runs,
    // unchanged, against the real host — it drives a real intake → drain
    // exercising all seven kinds and asserts routing, lane coverage, and
    // single-turn message shape internally.
    routing = await assertRoutingThroughSdk(call, assignments, store);
  }, 300_000);
  afterAll(() => {
    store.cleanup();
  });

  it("TC-4.3: the real host function passes the ModelCall contract on a real probe", async () => {
    if (call === undefined) throw new Error("keyed leg started without a key");
    await assertModelCallContract(call, probeInput({ provider: "openrouter", model: realModel }));
  }, 120_000);

  it("TC-4.1: each of the seven kinds round-tripped real inference to a ready form", () => {
    for (const kind of DERIVATION_TYPES) {
      const ready = routing.derivations.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const form of ready) {
        expect(form.content).toBeDefined();
        expect((form.content ?? "").trim()).not.toBe("");
        expect(form.content).not.toMatch(MARKER_AT_START);
        expect(form.content).not.toMatch(MARKER_ANYWHERE);
        if (INFERENCE_DERIVATION_TYPES.includes(form.derivationType as InferenceDerivationType)) {
          const kind = form.derivationType as InferenceDerivationType;
          // Provenance names the real lane from config, never model output.
          expect(form.metadata?.provenance).toEqual({
            provider: "openrouter",
            model: realModel,
            prompt: assignments[kind].prompt,
          });
        } else {
          expect(form.metadata?.provenance).toBeUndefined();
        }
      }
    }
  });
});

// ── TC-4.2: the real-adapter lifecycle capstone ───────────────────

describe.runIf(keyed)("TC-4.2 (keyed): Epic 04 lifecycle capstone under the real adapter", () => {
  let store: TempStore;
  let run: LifecycleRun;
  let preEditForms: Derivation[] = [];
  let finalForms: Derivation[] = [];

  beforeAll(async () => {
    store = tempStore();
    if ("notRan" in suiteEnv) throw new Error("keyed leg started without a key");
    const call = createOpenRouterCall(suiteEnv.key, realModel);
    // The Epic 04 sequence verbatim — intake, drain, compact, pull, inspect,
    // edit, rebuild, drain, compact, materialize — with the inference
    // adapter in the inference-callback slot (the one swap point).
    run = await runLifecycle(store, {
      name: "real-capstone",
      inference: { call, assignments: realAssignments(realModel) },
      onCheckpoint: (checkpoint, ctx) => {
        // Pre-mutation snapshot: the regeneration assertion compares each
        // mutation-cleared form's content before the edit and after rebuild.
        if (checkpoint === "inspect1") preEditForms = readDerivedForms(ctx.filePath);
        return Promise.resolve();
      },
    });
    finalForms = readDerivedForms(run.filePath);
  }, 1_800_000);
  afterAll(() => {
    store.cleanup();
  });

  it("every derivation kind lands ready at least once with non-empty content", () => {
    for (const kind of DERIVATION_TYPES) {
      const ready = finalForms.filter((form) => form.derivationType === kind && form.state === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const form of ready) {
        expect((form.content ?? "").trim()).not.toBe("");
      }
    }
  });

  it("no deterministic marker pattern appears anywhere — forms, served views, materialized file", () => {
    for (const form of finalForms) {
      if (form.content === undefined) continue;
      expect(form.content).not.toMatch(MARKER_AT_START);
      expect(form.content).not.toMatch(MARKER_ANYWHERE);
    }
    for (const pull of [ok(run.phases.pull1), ok(run.phases.pull2)]) {
      for (const message of pull.messages) {
        expect(message.content).not.toMatch(MARKER_ANYWHERE);
      }
    }
    expect(readFileSync(run.outPath, "utf8")).not.toMatch(MARKER_ANYWHERE);
  });

  it("provenance on every ready form names the real model", () => {
    for (const form of finalForms) {
      if (form.state !== "ready") continue;
      if (!INFERENCE_DERIVATION_TYPES.includes(form.derivationType as InferenceDerivationType)) {
        expect(form.metadata?.provenance).toBeUndefined();
        continue;
      }
      expect(form.metadata?.provenance?.provider).toBe("openrouter");
      expect(form.metadata?.provenance?.model).toBe(realModel);
    }
  });

  it("mutation-cleared forms went cleared-then-ready and regenerated with different content", () => {
    const cleared = [...ok(run.phases.mutate.edit).cleared, ...ok(run.phases.mutate.delete).cleared];
    expect(cleared.length).toBeGreaterThan(0);
    const find = (derivations: Derivation[], target: (typeof cleared)[number]): Derivation | undefined =>
      derivations.find(
        (form) =>
          form.subjectKind === target.subjectKind &&
          form.subjectId === target.subjectId &&
          form.derivationType === target.derivationType,
      );
    for (const target of cleared) {
      const before = find(preEditForms, target);
      const after = find(finalForms, target);
      // Cleared-then-ready: ready before the mutation (pre-edit snapshot),
      // pending in the mutate-phase health below, ready again after rebuild.
      expect(before?.state).toBe("ready");
      expect(after?.state).toBe("ready");
      expect(after?.content).toBeDefined();
      expect(after?.content).not.toBe(before?.content);
    }
  });

  it("health is coherent at each checkpoint: settled, cleared-set pending, settled again", () => {
    // Checkpoint 1 — post-drain status: derivation fully settled before the
    // first compact.
    const status = ok(run.phases.status);
    expect(status.derivation).toEqual({ pending: 0, retrying: 0, failed: 0, blocked: 0 });

    // Checkpoint 2 — immediately after the mutations: exactly the cleared
    // set is in flight, queued and unclaimed (cleared → pending around
    // mutations).
    const clearedCount = ok(run.phases.mutate.edit).cleared.length + ok(run.phases.mutate.delete).cleared.length;
    const healthAfterMutate = ok(run.phases.mutate.healthAfterMutate);
    const inFlight = healthAfterMutate.owners.reduce((sum, row) => sum + row.counts.pending + row.counts.retrying, 0);
    expect(inFlight).toBe(clearedCount);
    expect(healthAfterMutate.queue).toEqual({ queued: clearedCount, claimed: 0 });
    expect(healthAfterMutate.failures).toEqual([]);

    // Checkpoint 3 — post-rebuild: everything ready, nothing failed or
    // blocked, queue empty.
    const health2: HealthReport = ok(run.phases.health2);
    for (const row of health2.owners) {
      expect(row.counts.pending).toBe(0);
      expect(row.counts.retrying).toBe(0);
      expect(row.counts.failed).toBe(0);
      expect(row.counts.blocked).toBe(0);
      expect(row.counts.ready).toBeGreaterThan(0);
    }
    expect(health2.failures).toEqual([]);
    expect(health2.queue).toEqual({ queued: 0, claimed: 0 });
  });

  it("the second compact's view reflects post-edit content", () => {
    const pull2 = ok(run.phases.pull2);
    expect(
      pull2.messages.some(
        (message) => message.band === undefined && message.role === "user" && message.content === EDITED_MESSAGE_TEXT,
      ),
    ).toBe(true);
    expect(pull2.messages.some((m) => m.content.includes(DELETED_MESSAGE_TEXT))).toBe(false);
    expect(pull2.messages.some((m) => m.content === "turn 12: please investigate area 12")).toBe(false);
  });

  it("mutation results carried queued replacement work (the cleared set was re-derived, not left stale)", () => {
    const edit: MutationResult = ok(run.phases.mutate.edit);
    const deleted: MutationResult = ok(run.phases.mutate.delete);
    expect(edit.queued.length).toBeGreaterThan(0);
    expect(deleted.queued.length).toBeGreaterThan(0);
  });
});
