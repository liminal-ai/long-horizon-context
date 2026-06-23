// Epic 05 Story 5 — TC-4.1, TC-4.2, TC-4.3: the opt-in real-inference suite
// and the real-adapter lifecycle capstone (AC-4.1, AC-4.2, AC-1.2).
// Epic 07 adds focused real-inference seam checks for the smoothed-prompt
// guard and tool-result classifier paths.
//
// The suite keys on OPENROUTER_API_KEY, resolved ONCE at module load by the
// suite-level guard from process.env plus ~/.lhc/.env: exactly one ran/not-ran line lands in run output, and
// the accounting tests below always run, so absence of the key can never
// produce a silent pass — unkeyed runs show one NOT-RAN line, a green
// accounting leg that asserted the not-ran record, and the keyed legs
// reported as skipped (never as passes). This is the CI-default posture:
// zero network calls. With the key present, the six derivation kinds
// round-trip a real endpoint, the same seam-conformance helpers that ran
// against the fake host run against the real one unchanged (DD-13), and the
// Epic 04 lifecycle sequence completes under the real adapter with
// structural assertions: ready forms, non-marker content, real-model
// provenance, mutation regeneration, coherent checkpoints.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Derivation,
  HealthReport,
  Lhc,
  LlmRequestContextMessage,
  ModelCall,
  ModelCallInput,
  ModelCallResult,
  MutationResult,
  OpResult,
} from "../src/index.js";
import { estimateTokens, initLhc } from "../src/index.js";
import { truncateForFallback } from "../src/shared-tech/index.js";
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
  validEvent,
} from "./fixtures/index.js";

// ── the suite-level guard: one resolution, one visible line ───────
const integrationEnabled = process.env.LHC_RUN_INTEGRATION === "1";
const suiteEnv = integrationEnabled
  ? resolveRealSuiteEnv({ ...loadLocalLhcEnv(), ...process.env })
  : { notRan: "LHC_RUN_INTEGRATION unset" };
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

function messageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

// All inference-backed kinds assigned to the one real lane; prompt names stay
// the registry defaults validAssignments already wires.
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
      keyed
        ? `RAN: real-inference (model ${realModel})`
        : integrationEnabled
          ? "NOT-RAN: real-inference (OPENROUTER_API_KEY unset)"
          : "NOT-RAN: real-inference (LHC_RUN_INTEGRATION unset)",
    );
  });
});

// ── TC-4.1 / TC-4.3: keyed seven-kind round-trips + conformance ───

describe.runIf(keyed)("TC-4.1 / TC-4.3 (keyed): six real derivation kinds through the shared seam helpers", () => {
  const call = realKey === undefined ? undefined : createOpenRouterCall(realKey, realModel);
  const assignments = realAssignments(realModel);
  let store: TempStore;
  let routing: RoutingRunResult;

  beforeAll(async () => {
    store = tempStore();
    if (call === undefined) throw new Error("keyed leg started without a key");
    // TC-4.3: the SAME routing helper Story 2's fake-host seam test runs,
    // unchanged, against the real host — it drives a real intake → drain
    // exercising all six derivation kinds and asserts routing, lane coverage, and
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

  it("TC-4.1: each of the six derivation kinds lands ready with real adapter content", () => {
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
          if (kind === "chunk_summary_brief") {
            expect(form.metadata?.provenance?.prompt).toBe("chunk-brief-v2");
            expect(form.metadata?.sizeDisposition).toBeDefined();
          }
        } else {
          expect(form.metadata?.provenance).toBeUndefined();
        }
      }
    }
  });
});

// ── Epic 07: focused real-inference seam checks ───────────────────

function tokenText(minTokens: number, word = "guardword"): string {
  let text = "";
  while (estimateTokens(text) < minTokens) text += `${word} `;
  return text.trim();
}

function recordRealCall(call: ModelCall): { call: ModelCall; log: ModelCallInput[] } {
  const log: ModelCallInput[] = [];
  return {
    log,
    call: async (input): Promise<ModelCallResult> => {
      log.push(structuredClone(input));
      return call(input);
    },
  };
}

async function newRealThread(sdk: Lhc, store: TempStore, name: string): Promise<string> {
  const created = await sdk.threads.newThread({ filePath: store.threadPath(name), registryPath: store.registryPath });
  return ok(created).filePath;
}

async function drainRealWork(sdk: Lhc, filePath: string): Promise<void> {
  const drained = ok(await sdk.work.drain({ filePath }));
  expect(drained.stoppedBecause).toBe("empty");
  expect(drained.remaining).toBe(0);
}

function findDerivation(filePath: string, subjectId: string, derivationType: string): Derivation {
  const derivation = readDerivedForms(filePath).find(
    (form) => form.subjectId === subjectId && form.derivationType === derivationType,
  );
  if (derivation === undefined) throw new Error(`missing ${derivationType} for ${subjectId}`);
  return derivation;
}

function renderedPrompt(input: ModelCallInput): string {
  return input.messages.map((message) => message.content).join("\n---\n");
}

describe.runIf(keyed)("Epic 07 (keyed): real-inference guard and classifier seams", () => {
  let store: TempStore;

  beforeAll(() => {
    store = tempStore();
  });
  afterAll(() => {
    store.cleanup();
  });

  it("smoothed-prompt guard skips over-cap real calls while under-cap prompts still reach the model", async () => {
    if (realKey === undefined) throw new Error("keyed leg started without a key");
    const recorded = recordRealCall(createOpenRouterCall(realKey, realModel));
    const sdk = initLhc({
      inference: { call: recorded.call, assignments: realAssignments(realModel) },
      mode: "manual",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });

    const overCapPrompt = tokenText(760, "overcap");
    const overCapPath = await newRealThread(sdk, store, "real-smoothing-overcap");
    ok(
      await sdk.intakeStream.messageEvents({ filePath: overCapPath }, [
        validEvent("user_prompt", { payload: { text: overCapPrompt } }),
      ]),
    );
    await drainRealWork(sdk, overCapPath);

    const overCap = findDerivation(overCapPath, "m1", "smoothed_prompt");
    expect(overCap.state).toBe("ready");
    expect(overCap.content).toBe(sdk.messages.cleanPrompt(overCapPrompt));
    expect(overCap.metadata?.provenance).toBeUndefined();
    expect(recorded.log).toHaveLength(0);

    const underCapPrompt = [
      "plz plz plz clean this rough request but keep the path packages/lhc/src/messages/index.ts",
      "I need the model to preserve command pnpm run verify and the number 42 while removing repetition.",
      "Also keep identifier tool_result_summary exactly as written.",
    ].join(" ");
    expect(estimateTokens(sdk.messages.cleanPrompt(underCapPrompt))).toBeLessThan(700);
    const underCapPath = await newRealThread(sdk, store, "real-smoothing-undercap");
    ok(
      await sdk.intakeStream.messageEvents({ filePath: underCapPath }, [
        validEvent("user_prompt", { payload: { text: underCapPrompt } }),
      ]),
    );
    await drainRealWork(sdk, underCapPath);

    expect(recorded.log).toHaveLength(1);
    const underCap = findDerivation(underCapPath, "m1", "smoothed_prompt");
    expect(underCap.state).toBe("ready");
    expect((underCap.content ?? "").trim()).not.toBe("");
    expect(underCap.content).not.toBe(sdk.messages.cleanPrompt(underCapPrompt));
    expect(underCap.metadata?.provenance).toEqual({
      provider: "openrouter",
      model: realModel,
      prompt: assignmentsForKind("smoothed_prompt").prompt,
    });
  }, 300_000);

  it("tool-result classification reaches the real adapter for bash failures and formerly-large outputs", async () => {
    if (realKey === undefined) throw new Error("keyed leg started without a key");
    const recorded = recordRealCall(createOpenRouterCall(realKey, realModel));
    const sdk = initLhc({
      inference: { call: recorded.call, assignments: realAssignments(realModel), maxInputChars: 3000 },
      mode: "manual",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });
    const filePath = await newRealThread(sdk, store, "real-tool-result-classifier");
    const bashFailure = [
      "zsh: frobnicate: command not found",
      "Command exited with code 127",
      tokenText(1200, "failure-context"),
    ].join("\n");
    const largeHead = "HEAD_UNIQUE_STORY2_REAL_INFERENCE ".repeat(60);
    const largeMiddle = "MIDDLE_UNIQUE_SHOULD_BE_BOUND_OUT ".repeat(2500);
    const largeTail = "TAIL_UNIQUE_STORY2_REAL_INFERENCE ".repeat(60);
    const largeOutput = `${largeHead}\n${largeMiddle}\n${largeTail}`;
    expect(estimateTokens(largeOutput)).toBeGreaterThan(5000);

    ok(
      await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("tool_call", {
          payload: { toolCallId: "missing-command", toolName: "bash", arguments: { command: "frobnicate --version" } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: "missing-command", content: bashFailure, isError: true },
        }),
        validEvent("tool_call", {
          payload: { toolCallId: "large-output", toolName: "bash", arguments: { command: "pnpm run verify" } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: "large-output", content: largeOutput, isError: false },
        }),
      ]),
    );
    await drainRealWork(sdk, filePath);

    expect(recorded.log).toHaveLength(2);
    const failurePrompt = renderedPrompt(recorded.log[0]!);
    expect(failurePrompt).toContain('"exitCode": 127');
    expect(failurePrompt).toContain('"failureType": "command_not_found"');
    expect(failurePrompt).toContain('"missingCommand": "frobnicate"');
    for (const forbidden of ["operationClass", "responseShape", "outputChars", "outputWords"]) {
      expect(failurePrompt).not.toContain(forbidden);
    }

    const largePrompt = renderedPrompt(recorded.log[1]!);
    expect(largePrompt).toContain("HEAD_UNIQUE_STORY2_REAL_INFERENCE");
    expect(largePrompt).toContain("TAIL_UNIQUE_STORY2_REAL_INFERENCE");
    expect(largePrompt).toContain("[... truncated: tool result was");
    expect(largePrompt).not.toContain("MIDDLE_UNIQUE_SHOULD_BE_BOUND_OUT");

    const failureSummary = findDerivation(filePath, "m2", "tool_result_summary");
    expect(failureSummary.state).toBe("ready");
    expect((failureSummary.content ?? "").trim()).not.toBe("");
    expect(failureSummary.metadata?.provenance).toEqual({
      provider: "openrouter",
      model: realModel,
      prompt: assignmentsForKind("tool_result_summary").prompt,
    });

    const largeSummary = findDerivation(filePath, "m4", "tool_result_summary");
    expect(largeSummary.state).toBe("ready");
    expect((largeSummary.content ?? "").trim()).not.toBe("");
    expect(largeSummary.content).not.toBe(truncateForFallback(largeOutput));
    expect(largeSummary.metadata?.provenance).toEqual({
      provider: "openrouter",
      model: realModel,
      prompt: assignmentsForKind("tool_result_summary").prompt,
    });
  }, 300_000);
});

function assignmentsForKind(kind: InferenceDerivationType) {
  return realAssignments(realModel)[kind];
}

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
    // The Epic 04 sequence verbatim — intake, drain, compact, model context, inspect,
    // edit, rebuild, drain, compact, materialize — with the inference
    // adapter in the inference-callback slot (the one swap point).
    run = await runLifecycle(store, {
      name: "real-capstone",
      inference: { call, assignments: realAssignments(realModel) },
      guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
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
    for (const context of [ok(run.phases.llmContext1), ok(run.phases.llmContext2)]) {
      for (const message of context.messages) {
        expect(messageText(message)).not.toMatch(MARKER_ANYWHERE);
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
    const llmContext2 = ok(run.phases.llmContext2);
    expect(
      llmContext2.messages.some(
        (message) =>
          !messageText(message).startsWith("[context ·") &&
          message.role === "user" &&
          messageText(message) === EDITED_MESSAGE_TEXT,
      ),
    ).toBe(true);
    expect(llmContext2.messages.some((m) => messageText(m).includes(DELETED_MESSAGE_TEXT))).toBe(false);
    expect(llmContext2.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(false);
  });

  it("mutation results carried queued replacement work (the cleared set was re-derived, not left stale)", () => {
    const edit: MutationResult = ok(run.phases.mutate.edit);
    const deleted: MutationResult = ok(run.phases.mutate.delete);
    expect(edit.queued.length).toBeGreaterThan(0);
    expect(deleted.queued.length).toBeGreaterThan(0);
  });
});
