/**
 * LIM-146 AC-2.7c: the live capture path is what proves delivery. A real
 * capture session watching a real rollout reports the result keys named by
 * Claude's record of the UserPromptSubmit hook's accepted context — and
 * nothing else — with the bound thread id.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lhc } from "lhc";
import { describe, expect, it } from "vitest";

import { formatResultContext } from "../../src/continuity/delivery.js";
import type { CarriedResult } from "../../src/continuity/store.js";
import { startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

const KEYS = ["agent:agent-1:toolu_agent", "background_shell:shell-1:toolu_sh"];
const results: CarriedResult[] = KEYS.map((launchId, i) => ({
  threadId: "th_rt",
  launchId,
  generation: 1,
  family: i === 0 ? "agent" : "background_shell",
  label: i === 0 ? 'background agent "reviewer" (agent-1)' : "background command (shell-1)",
  outcome: i === 0 ? "completed" : "failed",
  evidence: "task-notification",
  artifact: null,
  observedAtMs: 1,
  delivery: "pending",
  createdAtMs: 1,
}));

describe("live capture reports delivered result keys", () => {
  it("only the hook_additional_context record of a UserPromptSubmit hook, on the bound session, names keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-sess-delivery-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/sess-delivery";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "aaaaaaaa-bbbb-cccc-dddd-333333333333";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    const record = (extra: Record<string, unknown>) =>
      `${JSON.stringify({ sessionId: sid, isSidechain: false, userType: "external", ...extra })}\n`;
    writeFileSync(path, record({ type: "user", uuid: "u0", message: { role: "user", content: "seed" } }));
    const delivered: Array<{ keys: readonly string[]; threadId: string }> = [];
    const context = formatResultContext(results);
    const hookRecord = (content: string, attachment: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
      record({
        type: "attachment",
        uuid: `a-${Math.random()}`,
        attachment: {
          type: "hook_additional_context",
          content: [content],
          hookName: "UserPromptSubmit",
          toolUseID: "hook-1",
          hookEvent: "UserPromptSubmit",
          ...attachment,
        },
        ...top,
      });

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(root, "lineage.sqlite"),
      registryPath: join(root, "reg.sqlite"),
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_rt", createdAtLaunch: true },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async () => {},
      onResultDelivery: (keys, threadId) => {
        delivered.push({ keys, threadId });
      },
    });
    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      // The real prompt, then what proves nothing: user text quoting a key, another hook, a sidechain copy.
      appendFileSync(path, record({ type: "user", uuid: "u1", message: { role: "user", content: `see ${context}` } }));
      appendFileSync(path, hookRecord(context, { hookEvent: "SessionStart", hookName: "SessionStart" }));
      appendFileSync(path, hookRecord(context, {}, { isSidechain: true }));
      // Then Claude's record of our hook's accepted context.
      appendFileSync(path, hookRecord(context));
      await waitFor(() => delivered.length === 1, "delivery observed");
      await sleep(150);
      expect(delivered).toEqual([{ keys: KEYS, threadId: "th_rt" }]);
      // Re-observation of the same record reports again; the store makes it idempotent.
      appendFileSync(path, hookRecord(context));
      await waitFor(() => delivered.length === 2, "second observation");
      expect(delivered[1]).toEqual({ keys: KEYS, threadId: "th_rt" });
    } finally {
      await session.stop();
    }
  });
});
