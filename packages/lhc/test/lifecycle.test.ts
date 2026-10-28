import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DerivationReportEntry,
  LlmRequestContext,
  LlmRequestContextMessage,
  MutationResult,
  OpResult,
} from "../src/index.js";
import {
  DELETED_MESSAGE_TEXT,
  EDITED_MESSAGE_TEXT,
  LIFECYCLE_PROFILE,
  type LifecycleRun,
  runLifecycle,
  type TempStore,
  tempStore,
} from "./fixtures/index.js";
import { estimateTokens } from "./fixtures/tokens.js";

let store: TempStore;
let run: LifecycleRun;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
  store = tempStore();
  run = await runLifecycle(store, { name: "baseline" });
}, 60000);
afterAll(() => {
  vi.useRealTimers();
  store.cleanup();
});

function ok<T>(result: OpResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

function isBandMessage(message: LlmRequestContextMessage): boolean {
  return messageText(message).startsWith("[context ·");
}

function measured(messages: readonly LlmRequestContextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
}

function comparableContext(context: LlmRequestContext): LlmRequestContext {
  return { ...context, threadId: "<threadId>" };
}

function clearedKeys(...mutations: MutationResult[]): string[] {
  return mutations
    .flatMap((mutation) => mutation.cleared)
    .map((target) => `${target.subjectKind}:${target.subjectId}:${target.derivationType}`)
    .sort();
}

function pendingKeys(...reports: Array<readonly DerivationReportEntry[]>): string[] {
  return reports
    .flat()
    .filter((entry) => entry.state === "pending")
    .map((entry) => `${entry.subjectKind}:${entry.subjectId}:${entry.derivationType}`)
    .sort();
}

function comparableSessionFile(lifecycleRun: LifecycleRun): string {
  return readFileSync(lifecycleRun.outPath, "utf8").replaceAll(lifecycleRun.threadId, "<thread-id>");
}

describe("TC-5.1 / AC-5.1: the full sequence completes ok through one SDK configuration", () => {
  it("every phase operation returns ok with deterministic inference callbacks", () => {
    const { phases } = run;
    expect(phases.create.ok).toBe(true);
    for (const batch of phases.intake) expect(batch.ok).toBe(true);
    expect(phases.drain.settled).toBe(true);
    expect(phases.status.ok).toBe(true);
    expect(phases.compact1.ok).toBe(true);
    expect(phases.llmContext1.ok).toBe(true);
    expect(phases.inspect1.overview.ok).toBe(true);
    expect(phases.inspect1.view.ok).toBe(true);
    expect(phases.inspect1.health.ok).toBe(true);
    expect(phases.mutate.edit.ok).toBe(true);
    expect(phases.mutate.delete.ok).toBe(true);
    expect(phases.mutate.healthAfterMutate.ok).toBe(true);
    expect(phases.rebuild.settled).toBe(true);
    expect(phases.health2.ok).toBe(true);
    expect(phases.compact2.ok).toBe(true);
    expect(phases.llmContext2.ok).toBe(true);
    expect(phases.materialize.ok).toBe(true);
  });

  it("status recommends the compact the sequence performs next, with derivation settled", () => {
    const status = ok(run.phases.status);
    expect(status.threshold).toBe(300);
    expect(status.tailTokens).toBeGreaterThan(status.threshold);
    expect(status.compactRecommended).toBe(true);
    expect(status.derivation).toEqual({ pending: 0, failed: 0, blocked: 0 });
    expect(status.view).toBeNull();
  });
});

describe("TC-5.1 / AC-5.2: checkpoint coherence across the sequence", () => {
  it("post-compact model context serves bands + tail, and the view report's loadCost prices that context", () => {
    const receipt = ok(run.phases.compact1);
    expect(receipt.profile).toBe(LIFECYCLE_PROFILE.name);
    const context = ok(run.phases.llmContext1);

    const bands = context.messages.filter(isBandMessage);
    expect(bands.map((message) => messageText(message).match(/^\[context · ([^\]]+)\]/)?.[1])).toEqual([
      "brief",
      "detailed",
      "smooth",
    ]);
    expect(context.messages.slice(0, bands.length)).toEqual(bands);
    const tail = context.messages.slice(bands.length);
    expect(tail.length).toBeGreaterThan(0);

    const report = ok(run.phases.inspect1.view);
    expect(report.meta?.viewId).toBe(receipt.viewId);
    expect(report.meta?.profile).toBe(LIFECYCLE_PROFILE.name);
    expect(report.loadCost.bandTokens).toBe(measured(bands));
    expect(report.loadCost.tailTokens).toBe(measured(tail));
    expect(report.loadCost.total).toBe(measured(context.messages));

    const overview = ok(run.phases.inspect1.overview);
    expect(overview.view?.viewId).toBe(receipt.viewId);
    expect(overview.derivation.pending).toBe(0);
    expect(overview.messages.deleted).toBe(0);
  });

  it("post-mutation health shows exactly the cleared set pending; post-drain health shows it ready", () => {
    const { mutate } = run.phases;
    const edit = ok(mutate.edit);
    const deleted = ok(mutate.delete);
    expect(edit.superseded).toEqual([]);
    expect(deleted.superseded).toEqual([]);
    expect(deleted.dropped).toEqual([]);

    const cleared = clearedKeys(edit, deleted);
    expect(cleared.length).toBeGreaterThan(0);
    const pending = pendingKeys(ok(mutate.messagesNotReady), ok(mutate.turnsNotReady));
    expect(pending).toEqual(cleared);

    const health = ok(mutate.healthAfterMutate);
    const pendingTotal = health.owners.reduce((sum, row) => sum + row.counts.pending, 0);
    expect(pendingTotal).toBe(cleared.length);
    expect(health.queue).toEqual({ queued: cleared.length, claimed: 0 });
    expect(edit.queued.length).toBeGreaterThan(0);
    expect(deleted.queued.length).toBeGreaterThan(0);
    expect(health.failures).toEqual([]);

    const after = ok(run.phases.health2);
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

  it("the second compact's view reflects post-edit content", () => {
    const llmContext1 = ok(run.phases.llmContext1);
    const llmContext2 = ok(run.phases.llmContext2);

    expect(llmContext1.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(true);
    expect(llmContext1.messages.some((m) => messageText(m) === DELETED_MESSAGE_TEXT)).toBe(true);

    expect(
      llmContext2.messages.some(
        (m) => !isBandMessage(m) && m.role === "user" && messageText(m) === EDITED_MESSAGE_TEXT,
      ),
    ).toBe(true);
    expect(llmContext2.messages.some((m) => messageText(m).includes(DELETED_MESSAGE_TEXT))).toBe(false);
    expect(llmContext2.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(false);
  });
});

describe("TC-5.2 / AC-5.3: replay determinism on a fresh thread", () => {
  it("produces hash-equal LlmRequestContext outputs and a byte-identical materialized file (modulo the one random thread id)", async () => {
    const replay = await runLifecycle(store, { name: "replay" });

    const contexts: Array<[OpResult<LlmRequestContext>, OpResult<LlmRequestContext>]> = [
      [run.phases.llmContext1, replay.phases.llmContext1],
      [run.phases.llmContext2, replay.phases.llmContext2],
    ];
    for (const [original, replayed] of contexts) {
      expect(sha256(JSON.stringify(comparableContext(ok(replayed))))).toBe(
        sha256(JSON.stringify(comparableContext(ok(original)))),
      );
    }

    expect(replay.threadId).not.toBe(run.threadId);
    expect(sha256(comparableSessionFile(replay))).toBe(sha256(comparableSessionFile(run)));
  }, 60000);
});

describe("TC-5.3 / AC-5.4: teardown continuity — fresh initLhc between phase groups", () => {
  it("yields final LlmRequestContext, health, and materialized file identical to the uninterrupted run's", async () => {
    const teardown = await runLifecycle(store, {
      name: "teardown",
      freshSdkBetweenGroups: true,
    });

    expect(JSON.stringify(comparableContext(ok(teardown.phases.llmContext2)))).toBe(
      JSON.stringify(comparableContext(ok(run.phases.llmContext2))),
    );
    expect(ok(teardown.phases.health2)).toEqual(ok(run.phases.health2));
    expect(sha256(comparableSessionFile(teardown))).toBe(sha256(comparableSessionFile(run)));
  }, 60000);
});
