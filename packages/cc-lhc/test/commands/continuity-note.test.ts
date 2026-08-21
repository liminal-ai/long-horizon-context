/**
 * LIM-116 continuity note: TC-5.1a-d, TC-5.3a-c, AR-9.
 */
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Lhc, ThreadRef } from "lhc";

import {
  formatDurableReceipt,
  runContextMutation,
  type ContextMutationPlan,
} from "../../src/commands/context-mutation.js";
import {
  formatContinuityNote,
  freezeLiveAsyncWork,
  MAX_NAMED_CONTINUITY_ITEMS,
} from "../../src/commands/continuity-note.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { mapRolloutLine } from "../../src/intake/map.js";
import {
  createAsyncWorkFold,
  openAsyncWork,
  type OpenAsyncWork,
} from "../../src/observation/async-work.js";
import { observeRolloutLines } from "../../src/observation/observe.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import { writeRebuiltRollout } from "../../src/rollout/write-rebuilt.js";
import { formatOldChildCleanup } from "../../src/wrapper/old-child-cleanup.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

const NOW = 1_787_135_000_000;
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "async-work",
  "claude-2.1.235-async-work.jsonl",
);

function work(overrides: Partial<OpenAsyncWork> & Pick<OpenAsyncWork, "family">): OpenAsyncWork {
  return { key: overrides.taskId ?? overrides.family, ...overrides };
}

function fixtureLines(): RolloutLineItem[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

function replay(lines: readonly RolloutLineItem[]): OpenAsyncWork[] {
  const asyncWorkFold = createAsyncWorkFold();
  observeRolloutLines(lines, { asyncWorkFold });
  return openAsyncWork(asyncWorkFold);
}

describe("TC-5.1a name work that lost continuity", () => {
  it("names each open agent/workflow/monitor/wakeup once with lost-continuity and verify/restart wording, never stopped", () => {
    const note = formatContinuityNote(
      [
        work({ family: "agent", taskId: "a1", description: "reviewer" }),
        work({ family: "workflow", taskId: "w1", description: "story-build" }),
        work({ family: "monitor", taskId: "m1", description: "CI watch" }),
        work({ family: "scheduled_wakeup", description: "loop tick", scheduledForMs: NOW + 60_000 }),
      ],
      NOW,
    );
    expect(note).toBeDefined();
    expect(note).toContain("background agent");
    expect(note).toContain("reviewer");
    expect(note).toContain("workflow");
    expect(note).toContain("story-build");
    expect(note).toContain("monitor");
    expect(note).toContain("CI watch");
    expect(note).toContain("scheduled wakeup");
    expect(note).toContain("continuity lost");
    expect(note).toContain("verify or restart");
    expect(note).toContain("does not claim that the previous Claude process or those items stopped");
    expect(note).not.toMatch(/\b(was stopped|have stopped|has stopped|will stop)\b/i);
    expect(note).not.toMatch(/\bterminated\b/i);
    expect(note).not.toMatch(/\bkilled\b/i);
    for (const name of ["reviewer", "story-build", "CI watch", "loop tick"]) {
      expect(note!.split(name).length - 1).toBe(1);
    }
  });
});

describe("TC-5.1b name detached command", () => {
  it("labels an open background command detached, possibly running, unable to report, and requiring verification", () => {
    const note = formatContinuityNote(
      [work({ family: "background_shell", taskId: "b1", description: "long build" })],
      NOW,
    );
    expect(note).toContain("background command");
    expect(note).toContain("(b1)");
    expect(note).not.toContain("long build");
    expect(note).toContain("detached from this session");
    expect(note).toMatch(/may still be running/);
    expect(note).toContain("cannot return output or completion");
    expect(note).toMatch(/check before relying on its result/);
    expect(note).toContain("does not claim that the previous Claude process or those items stopped");
    expect(note).not.toMatch(/\b(was stopped|have stopped|has stopped)\b/i);
  });
});

describe("TC-5.1c do not report completed work", () => {
  it("omits work closed by matching terminal evidence before the frozen snapshot", () => {
    const lines = fixtureLines();
    const afterAgent = replay(lines.slice(0, 12));
    expect(afterAgent.map((item) => item.family)).not.toContain("agent");
    const note = formatContinuityNote(afterAgent, NOW) ?? "";
    expect(note).not.toContain("probe agent");
    expect(note.toLowerCase()).not.toContain("background agent");
  });
});

describe("TC-5.1d reuse accepted tracking", () => {
  it("formats the exact accepted OpenAsyncWork[] snapshot without creating a second fold", () => {
    const snapshot = freezeLiveAsyncWork([
      work({ family: "agent", taskId: "a1", description: "reviewer" }),
    ]);
    const note = formatContinuityNote(snapshot, NOW);
    expect(note).toContain("reviewer");
    expect(createAsyncWorkFold().open.size).toBe(0);
    const mutated = [...snapshot] as OpenAsyncWork[];
    expect(() => {
      (snapshot as OpenAsyncWork[]).push(work({ family: "monitor", taskId: "m9" }));
    }).toThrow();
    expect(snapshot).toHaveLength(1);
    expect(mutated).toHaveLength(1);
  });
});

describe("TC-5.3a detailed bounded note and outcome", () => {
  it("bounded details appear once in starting context and cleanup outcome appears once post-switch", () => {
    const snapshot = [
      work({ family: "agent", taskId: "a1", description: "reviewer" }),
      work({ family: "background_shell", taskId: "b1", description: "long build" }),
    ];
    const note = formatContinuityNote(snapshot, NOW)!;
    const receipt = formatDurableReceipt(
      "compact",
      { origin: "manual", viewTokens: 9, targetTokens: 240_000 },
      [],
      note,
    );
    expect(receipt.split("Smart Compact rebuilt this session").length - 1).toBe(1);
    expect(receipt).toContain("[lhc compact:manual]");
    expect(receipt).not.toContain("terminated");
    expect(receipt).not.toContain("surviving orphan");
    const cleanup = formatOldChildCleanup({ kind: "terminated", pid: 42 });
    expect(cleanup).toBe("old child pid 42 terminated");
    expect(note).not.toContain("old child");
    expect(cleanup).not.toContain("reviewer");
  });
});

describe("TC-5.3b generic fallback", () => {
  it("item/text overflow emits bounded count/category fallback without termination claim", () => {
    const many = Array.from({ length: MAX_NAMED_CONTINUITY_ITEMS + 1 }, (_, index) =>
      work({ family: "agent", taskId: `a${index}`, description: `agent-${index}` }),
    );
    const note = formatContinuityNote(many, NOW)!;
    expect(note).toContain(`${many.length} pieces`);
    expect(note).toContain("background agents");
    expect(note).toContain("Verify or restart");
    expect(note).not.toContain("agent-0");
    expect(note).toContain("does not claim that the previous Claude process or those items stopped");
    expect(note).not.toMatch(/\bterminated\b/i);
  });
});

describe("durable continuity labels redact command bodies and latestEvent", () => {
  it("never copies background_shell description or latestEvent into the durable note", () => {
    const secretCommand =
      "curl https://api.example.com/v1 -H 'Authorization: Bearer API_KEY=sk-live-secret-value'";
    const secretEvent = "stdout: token=eyJhbGciOi output dump with secret material";
    const snapshot = [
      work({
        family: "background_shell",
        taskId: "b-secret",
        description: secretCommand,
        latestEvent: secretEvent,
      }),
    ];
    const note = formatContinuityNote(snapshot, NOW)!;
    const receipt = formatDurableReceipt("compact", { origin: "manual", viewTokens: 9 }, [], note);
    for (const text of [note, receipt]) {
      expect(text).toContain("background command");
      expect(text).toContain("(b-secret)");
      expect(text).toContain("detached from this session");
      expect(text).toContain("may still be running");
      expect(text).not.toContain("API_KEY");
      expect(text).not.toContain("sk-live-secret-value");
      expect(text).not.toContain("eyJhbGciOi");
      expect(text).not.toContain("stdout:");
      expect(text).not.toContain("token=");
      expect(text).not.toContain("curl");
      expect(text).not.toContain(secretCommand);
      expect(text).not.toContain(secretEvent);
      expect(text).not.toContain("last event");
    }
  });

  it("still names non-shell items from their bounded descriptions", () => {
    const note = formatContinuityNote(
      [
        work({
          family: "agent",
          taskId: "a1",
          description: "reviewer",
          latestEvent: "progress token=should-not-appear",
        }),
      ],
      NOW,
    )!;
    expect(note).toContain("background agent");
    expect(note).toContain("reviewer");
    expect(note).toContain("(a1)");
    expect(note).not.toContain("token=should-not-appear");
    expect(note).not.toContain("last event");
    expect(note).not.toContain("progress token");
  });

  it("writeRebuilt receipt text omits shell command body and latestEvent", async () => {
    const secretCommand = "export API_KEY=sk-live-secret-value && ./tool --token secret";
    const secretEvent = "latest output: bearer token=eyJhbGciOi leaked";
    const live: OpenAsyncWork[] = [
      work({
        family: "background_shell",
        taskId: "b-secret",
        description: secretCommand,
        latestEvent: secretEvent,
      }),
    ];
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 5,
            totalTokens: 9,
            bands: { smooth: { entries: 1, tokens: 4 }, detailed: { entries: 0, tokens: 0 }, brief: { entries: 0, tokens: 0 } },
          },
        })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
        })),
      },
    };
    const runtime: LhcCommandRuntime = {
      stats: {
        linesSeen: 0,
        eventsSent: 0,
        skippedSidechain: 0,
        skippedUnknown: 0,
        skippedMeta: 0,
        skippedImage: 0,
        skippedReplay: 0,
        replayedPrefixLines: 0,
        parseFailures: 0,
        derivationsPending: null,
        threadId: "th",
      },
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th", registryPath: "/tmp/r.sqlite" } as ThreadRef,
      cwd: "/work",
      sourceRolloutPath: undefined,
      sourceSessionId: "old",
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      getCaptureGeneration: () => 1,
      captureGeneration: 1,
      capturePhase: "ready",
      getLiveAsyncWork: () => live,
    };
    const write = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "new",
      rolloutPath: "/tmp/new.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    });
    const outcome = await runContextMutation(
      { operation: "compact", profile: "default", lowerBoundTokens: 100 },
      runtime,
    );
    expect(outcome.kind).toBe("rebuilt");
    const receiptText = write.mock.calls[0]?.[0]?.receipt?.text ?? "";
    expect(receiptText).toContain("background command");
    expect(receiptText).toContain("(b-secret)");
    expect(receiptText).toContain("detached from this session");
    expect(receiptText).not.toContain("API_KEY");
    expect(receiptText).not.toContain("sk-live-secret-value");
    expect(receiptText).not.toContain("eyJhbGciOi");
    expect(receiptText).not.toContain(secretCommand);
    expect(receiptText).not.toContain(secretEvent);
    write.mockRestore();
  });
});

describe("TC-5.3c no continuity-lost work", () => {
  it("empty snapshot adds no background-work continuity paragraph", () => {
    expect(formatContinuityNote([], NOW)).toBeUndefined();
    expect(formatDurableReceipt("auto_compact", { origin: "auto", viewTokens: 9 }, [], undefined)).toBe(
      "[lhc compact:auto] rebuilt LHC view 9.",
    );
  });
});

describe("AR-9 runtime-note/replay fences preserve one note", () => {
  it("writes one trailing runtime note and replay does not emit a duplicate event", async () => {
    const note = formatContinuityNote([work({ family: "agent", taskId: "a1", description: "reviewer" })], NOW)!;
    const text = formatDurableReceipt("compact", { origin: "manual", viewTokens: 20, targetTokens: 240_000 }, [], note);
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-cont-replay-"));
    const projectsRoot = join(root, "projects");
    mkdirSync(join(projectsRoot, encodeProjectPath("/work/cont")), { recursive: true });
    const rebuilt = await writeRebuiltRollout({
      view: { threadId: "th_c", entries: [{ role: "user", content: "hello", sourceMessages: [] }] },
      cwd: "/work/cont",
      projectsRoot,
      newSessionId: "rebuilt-cont",
      receipt: { text },
    });
    const lines = readFileSync(rebuilt.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RolloutLineItem);
    const notes = lines.filter((line) => {
      const content = line.message?.content;
      return typeof content === "string" && content.includes("[runtime note]");
    });
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.message?.content)).toContain("[lhc compact:manual]");
    expect(String(notes[0]!.message?.content)).toContain("reviewer");

    expect(rebuilt.replayedPrefixLines).toBe(rebuilt.lineCount - 1);
    const mapped = mapRolloutLine(notes[0]!, lines.length - 1);
    const runtimeNotes = mapped.events.filter((event) => event.eventKind === "runtime_note");
    expect(runtimeNotes).toHaveLength(1);
    const again = mapRolloutLine(notes[0]!, lines.length - 1);
    expect(again.events.map((event) => event.idempotencyKey)).toEqual(
      runtimeNotes.map((event) => event.idempotencyKey),
    );
    expect(runtimeNotes[0]?.idempotencyKey).toBeTruthy();
  });
});

describe("manual mutation freezes live work at the settled seam", () => {
  it("does not re-read live work after compact begins", async () => {
    let live: OpenAsyncWork[] = [work({ family: "agent", taskId: "a1", description: "before" })];
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => {
          live = [work({ family: "monitor", taskId: "m-late", description: "after" })];
          return { ok: true, value: { kind: "ok" } };
        }),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 5,
            totalTokens: 9,
            bands: { smooth: { entries: 1, tokens: 4 }, detailed: { entries: 0, tokens: 0 }, brief: { entries: 0, tokens: 0 } },
          },
        })),
        getSessionThreadView: vi.fn(async () => ({
          ok: true,
          value: { threadId: "th", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
        })),
      },
    };
    const runtime: LhcCommandRuntime = {
      stats: {
        linesSeen: 0,
        eventsSent: 0,
        skippedSidechain: 0,
        skippedUnknown: 0,
        skippedMeta: 0,
        skippedImage: 0,
        skippedReplay: 0,
        replayedPrefixLines: 0,
        parseFailures: 0,
        derivationsPending: null,
        threadId: "th",
      },
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th", registryPath: "/tmp/r.sqlite" } as ThreadRef,
      cwd: "/work",
      sourceRolloutPath: undefined,
      sourceSessionId: "old",
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      getCaptureGeneration: () => 1,
      captureGeneration: 1,
      capturePhase: "ready",
      getLiveAsyncWork: () => live,
    };
    const write = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockResolvedValue({
      sessionId: "new",
      rolloutPath: "/tmp/new.jsonl",
      lineCount: 2,
      expectedReintakeLines: 2,
      replayedPrefixLines: 1,
      prefixBoundary: { kind: "verified", lineCount: 1, byteLength: 10, sha256: "ab".repeat(32) },
      totalByteLength: 20,
    });
    const plan: ContextMutationPlan = { operation: "compact", profile: "default", lowerBoundTokens: 100 };
    const outcome = await runContextMutation(plan, runtime);
    expect(outcome.kind).toBe("rebuilt");
    if (outcome.kind === "rebuilt") {
      expect(outcome.handoff.liveAsyncWork.map((item) => item.description)).toEqual(["before"]);
      expect(outcome.handoff.durableReceipt).toContain("before");
      expect(outcome.handoff.durableReceipt).not.toContain("after");
    }
    write.mockRestore();
  });
});
