import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, MessageEventInput, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { CAPTURE_NOT_READY_REFUSAL } from "../../src/intake/session.js";
import { startCaptureSession } from "../../src/intake/session.js";
import { runCompactCommand } from "../../src/commands/compact.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { LifecycleSignal } from "../../src/observation/types.js";

async function waitFor(condition: () => boolean, label: string, attempts = 120): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout: ${label}`);
}

describe("initial replay barrier before ready", () => {
  it("refuses mutation until delayed initial intake settles; then ready + session_bound", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-init-ready-"));
    const cwd = "/work/init-ready";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const path = join(projectDir, `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        uuid: "u-init",
        sessionId: sid,
        message: { role: "user", content: "history line" },
      })}\n`,
    );

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const lifecycle: LifecycleSignal[] = [];
    let intakeCalls = 0;

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (s) => lifecycle.push(...s),
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_init", registryPath: join(projectsRoot, "registry.sqlite") } as ThreadRef,
      }),
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: ThreadRef, events: MessageEventInput[]) => {
              intakeCalls += 1;
              await gate;
              return { ok: true, value: { events: events.map(() => ({ outcome: "recorded" })) } };
            },
          },
        }) as unknown as Lhc,
    });

    try {
      // While initial intake is gated, capture must remain binding (not ready).
      await waitFor(() => intakeCalls >= 1, "intake started");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.isCaptureHealthy()).toBe(false);
      expect(lifecycle.some((s) => s.kind === "session_bound")).toBe(false);

      const early = await runCompactCommand("compact", {
        ...session.getCommandContext(),
        cwd,
        sourceRolloutPath: path,
        sourceSessionId: sid,
        isTurnOpen: () => false,
        isCaptureHealthy: () => session.isCaptureHealthy(),
        isCaptureReady: () => session.isCaptureReady(),
        getCaptureGeneration: () => session.getCaptureGeneration(),
      });
      expect(early.messages).toContain(CAPTURE_NOT_READY_REFUSAL);

      release();
      await waitFor(() => session.isCaptureReady(), "ready after initial replay");
      expect(lifecycle.filter((s) => s.kind === "session_bound")).toHaveLength(1);
      expect(session.getCaptureHealth().durableLineOffset).toBeGreaterThan(0);
    } finally {
      release();
      await session.stop();
      expect(session.getCaptureHealth().phase).toBe("closed");
    }
  });

  it("initial parse failure degrades without ever becoming ready or session_bound", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-init-fail-"));
    const cwd = "/work/init-fail";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const path = join(projectDir, `${sid}.jsonl`);
    writeFileSync(path, "{not-json\n");

    const lifecycle: LifecycleSignal[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (s) => lifecycle.push(...s),
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_f", registryPath: join(projectsRoot, "registry.sqlite") } as ThreadRef,
      }),
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async () => {},
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "degraded");
      expect(session.isCaptureReady()).toBe(false);
      expect(lifecycle.some((s) => s.kind === "session_bound")).toBe(false);
    } finally {
      await session.stop();
      expect(session.getCaptureHealth().phase).toBe("closed");
    }
  });
});
