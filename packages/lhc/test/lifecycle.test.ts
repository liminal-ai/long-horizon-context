// Story 4 (Epic 04), default suite: TC-5.1–5.3 — the full-surface lifecycle
// exercise. One scripted sequence (test/fixtures/lifecycle.ts) drives every
// built v1 surface in PI-extension call order against one real SDK
// configuration with the registry's deterministic provider: zero network and
// zero real-provider calls are structural (no other provider exists in the
// configuration), and every checkpoint assertion lives here, not in the
// script, so the replay (TC-5.2), teardown (TC-5.3), and process (TC-5.4,
// cli-process-inspect.test.ts) legs replay the same sequence.
//
// Determinism control: the wall clock is the one ambient input the built
// surfaces stamp into outputs (event recorded_at, view created_at, mutation
// timestamps), so this file freezes Date — and only Date; the scheduler's
// real setImmediate/setTimeout stay live for the background drains. With
// the clock frozen, pull outputs are byte-identical across runs with no
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
  estimateTokens,
  type DerivationReportEntry,
  type HealthReport,
  type MutationResult,
  type OpResult,
  type PullResult,
  type SweepReceipt,
  type ViewMessage,
} from "../src/index.js";
import {
  DELETED_MESSAGE_TEXT,
  EDITED_MESSAGE_TEXT,
  LIFECYCLE_PROFILE,
  runLifecycle,
  tempStore,
  type LifecycleRun,
  type TempStore,
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

function measured(messages: readonly ViewMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
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

type SweepLine = SweepReceipt["owners"][number];
function byOwnerKind(rows: readonly SweepLine[]): SweepLine[] {
  return [...rows].sort((a, b) =>
    `${a.owner}/${a.kind}`.localeCompare(`${b.owner}/${b.kind}`),
  );
}

// The materialized file with the run's own thread id substituted — the one
// sanctioned normalization (see header).
function comparableSessionFile(lifecycleRun: LifecycleRun): string {
  return readFileSync(lifecycleRun.outPath, "utf8").replaceAll(
    lifecycleRun.threadId,
    "<thread-id>",
  );
}

describe("TC-5.1 / AC-5.1: the full sequence completes ok through one SDK configuration", () => {
  it("every phase operation returns ok with the deterministic provider only", () => {
    const { phases } = run;
    expect(phases.create.ok).toBe(true);
    for (const batch of phases.intake) expect(batch.ok).toBe(true);
    expect(phases.drain.settled).toBe(true);
    expect(phases.status.ok).toBe(true);
    expect(phases.compact1.ok).toBe(true);
    expect(phases.pull1.ok).toBe(true);
    expect(phases.inspect1.overview.ok).toBe(true);
    expect(phases.inspect1.view.ok).toBe(true);
    expect(phases.inspect1.health.ok).toBe(true);
    expect(phases.mutate.edit.ok).toBe(true);
    expect(phases.mutate.delete.ok).toBe(true);
    expect(phases.mutate.healthAfterMutate.ok).toBe(true);
    expect(phases.rebuild.settled).toBe(true);
    expect(phases.health2.ok).toBe(true);
    expect(phases.compact2.ok).toBe(true);
    expect(phases.pull2.ok).toBe(true);
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
  it("post-compact pull serves bands + tail, and the view report's loadCost prices that pull", () => {
    const receipt = ok(run.phases.compact1);
    expect(receipt.profile).toBe(LIFECYCLE_PROFILE.name);
    const pull = ok(run.phases.pull1);

    // Bands open the array in gradient order; the tail follows in record
    // order — the served shape the PI extension will consume.
    const bands = pull.messages.filter((message) => message.band !== undefined);
    expect(bands.map((message) => message.band)).toEqual(["brief", "detailed", "smooth"]);
    expect(pull.messages.slice(0, bands.length)).toEqual(bands);
    const tail = pull.messages.slice(bands.length);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((message) => message.band === undefined)).toBe(true);
    expect(pull.meta.viewId).toBe(receipt.viewId);
    expect(pull.meta.compactPoint).toBe(receipt.compactPoint);

    // Cross-epic loadCost checkpoint (test plan: report at compact1 vs
    // pull1): the inspect report's serving cost equals this independent
    // pull re-measured with the shared estimator.
    const report = ok(run.phases.inspect1.view);
    expect(report.meta?.viewId).toBe(receipt.viewId);
    expect(report.meta?.profile).toBe(LIFECYCLE_PROFILE.name);
    expect(report.loadCost.bandTokens).toBe(measured(bands));
    expect(report.loadCost.tailTokens).toBe(measured(tail));
    expect(report.loadCost.total).toBe(measured(pull.messages));

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
    const pendingTotal = health.owners.reduce(
      (sum, row) => sum + row.counts.pending + row.counts.retrying,
      0,
    );
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
    const pull1 = ok(run.phases.pull1);
    const pull2 = ok(run.phases.pull2);

    // Before the mutations: the original prompt and the to-be-deleted text
    // are served verbatim in the tail (full fidelity).
    expect(
      pull1.messages.some((m) => m.content === "turn 12: please investigate area 12"),
    ).toBe(true);
    expect(pull1.messages.some((m) => m.content === DELETED_MESSAGE_TEXT)).toBe(true);

    // After mutate + rebuild + compact2: the edited prompt serves verbatim,
    // the deleted message is gone from the served view entirely.
    expect(
      pull2.messages.some(
        (m) => m.band === undefined && m.role === "user" && m.content === EDITED_MESSAGE_TEXT,
      ),
    ).toBe(true);
    expect(pull2.messages.some((m) => m.content.includes(DELETED_MESSAGE_TEXT))).toBe(false);
    expect(
      pull2.messages.some((m) => m.content === "turn 12: please investigate area 12"),
    ).toBe(false);
  });

  it("the second compact receipt's sweep section agrees with the health report taken immediately before it", () => {
    const receipt = ok(run.phases.compact2);
    const health: HealthReport = ok(run.phases.health2);
    expect("owners" in receipt.sweep).toBe(true);
    const sweep = receipt.sweep as SweepReceipt;

    // Field-level agreement per owner/kind: the sweep saw exactly the state
    // health reported — same ready counts, in-flight = pending + retrying,
    // and the failed/requeued/blocked sets empty on both sides.
    const expectedFromHealth = health.owners
      .filter(
        (row): row is (typeof health.owners)[number] & { owner: "messages" | "turns" } =>
          row.owner !== "capture",
      )
      .map((row) => ({
        owner: row.owner,
        kind: row.kind,
        ready: row.counts.ready,
        inFlight: row.counts.pending + row.counts.retrying,
        requeued: [],
        blocked: [],
        permanentFailed: [],
      }));
    expect(byOwnerKind(sweep.owners)).toEqual(byOwnerKind(expectedFromHealth));
    expect(health.failures).toEqual([]);
  });
});

describe("TC-5.2 / AC-5.3: replay determinism on a fresh thread", () => {
  it("produces hash-equal pull outputs and a byte-identical materialized file (modulo the one random thread id)", async () => {
    const replay = await runLifecycle(store, { name: "replay" });

    // Pull outputs: exact hash equality, no normalization — the frozen
    // clock leaves no ambient input, so any inequality is real
    // nondeterminism in the built surfaces.
    const pulls: Array<[OpResult<PullResult>, OpResult<PullResult>]> = [
      [run.phases.pull1, replay.phases.pull1],
      [run.phases.pull2, replay.phases.pull2],
    ];
    for (const [original, replayed] of pulls) {
      expect(sha256(JSON.stringify(ok(replayed)))).toBe(sha256(JSON.stringify(ok(original))));
    }

    // Materialized file: identical bytes after substituting each thread's
    // own id (the header's one random value — see file header note).
    expect(replay.threadId).not.toBe(run.threadId);
    expect(sha256(comparableSessionFile(replay))).toBe(sha256(comparableSessionFile(run)));
  }, 60000);
});

describe("TC-5.3 / AC-5.4: teardown continuity — fresh createSdk between phase groups", () => {
  it("yields final pull, health, and materialized file identical to the uninterrupted run's", async () => {
    const teardown = await runLifecycle(store, {
      name: "teardown",
      freshSdkBetweenGroups: true,
    });

    // No in-memory dependency: the end state lives in the thread file, so a
    // fresh instance continuing each phase group lands byte-identical.
    expect(JSON.stringify(ok(teardown.phases.pull2))).toBe(
      JSON.stringify(ok(run.phases.pull2)),
    );
    expect(ok(teardown.phases.health2)).toEqual(ok(run.phases.health2));
    expect(sha256(comparableSessionFile(teardown))).toBe(sha256(comparableSessionFile(run)));
  }, 60000);
});
