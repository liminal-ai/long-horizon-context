import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";
import { type CaptureSession, startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function line(item: RolloutLineItem): string {
  return `${JSON.stringify(item)}\n`;
}

const USER_PROMPT = line({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } });
const ASSISTANT_END = line({
  type: "assistant",
  uuid: "a1",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
});
const ASSISTANT_TOOL = line({
  type: "assistant",
  uuid: "a2",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
  },
});
const USER_INTERRUPT = line({
  type: "user",
  uuid: "u2",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
});

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function hermeticSession(
  tmp: string,
  rolloutOptions: {
    knownRolloutPath?: string;
    prefixBoundary?: import("../../src/intake/prefix-boundary.js").PrefixBoundary;
    cwd: string;
    projectsRoot: string;
  },
): CaptureSession {
  const sessionId =
    rolloutOptions.knownRolloutPath !== undefined
      ? rolloutOptions.knownRolloutPath.replace(/\.jsonl$/, "").split("/").pop()!
      : "session";
  return startCaptureSession({
    cwd: rolloutOptions.cwd,
    startedAt: new Date(Date.now() - 60_000),
    noInference: true,
    expectedSession: {
      sessionId,
      source: rolloutOptions.knownRolloutPath !== undefined ? "rebuilt_handoff" : "fresh",
    },
    discoverDeps: { projectsRoot: rolloutOptions.projectsRoot, pollMs: 20 },
    lineageDbPath: join(tmp, "lineage.sqlite"),
    registryPath: join(tmp, "registry.sqlite"),
    log: () => {},
    logError: () => {},
    createThreadFn: async () => ({
      ok: true,
      value: { threadId: "th_turn", registryPath: join(tmp, "registry.sqlite") } as ThreadRef,
    }),
    initSdkFn: () => ({}) as Lhc,
    flushBatchFn: async () => {},
    ...(rolloutOptions.knownRolloutPath === undefined ? {} : { knownRolloutPath: rolloutOptions.knownRolloutPath }),
    ...(rolloutOptions.prefixBoundary === undefined ? {} : { prefixBoundary: rolloutOptions.prefixBoundary }),
  });
}

describe("capture session turn-state fold", () => {
  it("tracks open/closed across prompts, tool loops, closes, and interrupts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cc-lhc-turnfold-"));
    const projectsRoot = join(tmp, "projects");
    const cwd = "/work/turn-fold";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "session.jsonl");
    writeFileSync(rolloutPath, USER_PROMPT);

    const session = hermeticSession(tmp, { cwd, projectsRoot });
    try {
      await waitFor(() => session.isTurnOpen(), "prompt to open the turn");

      appendFileSync(rolloutPath, ASSISTANT_END);
      await waitFor(() => !session.isTurnOpen(), "end_turn to close the turn");

      appendFileSync(rolloutPath, ASSISTANT_TOOL);
      await waitFor(() => session.isTurnOpen(), "tool_use to reopen the turn");

      appendFileSync(rolloutPath, USER_INTERRUPT);
      await waitFor(() => !session.isTurnOpen(), "interrupt to close the turn");
    } finally {
      await session.stop();
    }
  });

  it("excludes replayed-prefix lines from the fold (post-swap handoff)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cc-lhc-turnfold-prefix-"));
    const projectsRoot = join(tmp, "projects");
    const cwd = "/work/turn-fold-prefix";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "rebuilt.jsonl");
    // A rebuilt rollout whose served history would read "open" if folded.
    const prefix = USER_PROMPT + USER_PROMPT;
    writeFileSync(rolloutPath, prefix);
    const { computeVerifiedPrefixBoundary } = await import("../../src/intake/prefix-boundary.js");
    const prefixBoundary = computeVerifiedPrefixBoundary(prefix, 2);

    const session = hermeticSession(tmp, {
      cwd,
      projectsRoot,
      knownRolloutPath: rolloutPath,
      prefixBoundary,
    });
    try {
      await waitFor(() => session.stats.replayedPrefixLines === 2, "prefix lines to be tallied");
      expect(session.isTurnOpen()).toBe(false);

      appendFileSync(rolloutPath, USER_PROMPT);
      await waitFor(() => session.isTurnOpen(), "fresh prompt after the prefix to open the turn");
    } finally {
      await session.stop();
    }
  });
});
