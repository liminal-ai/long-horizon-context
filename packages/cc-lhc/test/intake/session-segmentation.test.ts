/**
 * Canonical segmentation through the live capture session: the end lands
 * after the candidate line's events and before any later line's, only when
 * the SDK newly recorded that line, sized by the SDK's own open-turn estimate,
 * with genuine completion closing regardless of size.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, MessageEventInput } from "lhc";
import { describe, expect, it } from "vitest";
import { type CaptureSession, type CaptureSessionDeps, startCaptureSession } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function line(item: RolloutLineItem): string {
  return `${JSON.stringify(item)}\n`;
}

const PROMPT = line({ type: "user", uuid: "u1", message: { role: "user", content: "research" } });
const CALLS = line({
  type: "assistant",
  uuid: "a1",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "", signature: "SIG1" },
      { type: "tool_use", id: "t1", name: "Read", input: { a: 1 } },
      { type: "tool_use", id: "t2", name: "Read", input: { a: 2 } },
    ],
  },
});
function result(uuid: string, id: string): string {
  return line({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `out ${id}` }] },
  });
}
const TEXT_MID = line({
  type: "assistant",
  uuid: "a2",
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "next step" }] },
});
const LATE_CALL = line({
  type: "assistant",
  uuid: "a3",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t3", name: "Bash", input: { c: "ls" } }],
  },
});
const DONE = line({
  type: "assistant",
  uuid: "a4",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
});
const RESEARCH_RUN =
  PROMPT + CALLS + result("r1", "t1") + result("r2", "t2") + TEXT_MID + LATE_CALL + result("r3", "t3") + DONE;

type Flush = { events: MessageEventInput[] };

interface Harness {
  session: CaptureSession;
  flushes: Flush[];
  lifecycle: LifecycleSignal[];
  setTokens(tokens: number): void;
  setThreshold(tokens: number | undefined): void;
  stop(): Promise<void>;
}

function harness(
  cwd: string,
  options: { threshold?: number; tokens: number; outcome?: (event: MessageEventInput) => "recorded" | "skipped" },
): Harness & { rolloutPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), "cc-lhc-segment-"));
  const projectsRoot = join(tmp, "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  mkdirSync(projectDir, { recursive: true });
  const rolloutPath = join(projectDir, "session.jsonl");
  let tokens = options.tokens;
  let threshold = options.threshold;
  const flushes: Flush[] = [];
  const lifecycle: LifecycleSignal[] = [];
  const outcome = options.outcome ?? (() => "recorded" as const);
  const sdk = {
    threadView: {
      hostMetadata: async () => ({
        ok: true as const,
        value: {
          activeTurn:
            tokens <= 0
              ? null
              : { turnId: "turn", estimatedTokens: tokens, completeSteps: 0, lastStepEdge: null, splittable: false },
          unsettledTurn: null,
        },
      }),
    },
  } as unknown as Lhc;
  const deps: CaptureSessionDeps = {
    cwd,
    startedAt: new Date(Date.now() - 60_000),
    noInference: true,
    expectedSession: { sessionId: "session", source: "fresh" },
    discoverDeps: { projectsRoot, pollMs: 20 },
    lineageDbPath: join(tmp, "lineage.sqlite"),
    registryPath: join(tmp, "registry.sqlite"),
    log: () => {},
    logError: (message) => {
      throw new Error(message);
    },
    launchThread: { threadId: "th_segment", createdAtLaunch: true },
    initSdkFn: () => sdk,
    onLifecycle: (signals) => lifecycle.push(...signals),
    segmentThresholdTokens: () => {
      if (threshold === undefined) throw new Error("threshold unset");
      return threshold;
    },
    flushBatchFn: async (_sdk, _threadRef, _items, events) => {
      flushes.push({ events: [...events] });
      return {
        ok: true,
        eventOutcomes: events.map((event) => ({ idempotencyKey: event.idempotencyKey, outcome: outcome(event) })),
      };
    },
  };
  if (threshold === undefined) delete deps.segmentThresholdTokens;
  const session = startCaptureSession(deps);
  return {
    session,
    flushes,
    lifecycle,
    rolloutPath,
    setTokens: (value) => {
      tokens = value;
    },
    setThreshold: (value) => {
      threshold = value;
    },
    stop: () => session.stop(),
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function kinds(flush: Flush): string[] {
  return flush.events.map((event) => event.eventKind);
}
function ends(flushes: readonly Flush[]): Array<{ key: string; reason: string }> {
  return flushes
    .flatMap((flush) => flush.events)
    .filter((event) => event.eventKind === "turn_end")
    .map((event) => ({
      key: event.idempotencyKey,
      reason: String((event.payload as { outcomeReason?: string }).outcomeReason),
    }));
}
/** Every tool_call precedes its result and no turn_end sits between them, in submission order. */
function assertPairsWhole(flushes: readonly Flush[]): void {
  const open = new Set<string>();
  for (const event of flushes.flatMap((flush) => flush.events)) {
    if (event.eventKind === "tool_call") open.add(String(event.payload.toolCallId));
    if (event.eventKind === "tool_result") {
      expect(open.has(String(event.payload.toolCallId))).toBe(true);
      open.delete(String(event.payload.toolCallId));
    }
    if (event.eventKind === "turn_end") expect([...open]).toEqual([]);
  }
}

describe("canonical segmentation in the capture session", () => {
  it("one watcher batch: ends land after their candidate lines, before later lines, only at or above the live threshold", async () => {
    const h = harness("/work/segment-batch", { threshold: 10_500, tokens: 20_000 });
    writeFileSync(h.rolloutPath, RESEARCH_RUN);
    try {
      await waitFor(() => h.session.stats.linesSeen === 8 && (h.session.stats.segmentEnds ?? 0) === 3, "all ends");
      // Flushes, in order: through r2 (t1 and t2 both resolved) → end(r2) →
      // through r3 (a2's text is not a boundary; t3 issued on a later line) →
      // end(r3) → a4 → completion end(a4).
      expect(h.flushes.map(kinds)).toEqual([
        ["user_prompt", "assistant_thinking", "tool_call", "tool_call", "tool_result", "tool_result"],
        ["turn_end"],
        ["assistant_text", "tool_call", "tool_result"],
        ["turn_end"],
        ["assistant_text"],
        ["turn_end"],
      ]);
      expect(ends(h.flushes)).toEqual([
        { key: "cc-lhc:rollout:r2:0:turn_end", reason: "cc_lhc_segment" },
        { key: "cc-lhc:rollout:r3:0:turn_end", reason: "cc_lhc_segment" },
        { key: "cc-lhc:rollout:a4:0:turn_end", reason: "cc_lhc_completion" },
      ]);
      assertPairsWhole(h.flushes);
      // Content of the source events is untouched by segmentation.
      const sources = h.flushes.flatMap((flush) => flush.events).filter((event) => event.eventKind !== "turn_end");
      expect(sources.map((event) => event.idempotencyKey)).toEqual([
        "cc-lhc:rollout:u1:0:user_prompt",
        "cc-lhc:rollout:a1:0:assistant_thinking",
        "cc-lhc:rollout:a1:1:tool_call",
        "cc-lhc:rollout:a1:2:tool_call",
        "cc-lhc:rollout:r1:0:tool_result",
        "cc-lhc:rollout:r2:0:tool_result",
        "cc-lhc:rollout:a2:0:assistant_text",
        "cc-lhc:rollout:a3:0:tool_call",
        "cc-lhc:rollout:r3:0:tool_result",
        "cc-lhc:rollout:a4:0:assistant_text",
      ]);
      // Native lifecycle is untouched: exactly one settle, from the real terminal line.
      expect(h.lifecycle.filter((signal) => signal.kind === "turn_settled")).toHaveLength(1);
      expect(h.session.isTurnOpen()).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it("below the threshold no segment end is appended, but genuine completion still closes", async () => {
    const h = harness("/work/segment-small", { threshold: 10_500, tokens: 4_000 });
    writeFileSync(h.rolloutPath, RESEARCH_RUN);
    try {
      await waitFor(() => (h.session.stats.segmentEnds ?? 0) === 1, "completion end");
      expect(ends(h.flushes)).toEqual([{ key: "cc-lhc:rollout:a4:0:turn_end", reason: "cc_lhc_completion" }]);
      expect(h.flushes.flatMap((flush) => flush.events).filter((e) => e.eventKind !== "turn_end")).toHaveLength(10);
      assertPairsWhole(h.flushes);
    } finally {
      await h.stop();
    }
  });

  it("the threshold is read live at each candidate", async () => {
    const h = harness("/work/segment-live", { threshold: 100_000, tokens: 20_000 });
    writeFileSync(h.rolloutPath, PROMPT + CALLS + result("r1", "t1") + result("r2", "t2"));
    try {
      await waitFor(() => h.session.stats.linesSeen === 4, "first exchange");
      expect(ends(h.flushes)).toEqual([]);
      h.setThreshold(10_500);
      writeFileSync(h.rolloutPath, TEXT_MID + LATE_CALL + result("r3", "t3"), { flag: "a" });
      await waitFor(() => (h.session.stats.segmentEnds ?? 0) === 1, "second exchange end");
      expect(ends(h.flushes)).toEqual([{ key: "cc-lhc:rollout:r3:0:turn_end", reason: "cc_lhc_segment" }]);
    } finally {
      await h.stop();
    }
  });

  it("an old line the SDK skips as a duplicate never manufactures an end against the current turn", async () => {
    const h = harness("/work/segment-replay", { threshold: 10_500, tokens: 20_000, outcome: () => "skipped" });
    writeFileSync(h.rolloutPath, RESEARCH_RUN);
    try {
      await waitFor(() => h.session.stats.linesSeen === 8, "all lines");
      // Flushes still split at every candidate (ordered prefix), yet no end follows a skipped line.
      await waitFor(() => h.flushes.length === 3, "three prefix flushes");
      expect(ends(h.flushes)).toEqual([]);
      expect(h.session.stats.segmentEnds ?? 0).toBe(0);
    } finally {
      await h.stop();
    }
  });

  it("without a threshold getter only completion closes; a mid-run steer after a segment keeps pairing whole", async () => {
    const h = harness("/work/segment-nothreshold", { tokens: 50_000 });
    writeFileSync(h.rolloutPath, RESEARCH_RUN);
    try {
      await waitFor(() => (h.session.stats.segmentEnds ?? 0) === 1, "completion end");
      expect(ends(h.flushes)).toEqual([{ key: "cc-lhc:rollout:a4:0:turn_end", reason: "cc_lhc_completion" }]);
    } finally {
      await h.stop();
    }
  });

  it("an interrupted task's abandoned call does not block the next task's segment end", async () => {
    const INTERRUPT = line({
      type: "user",
      uuid: "u-int",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
    });
    const NEXT_PROMPT = line({ type: "user", uuid: "u2", message: { role: "user", content: "next task" } });
    const h = harness("/work/segment-interrupt", { threshold: 10_500, tokens: 20_000 });
    // Task 1 issues t1/t2 and only t1 answers before the interrupt; task 2 runs t3 to completion.
    writeFileSync(
      h.rolloutPath,
      PROMPT + CALLS + result("r1", "t1") + INTERRUPT + NEXT_PROMPT + LATE_CALL + result("r3", "t3") + DONE,
    );
    try {
      await waitFor(() => (h.session.stats.segmentEnds ?? 0) === 2, "segment and completion ends");
      expect(ends(h.flushes)).toEqual([
        { key: "cc-lhc:rollout:r3:0:turn_end", reason: "cc_lhc_segment" },
        { key: "cc-lhc:rollout:a4:0:turn_end", reason: "cc_lhc_completion" },
      ]);
      // The end follows r3's events and precedes a4's.
      const flat = h.flushes.flatMap((flush) => flush.events).map((event) => event.idempotencyKey);
      expect(flat.indexOf("cc-lhc:rollout:r3:0:turn_end")).toBe(flat.indexOf("cc-lhc:rollout:r3:0:tool_result") + 1);
      expect(flat.indexOf("cc-lhc:rollout:a4:0:assistant_text")).toBeGreaterThan(
        flat.indexOf("cc-lhc:rollout:r3:0:turn_end"),
      );
    } finally {
      await h.stop();
    }
  });

  it("settled catch-up closes a finished turn the record still holds open, once, keyed to its terminal line", async () => {
    // Every source event skipped: this transcript was captured before the repair.
    const h = harness("/work/segment-catchup", { threshold: 10_500, tokens: 30_000, outcome: () => "skipped" });
    writeFileSync(h.rolloutPath, RESEARCH_RUN);
    try {
      await waitFor(() => h.session.stats.linesSeen === 8, "all lines");
      expect(h.session.isTurnOpen()).toBe(false);
      const first = await h.session.closeSettledSegment();
      expect(first.kind).toBe("closed");
      expect(ends(h.flushes)).toEqual([{ key: "cc-lhc:rollout:a4:0:turn_end", reason: "cc_lhc_settled_catch_up" }]);
      // The record now shows nothing open: a second seam does nothing.
      h.setTokens(0);
      const second = await h.session.closeSettledSegment();
      expect(second).toEqual({ kind: "skipped", detail: "canonical turn already closed" });
      expect(ends(h.flushes)).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  it("settled catch-up refuses while the native turn is open", async () => {
    const h = harness("/work/segment-catchup-open", { threshold: 10_500, tokens: 30_000, outcome: () => "skipped" });
    writeFileSync(h.rolloutPath, PROMPT + CALLS + result("r1", "t1"));
    try {
      await waitFor(() => h.session.stats.linesSeen === 3, "all lines");
      expect(h.session.isTurnOpen()).toBe(true);
      expect(await h.session.closeSettledSegment()).toEqual({ kind: "skipped", detail: "native turn open" });
      expect(ends(h.flushes)).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});
