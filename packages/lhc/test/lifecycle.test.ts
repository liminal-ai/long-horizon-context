// Story 4 (Epic 04), default suite: TC-5.1–5.3 — the full-surface lifecycle
// exercise. One scripted sequence (test/fixtures/lifecycle.ts) drives every
// built v1 surface in PI-extension call order against one real SDK
// configuration with deterministic inference callbacks: zero network and
// zero model calls are structural (no model-call config exists in the
// configuration), and every checkpoint assertion lives here, not in the
// script, so the replay (TC-5.2), teardown (TC-5.3), and process (TC-5.4,
// cli-process-inspect.test.ts) legs replay the same sequence.
//
// Determinism control: the wall clock is the one ambient input the built
// surfaces stamp into outputs (event recorded_at, view created_at, mutation
// timestamps), so this file freezes Date — and only Date; the scheduler's
// real setImmediate/setTimeout stay live for the background drains. With
// the clock frozen, LlmRequestContext outputs are byte-identical across runs with no
// normalization at all.
//
// One pinned deviation (AC-5.3/AC-5.4 file equality): a thread's id is the
// design's ONE random value (threads design decision 7), and the PI session
// header embeds it (`id: "<threadId>:<timestamp>"`). Two real threads cannot
// share an id through the public surface, so the materialized-file equality
// here substitutes each run's own thread id with a fixed placeholder and
// requires every other byte identical. Nothing else is normalized.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type DerivationReportEntry,
  estimateTokens,
  type LlmRequestContext,
  type LlmRequestContextMessage,
  type MutationResult,
  type OpResult,
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

// The materialized file with the run's own thread id substituted — the one
// sanctioned normalization (see header).
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
    expect(status.derivation).toEqual({ pending: 0, retrying: 0, failed: 0, blocked: 0 });
    expect(status.view).toBeNull(); // not yet compacted at this checkpoint
  });
});

describe("TC-5.1 / AC-5.2: checkpoint coherence across the sequence", () => {
  it("post-compact model context serves bands + tail, and the view report's loadCost prices that context", () => {
    const receipt = ok(run.phases.compact1);
    expect(receipt.profile).toBe(LIFECYCLE_PROFILE.name);
    const context = ok(run.phases.llmContext1);

    // Bands open the array in gradient order; the tail follows in record
    // order — the served shape the PI extension will consume.
    const bands = context.messages.filter(isBandMessage);
    expect(bands.map((message) => messageText(message).match(/^\[context · ([^\]]+)\]/)?.[1])).toEqual([
      "brief",
      "detailed",
      "smooth",
    ]);
    expect(context.messages.slice(0, bands.length)).toEqual(bands);
    const tail = context.messages.slice(bands.length);
    expect(tail.length).toBeGreaterThan(0);

    // Cross-epic loadCost checkpoint (test plan: report at compact1 vs
    // llmContext1): the inspect report's serving cost equals this independent
    // context read re-measured with the shared estimator.
    const report = ok(run.phases.inspect1.view);
    expect(report.meta?.viewId).toBe(receipt.viewId);
    expect(report.meta?.profile).toBe(LIFECYCLE_PROFILE.name);
    expect(report.loadCost.bandTokens).toBe(measured(bands));
    expect(report.loadCost.tailTokens).toBe(measured(tail));
    expect(report.loadCost.total).toBe(measured(context.messages));

    // Overview agrees on the same view identity with derivation settled.
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
    // The deleted assistant_text owns no derived derivations: its cascade clears
    // sibling turn forms only.
    expect(deleted.dropped).toEqual([]);

    // The cascade contracts' cleared union IS the pending set the owners
    // report — no more, no less (AC-5.2's "the cleared set pending").
    const cleared = clearedKeys(edit, deleted);
    expect(cleared.length).toBeGreaterThan(0);
    const pending = pendingKeys(ok(mutate.messagesNotReady), ok(mutate.turnsNotReady));
    expect(pending).toEqual(cleared);

    // Health joins the same truth: pending counts sum to the cleared set,
    // with the queued replacement work live and unclaimed (the background
    // drain has not started — the snapshot precedes its first pass).
    const health = ok(mutate.healthAfterMutate);
    const pendingTotal = health.owners.reduce((sum, row) => sum + row.counts.pending + row.counts.retrying, 0);
    expect(pendingTotal).toBe(cleared.length);
    // Queue visibility is counted per report entry (AC-4.5's by-construction
    // consistency), so queued equals the pending entries — all unclaimed.
    expect(health.queue).toEqual({ queued: cleared.length, claimed: 0 });
    expect(edit.queued.length).toBeGreaterThan(0);
    expect(deleted.queued.length).toBeGreaterThan(0);
    expect(health.failures).toEqual([]);

    // Post-drain (rebuild settled): everything ready, nothing failed,
    // queue empty.
    const after = ok(run.phases.health2);
    for (const row of after.owners) {
      expect(row.counts.pending).toBe(0);
      expect(row.counts.retrying).toBe(0);
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

    // Before the mutations: the original prompt and the to-be-deleted text
    // are served verbatim in the tail (full fidelity).
    expect(llmContext1.messages.some((m) => messageText(m) === "turn 12: please investigate area 12")).toBe(true);
    expect(llmContext1.messages.some((m) => messageText(m) === DELETED_MESSAGE_TEXT)).toBe(true);

    // After mutate + rebuild + compact2: the edited prompt serves verbatim,
    // the deleted message is gone from the served view entirely.
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

    // LlmRequestContext outputs: exact hash equality, no normalization — the frozen
    // clock leaves no ambient input, so any inequality is real
    // nondeterminism in the built surfaces.
    const contexts: Array<[OpResult<LlmRequestContext>, OpResult<LlmRequestContext>]> = [
      [run.phases.llmContext1, replay.phases.llmContext1],
      [run.phases.llmContext2, replay.phases.llmContext2],
    ];
    for (const [original, replayed] of contexts) {
      expect(sha256(JSON.stringify(comparableContext(ok(replayed))))).toBe(
        sha256(JSON.stringify(comparableContext(ok(original)))),
      );
    }

    // Materialized file: identical bytes after substituting each thread's
    // own id (the header's one random value — see file header note).
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

    // No in-memory dependency: the end state lives in the thread file, so a
    // fresh instance continuing each phase group lands byte-identical.
    expect(JSON.stringify(comparableContext(ok(teardown.phases.llmContext2)))).toBe(
      JSON.stringify(comparableContext(ok(run.phases.llmContext2))),
    );
    expect(ok(teardown.phases.health2)).toEqual(ok(run.phases.health2));
    expect(sha256(comparableSessionFile(teardown))).toBe(sha256(comparableSessionFile(run)));
  }, 60000);
});
