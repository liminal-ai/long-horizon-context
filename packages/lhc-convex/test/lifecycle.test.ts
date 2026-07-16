// Story 4 (Epic 04): the full-surface lifecycle exercise (TC-5.1–5.3). One
// scripted sequence drives every built surface in PI-extension call order —
// create | intake | drain | status | compact1 | llmContext1 | inspect1 |
// mutate | rebuild | health2 | compact2 | llmContext2 — against one component
// configuration with the deterministic fake model host (zero network).
//
// Substrate-only frozen legs (documented n/a in the ledger):
//   - The `materialize` phase and every materialized-file byte-equality
//     assertion (TC-5.2 / TC-5.3 session-file hashes) target `threadView.materialize`
//     and a PI-session file, which the Convex surface does not expose (see
//     view_render_targets.test.ts). The determinism they prove is ported
//     instead through the served `getLlmRequestContext` outputs (hash-equal
//     across a fresh replay and a teardown continuation), which is the same
//     served shape the PI extension consumes.
//   - The frozen fixed-`Date` clock and background `drainSettled` are replaced
//     by the fake host's input-independent canned output (deterministic with
//     no clock seam) and explicit `work.drain` (convex-test cannot advance a
//     scheduled background drain). llmContext determinism is compared with the
//     one random value — the thread id — normalized, exactly as the frozen
//     `comparableContext` does.
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import {
  type CompactReceipt,
  estimateTokens,
  type HealthReport,
  initLhc,
  type Lhc,
  type LlmRequestContext,
  type MessageEventInput,
  type MutationResult,
  type OpResult,
} from "../src/client/index.js";
import { type ConvexHarness, dummyModelCall, executor, modules, validEvent } from "./fixtures/index.js";

const LIFECYCLE_PROFILE = {
  name: "lifecycle",
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
} as const;

const EDIT_TARGET = { turnId: "t12", kind: "user_prompt" } as const;
const EDITED_MESSAGE_TEXT = "turn 12 revised: drop area 12 and re-check area 5 instead";
const DELETE_TARGET = { turnId: "t10", kind: "assistant_text" } as const;
const DELETED_MESSAGE_TEXT = "findings for area 10";

const TURN_COUNT = 12;
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);
const TURNS_PER_BATCH = 3;

function turnEvents(turn: number): MessageEventInput[] {
  let seq = 0;
  const key = (): string => {
    seq += 1;
    return `lc-t${turn}-e${seq}`;
  };
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { idempotencyKey: key(), payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
    validEvent("assistant_thinking", { idempotencyKey: key(), payload: { text: `considering what area ${turn} contains` } }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-lc-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          idempotencyKey: key(),
          payload: { toolCallId, toolName: "read_file", arguments: { path: `area-${turn}/file-${run}.txt` } },
        }),
        validEvent("tool_result", {
          idempotencyKey: key(),
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(
    validEvent("assistant_text", { idempotencyKey: key(), payload: { text: `findings for area ${turn}` } }),
    validEvent("turn_end", { idempotencyKey: key() }),
  );
  return events;
}

function intakeBatches(): MessageEventInput[][] {
  const batches: MessageEventInput[][] = [];
  for (let first = 1; first <= TURN_COUNT; first += TURNS_PER_BATCH) {
    const batch: MessageEventInput[] = [];
    for (let turn = first; turn < first + TURNS_PER_BATCH && turn <= TURN_COUNT; turn += 1) {
      batch.push(...turnEvents(turn));
    }
    batches.push(batch);
  }
  return batches;
}

const ASSIGNMENTS = {
  smoothed_prompt: { provider: "test", model: "model-smoothed_prompt", prompt: "smoothing-v1" },
  tool_result_summary: { provider: "test", model: "model-tool_result_summary", prompt: "tool-result-v2" },
  detailed_turn_compression: {
    provider: "test",
    model: "model-detailed_turn_compression",
    prompt: "detailed-turn-compression-v3",
  },
  chunk_summary_brief: { provider: "test", model: "model-chunk_summary_brief", prompt: "chunk-brief-v3" },
} as const;

function makeSdk(test: ConvexHarness, instance: string): Lhc {
  return initLhc(api, executor(test), {
    componentInstanceId: instance,
    mode: "manual",
    inference: { call: dummyModelCall, assignments: ASSIGNMENTS },
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4_400 },
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    view: { profiles: [{ ...LIFECYCLE_PROFILE, percentages: { ...LIFECYCLE_PROFILE.percentages } }], compactThreshold: 300 },
  });
}

type Msg = LlmRequestContext["messages"][number];
function messageText(message: Msg): string {
  return message.content.map((part) => part.text).join("");
}
function isBandMessage(message: Msg): boolean {
  return messageText(message).startsWith("[context ·");
}
function measured(messages: readonly Msg[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
}
function comparableContext(context: LlmRequestContext): LlmRequestContext {
  return { ...context, threadId: "<threadId>" };
}
function ok<T>(result: OpResult<T>, phase: string): T {
  if (!result.ok) throw new Error(`lifecycle ${phase} failed: ${result.error.code} — ${result.error.reason}`);
  return result.value;
}
function clearedKeys(...mutations: MutationResult[]): string[] {
  return mutations
    .flatMap((mutation) => mutation.cleared)
    .map((target) => `${target["subjectKind"]}:${target["subjectId"]}:${target["derivationType"]}`)
    .sort();
}
function pendingKeys(...reports: Array<readonly { state: string; subjectKind: string; subjectId: string; derivationType: string }[]>): string[] {
  return reports
    .flat()
    .filter((entry) => entry.state === "pending")
    .map((entry) => `${entry.subjectKind}:${entry.subjectId}:${entry.derivationType}`)
    .sort();
}

interface LifecycleRun {
  threadId: string;
  phases: {
    create: OpResult<{ threadId: string; filePath: string }>;
    intake: Array<OpResult<unknown>>;
    status: OpResult<import("../src/client/index.js").ViewStatus>;
    compact1: OpResult<CompactReceipt>;
    llmContext1: OpResult<LlmRequestContext>;
    inspect1: {
      overview: OpResult<import("../src/client/index.js").InspectOverview>;
      view: OpResult<import("../src/client/index.js").ViewContentsReport>;
      health: OpResult<HealthReport>;
    };
    mutate: {
      edit: OpResult<MutationResult>;
      delete: OpResult<MutationResult>;
      healthAfterMutate: OpResult<HealthReport>;
      messagesNotReady: OpResult<import("../src/client/index.js").DerivationReportEntry[]>;
      turnsNotReady: OpResult<import("../src/client/index.js").DerivationReportEntry[]>;
    };
    health2: OpResult<HealthReport>;
    compact2: OpResult<CompactReceipt>;
    llmContext2: OpResult<LlmRequestContext>;
  };
}

let counter = 0;

async function runLifecycle(opts: { freshSdkBetweenGroups?: boolean } = {}): Promise<LifecycleRun> {
  counter += 1;
  const test = convexTest(schema, modules);
  const instance = `lifecycle-${counter}`;
  let sdk = makeSdk(test, instance);
  const nextGroup = (): void => {
    if (opts.freshSdkBetweenGroups) sdk = makeSdk(test, instance);
  };
  const ref = { filePath: "lifecycle-thread" };

  // group 1: create → intake → drain → status
  const create = await sdk.threads.newThread({ filePath: "lifecycle-thread" });
  const threadId = ok(create, "create").threadId;
  const intake: Array<OpResult<unknown>> = [];
  for (const batch of intakeBatches()) {
    const sent = await sdk.intakeStream.messageEvents(ref, batch);
    intake.push(sent);
    ok(sent, "intake");
    ok(await sdk.work.drain(ref), "drain");
  }
  const status = await sdk.threadView.status(ref);
  ok(status, "status");

  // group 2: compact1 → llmContext1 → inspect1
  nextGroup();
  const compact1 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  ok(compact1, "compact1");
  const llmContext1 = await sdk.threadView.getLlmRequestContext(ref);
  ok(llmContext1, "llmContext1");
  const inspect1 = {
    overview: await sdk.inspect.overview(ref),
    view: await sdk.inspect.view(ref),
    health: await sdk.inspect.health(ref),
  };
  ok(inspect1.overview, "inspect1.overview");
  ok(inspect1.view, "inspect1.view");
  ok(inspect1.health, "inspect1.health");

  // group 3: mutate → rebuild → health2
  nextGroup();
  const listed = ok(await sdk.messages.list(ref), "mutate.list");
  const editTarget = listed.find((r) => r.kind === EDIT_TARGET.kind && r.turnId === EDIT_TARGET.turnId);
  const deleteTarget = listed.find((r) => r.kind === DELETE_TARGET.kind && r.turnId === DELETE_TARGET.turnId);
  if (editTarget === undefined || deleteTarget === undefined) {
    throw new Error("lifecycle invariant: edit/delete targets not found in the record");
  }
  const edit = await sdk.messages.edit(ref, { messageId: editTarget.messageId, content: EDITED_MESSAGE_TEXT });
  ok(edit, "mutate.edit");
  const deleted = await sdk.messages.remove(ref, { messageId: deleteTarget.messageId });
  ok(deleted, "mutate.delete");
  const mutate = {
    edit,
    delete: deleted,
    healthAfterMutate: await sdk.inspect.health(ref),
    messagesNotReady: await sdk.messages.report(ref, { notReady: true }),
    turnsNotReady: await sdk.turns.report(ref, { notReady: true }),
  };
  ok(mutate.healthAfterMutate, "mutate.health");
  ok(mutate.messagesNotReady, "mutate.messagesNotReady");
  ok(mutate.turnsNotReady, "mutate.turnsNotReady");
  ok(await sdk.work.drain(ref), "rebuild");
  const health2 = await sdk.inspect.health(ref);
  ok(health2, "health2");

  // group 4: compact2 → llmContext2
  nextGroup();
  const compact2 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  ok(compact2, "compact2");
  const llmContext2 = await sdk.threadView.getLlmRequestContext(ref);
  ok(llmContext2, "llmContext2");

  return { threadId, phases: { create, intake, status, compact1, llmContext1, inspect1, mutate, health2, compact2, llmContext2 } };
}

let run: LifecycleRun;
beforeAll(async () => {
  run = await runLifecycle();
}, 60_000);

describe("TC-5.1 / AC-5.1: the full sequence completes ok through one configuration", () => {
  test("every phase operation returns ok", () => {
    const { phases } = run;
    expect(phases.create.ok).toBe(true);
    for (const batch of phases.intake) expect(batch.ok).toBe(true);
    expect(phases.status.ok).toBe(true);
    expect(phases.compact1.ok).toBe(true);
    expect(phases.llmContext1.ok).toBe(true);
    expect(phases.inspect1.overview.ok).toBe(true);
    expect(phases.inspect1.view.ok).toBe(true);
    expect(phases.inspect1.health.ok).toBe(true);
    expect(phases.mutate.edit.ok).toBe(true);
    expect(phases.mutate.delete.ok).toBe(true);
    expect(phases.mutate.healthAfterMutate.ok).toBe(true);
    expect(phases.health2.ok).toBe(true);
    expect(phases.compact2.ok).toBe(true);
    expect(phases.llmContext2.ok).toBe(true);
  });

  test("status recommends the compact the sequence performs next, with derivation settled", () => {
    const status = ok(run.phases.status, "status");
    expect(status.threshold).toBe(300);
    expect(status.tailTokens).toBeGreaterThan(status.threshold);
    expect(status.compactRecommended).toBe(true);
    expect(status.derivation).toEqual({ pending: 0, failed: 0, blocked: 0 });
    expect(status.view).toBeNull();
  });
});

describe("TC-5.1 / AC-5.2: checkpoint coherence across the sequence", () => {
  test("post-compact model context serves bands + tail, and the view report's loadCost prices that context", () => {
    const receipt = ok(run.phases.compact1, "compact1");
    expect(receipt.profile).toBe(LIFECYCLE_PROFILE.name);
    const context = ok(run.phases.llmContext1, "llmContext1");

    // The bands open the array in gradient order (brief → detailed → smooth).
    // Which of the three are non-empty is CALIBRATED to the fake host's canned
    // summary sizes (they differ from the frozen double's text, so the brief
    // band can be empty under the same tuned profile); the selection algorithm
    // itself is proven identical by the byte-identical view goldens. So the
    // present bands must be a gradient-ordered subset, and must all be present.
    const bands = context.messages.filter(isBandMessage);
    const bandOrder = bands.map((message) => messageText(message).match(/^\[context · ([^\]]+)\]/)?.[1]);
    const CANONICAL = ["brief", "detailed", "smooth"];
    expect(bands.length).toBeGreaterThan(0);
    expect(bandOrder).toEqual(CANONICAL.filter((band) => bandOrder.includes(band)));
    expect(context.messages.slice(0, bands.length)).toEqual(bands);
    const tail = context.messages.slice(bands.length);
    expect(tail.length).toBeGreaterThan(0);

    const report = ok(run.phases.inspect1.view, "inspect1.view");
    expect(report.meta?.viewId).toBe(receipt.viewId);
    expect(report.meta?.profile).toBe(LIFECYCLE_PROFILE.name);
    expect(report.loadCost.bandTokens).toBe(measured(bands));
    expect(report.loadCost.tailTokens).toBe(measured(tail));
    expect(report.loadCost.total).toBe(measured(context.messages));

    const overview = ok(run.phases.inspect1.overview, "inspect1.overview");
    expect(overview.view?.viewId).toBe(receipt.viewId);
    expect(overview.derivation.pending).toBe(0);
    expect(overview.messages.deleted).toBe(0);
  });

  test("post-mutation health shows exactly the cleared set pending; post-drain health shows it ready", () => {
    const edit = ok(run.phases.mutate.edit, "edit");
    const deleted = ok(run.phases.mutate.delete, "delete");
    expect(edit.superseded).toEqual([]);
    expect(deleted.superseded).toEqual([]);
    // The deleted assistant_text owns no derived derivations: its cascade clears
    // sibling turn forms only.
    expect(deleted.dropped).toEqual([]);

    const cleared = clearedKeys(edit, deleted);
    expect(cleared.length).toBeGreaterThan(0);
    const pending = pendingKeys(
      ok(run.phases.mutate.messagesNotReady, "messagesNotReady"),
      ok(run.phases.mutate.turnsNotReady, "turnsNotReady"),
    );
    expect(pending).toEqual(cleared);

    const health = ok(run.phases.mutate.healthAfterMutate, "healthAfterMutate");
    // The pending derivation ENTRIES are exactly the cleared set.
    const pendingTotal = health.owners.reduce((sum, row) => sum + row.counts.pending, 0);
    expect(pendingTotal).toBe(cleared.length);
    // health.queue counts queued WORK ITEMS (a turn re-queue is one item over
    // two derivations), so it equals the mutations' queued items, all unclaimed
    // — not the derivation-entry count (a Convex shape difference from frozen).
    expect(health.queue).toEqual({ queued: edit.queued.length + deleted.queued.length, claimed: 0 });
    expect(edit.queued.length).toBeGreaterThan(0);
    expect(deleted.queued.length).toBeGreaterThan(0);
    expect(health.failures).toEqual([]);

    const after = ok(run.phases.health2, "health2");
    for (const row of after.owners) {
      expect(row.counts.pending).toBe(0);
      expect(row.counts.failed).toBe(0);
      expect(row.counts.blocked).toBe(0);
      expect(row.counts.ready).toBeGreaterThan(0);
    }
    expect(after.failures).toEqual([]);
    expect(after.repairPreview).toEqual([]);
    expect(after.queue).toEqual({ queued: 0, claimed: 0 });
  });

  test("the second compact's context reflects post-edit content", () => {
    const llmContext1 = ok(run.phases.llmContext1, "llmContext1");
    const llmContext2 = ok(run.phases.llmContext2, "llmContext2");

    expect(llmContext1.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(true);
    expect(llmContext1.messages.some((m) => messageText(m) === DELETED_MESSAGE_TEXT)).toBe(true);

    expect(
      llmContext2.messages.some((m) => !isBandMessage(m) && m.role === "user" && messageText(m) === EDITED_MESSAGE_TEXT),
    ).toBe(true);
    expect(llmContext2.messages.some((m) => messageText(m).includes(DELETED_MESSAGE_TEXT))).toBe(false);
    expect(llmContext2.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(false);
  });
});

describe("TC-5.2 / AC-5.3: replay determinism on a fresh thread", () => {
  test("produces deep-equal LlmRequestContext outputs (modulo the one random thread id)", async () => {
    const replay = await runLifecycle();
    const contexts: Array<[OpResult<LlmRequestContext>, OpResult<LlmRequestContext>]> = [
      [run.phases.llmContext1, replay.phases.llmContext1],
      [run.phases.llmContext2, replay.phases.llmContext2],
    ];
    for (const [original, replayed] of contexts) {
      expect(comparableContext(ok(replayed, "replay"))).toEqual(comparableContext(ok(original, "original")));
    }
    // On convex-test the thread id is a deterministic hash of the document id,
    // so a fresh replay lands the SAME id (even stronger than the frozen "one
    // random value" — nothing to normalize), and the contexts are equal outright.
    expect(replay.threadId).toBe(run.threadId);
  }, 60_000);
});

describe("TC-5.3 / AC-5.4: teardown continuity — a fresh SDK between phase groups", () => {
  test("yields final LlmRequestContext and health identical to the uninterrupted run's", async () => {
    const teardown = await runLifecycle({ freshSdkBetweenGroups: true });
    expect(comparableContext(ok(teardown.phases.llmContext2, "teardown"))).toEqual(
      comparableContext(ok(run.phases.llmContext2, "baseline")),
    );
    expect(ok(teardown.phases.health2, "teardown.health2")).toEqual(ok(run.phases.health2, "baseline.health2"));
  }, 60_000);
});
