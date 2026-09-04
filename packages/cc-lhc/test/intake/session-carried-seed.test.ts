/**
 * LIM-146 TC-2.9b: a real capture session seeds the record's carried work
 * once, with the thread it bound, before any live line is folded — so a
 * restarted wrapper recognizes terminal evidence for work it did not see
 * launch. A seed that throws seeds nothing and is reported.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lhc } from "lhc";
import { describe, expect, it } from "vitest";

import { startCaptureSession } from "../../src/intake/session.js";
import type { AsyncWorkEvent, OpenAsyncWork } from "../../src/observation/async-work.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { notification } from "../continuity/helpers.js";

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

const CARRIED: OpenAsyncWork = { key: "agent-1", family: "agent", taskId: "agent-1", toolUseId: "toolu_agent" };

function rollout(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `cc-lhc-sess-seed-${prefix}-`));
  const projectsRoot = join(root, "projects");
  const cwd = `/work/seed-${prefix}`;
  mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
  const sid = `aaaaaaaa-bbbb-cccc-dddd-${prefix.padStart(12, "0")}`;
  const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
  const record = (extra: Record<string, unknown>) =>
    `${JSON.stringify({ sessionId: sid, isSidechain: false, userType: "external", ...extra })}\n`;
  writeFileSync(path, record({ type: "user", uuid: "u0", message: { role: "user", content: "seed" } }));
  return { root, projectsRoot, cwd, sid, path, record };
}

function start(
  r: ReturnType<typeof rollout>,
  deps: {
    seedAsyncWork: (threadId: string) => readonly OpenAsyncWork[];
    onAsyncWorkEvent: (event: AsyncWorkEvent, threadId: string) => void;
    logError: (m: string) => void;
    log?: (m: string) => void;
  },
) {
  return startCaptureSession({
    cwd: r.cwd,
    expectedSession: { sessionId: r.sid, source: "fresh" },
    knownRolloutPath: r.path,
    prefixBoundary: { kind: "none" },
    noInference: true,
    discoverDeps: { projectsRoot: r.projectsRoot, pollMs: 20 },
    lineageDbPath: join(r.root, "lineage.sqlite"),
    registryPath: join(r.root, "reg.sqlite"),
    log: deps.log ?? (() => {}),
    logError: deps.logError,
    launchThread: { threadId: "th_seed", createdAtLaunch: true },
    initSdkFn: () => ({}) as Lhc,
    flushBatchFn: async () => {},
    seedAsyncWork: deps.seedAsyncWork,
    onAsyncWorkEvent: deps.onAsyncWorkEvent,
  });
}

describe("live capture seeds carried work after binding its thread", () => {
  it("seeds once with the bound thread id, before any live line; terminal evidence then closes the carried item and only it", async () => {
    const r = rollout("1");
    const seededWith: string[] = [];
    const events: Array<{ event: AsyncWorkEvent; threadId: string }> = [];
    const logs: string[] = [];
    const session = start(r, {
      seedAsyncWork: (threadId) => {
        seededWith.push(threadId);
        expect(events).toEqual([]);
        return [CARRIED];
      },
      onAsyncWorkEvent: (event, threadId) => events.push({ event, threadId }),
      logError: () => {},
      log: (m) => logs.push(m),
    });
    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      expect(seededWith).toEqual(["th_seed"]);
      expect(logs).toContain("cc-lhc continuity: 1 carried item(s) seeded for thread th_seed");
      expect(session.getLiveAsyncWork()).toEqual([CARRIED]);
      // Unknown work finishing is not this record's evidence; the carried item finishing is.
      appendFileSync(
        r.path,
        r.record({ ...(notification({ taskIds: ["ghost-9"], status: "completed" }) as object), uuid: "n0" }),
      );
      appendFileSync(
        r.path,
        r.record({ ...(notification({ taskIds: ["agent-1"], status: "completed" }) as object), uuid: "n1" }),
      );
      await waitFor(() => events.length === 1, "terminal event");
      await sleep(150);
      expect(events).toEqual([
        {
          event: { kind: "terminal", work: CARRIED, outcome: "completed", evidence: expect.any(String) },
          threadId: "th_seed",
        },
      ]);
      expect(session.getLiveAsyncWork()).toEqual([]);
      expect(seededWith).toEqual(["th_seed"]);
    } finally {
      await session.stop();
    }
  });

  it("a seed that throws is reported and seeds nothing; capture stays healthy and consumes no carried evidence", async () => {
    const r = rollout("2");
    const events: AsyncWorkEvent[] = [];
    const errors: string[] = [];
    const session = start(r, {
      seedAsyncWork: () => {
        throw new Error("malformed carried row");
      },
      onAsyncWorkEvent: (event) => events.push(event),
      logError: (m) => errors.push(m),
    });
    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      expect(errors).toContain("cc-lhc continuity: carried work not seeded for thread th_seed: malformed carried row");
      expect(session.getLiveAsyncWork()).toEqual([]);
      appendFileSync(
        r.path,
        r.record({ ...(notification({ taskIds: ["agent-1"], status: "completed" }) as object), uuid: "n1" }),
      );
      await sleep(300);
      expect(events).toEqual([]);
      expect(session.isCaptureReady()).toBe(true);
    } finally {
      await session.stop();
    }
  });
});
