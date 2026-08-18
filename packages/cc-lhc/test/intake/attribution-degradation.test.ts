import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";
import { runCompactCommand } from "../../src/commands/compact.js";
import { CAPTURE_DEGRADED_REFUSAL } from "../../src/commands/dispatch.js";
import { startCaptureSession } from "../../src/intake/session.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout: ${label}`);
}

describe("deterministic attribution + sticky degradation", () => {
  it("two simultaneous captures in one cwd never cross-bind", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-dual-"));
    const cwd = "/work/dual-sessions";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeFileSync(
      join(projectDir, `${a}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "ua", sessionId: a, message: { role: "user", content: "from-a" } })}\n`,
    );
    writeFileSync(
      join(projectDir, `${b}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "ub", sessionId: b, message: { role: "user", content: "from-b" } })}\n`,
    );

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    const mkSession = (sid: string, sink: string[]) =>
      startCaptureSession({
        cwd,
        expectedSession: { sessionId: sid, source: "fresh" },
        noInference: true,
        discoverDeps: { projectsRoot, pollMs: 20 },
        lineageDbPath: join(projectsRoot, `lineage-${sid}.sqlite`),
        registryPath: join(projectsRoot, `registry-${sid}.sqlite`),
        log: () => {},
        logError: () => {},
        launchThread: { threadId: `th_${sid.slice(0, 4)}`, createdAtLaunch: true },
        initSdkFn: () =>
          ({
            intakeStream: {
              messageEvents: async (_ref: ThreadRef, events: Array<{ payload?: { text?: string } }>) => {
                for (const event of events) {
                  if (event.payload?.text !== undefined) sink.push(event.payload.text);
                }
                return {
                  ok: true,
                  value: {
                    events: events.map((e) => ({
                      idempotencyKey: (e as { idempotencyKey: string }).idempotencyKey,
                      outcome: "recorded" as const,
                    })),
                  },
                };
              },
            },
          }) as unknown as Lhc,
      });

    const sessionA = mkSession(a, eventsA);
    const sessionB = mkSession(b, eventsB);

    try {
      await waitFor(() => sessionA.isCaptureReady(), "A ready");
      await waitFor(() => sessionB.isCaptureReady(), "B ready");
      await waitFor(() => eventsA.includes("from-a"), "session A intake");
      await waitFor(() => eventsB.includes("from-b"), "session B intake");
      expect(eventsA).not.toContain("from-b");
      expect(eventsB).not.toContain("from-a");
    } finally {
      await sessionA.stop();
      await sessionB.stop();
    }
  });

  it("session mismatch degrades once; compact refuses; restart is the re-arm path", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-deg-"));
    const cwd = "/work/degrade";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const path = join(projectDir, `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u0", sessionId: sid, message: { role: "user", content: "ok" } })}\n`,
    );

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
      onLifecycle: (signals) => lifecycle.push(...signals),
      launchThread: { threadId: "th_d", createdAtLaunch: true },
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: unknown, events: Array<{ idempotencyKey: string }> = []) => ({
              ok: true as const,
              value: {
                events: events.map((e) => ({ idempotencyKey: e.idempotencyKey, outcome: "recorded" as const })),
              },
            }),
          },
        }) as unknown as Lhc,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "bind ready");
      const bound = lifecycle.filter((s) => s.kind === "session_bound");
      expect(bound).toHaveLength(1);

      appendFileSync(
        path,
        `${JSON.stringify({
          type: "user",
          uuid: "bad",
          sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          message: { role: "user", content: "foreign" },
        })}\n`,
      );
      await waitFor(() => !session.isCaptureHealthy(), "degrade on mismatch");

      const mismatchFacts = lifecycle.filter((s) => s.kind === "session_mismatch_observed");
      const degradeFacts = lifecycle.filter(
        (s) => s.kind === "capture_degraded" && s.reason.startsWith("session_mismatch:"),
      );
      expect(mismatchFacts).toHaveLength(1);
      expect(degradeFacts).toHaveLength(1);

      const compact = await runCompactCommand("compact", {
        stats: session.stats,
        sdk: session.getCommandContext().sdk,
        threadRef: session.getCommandContext().threadRef,
        cwd,
        sourceRolloutPath: path,
        sourceSessionId: sid,
        isTurnOpen: () => false,
        isCaptureHealthy: () => session.isCaptureHealthy(),
        isCaptureReady: () => session.isCaptureReady(),
        getCaptureGeneration: () => session.getCaptureGeneration(),
        captureDegraded: true,
        capturePhase: "degraded",
      });
      expect(compact.messages).toContain(CAPTURE_DEGRADED_REFUSAL);
    } finally {
      await session.stop();
    }

    // Restart over a clean expected rollout (restart = re-arm) starts healthy gen 2.
    const cleanPath = join(projectDir, `${sid}.jsonl`);
    writeFileSync(
      cleanPath,
      `${JSON.stringify({ type: "user", uuid: "u-clean", sessionId: sid, message: { role: "user", content: "clean" } })}\n`,
    );
    const restarted = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      generationSeed: 2,
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_d", createdAtLaunch: true },
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: unknown, events: Array<{ idempotencyKey: string }> = []) => ({
              ok: true as const,
              value: {
                events: events.map((e) => ({ idempotencyKey: e.idempotencyKey, outcome: "recorded" as const })),
              },
            }),
          },
        }) as unknown as Lhc,
    });
    try {
      await waitFor(() => restarted.isCaptureReady(), "restart ready");
      expect(restarted.getCaptureGeneration()).toBe(2);
      expect(restarted.isCaptureHealthy()).toBe(true);
      // Persistent foreign evidence degrades again when observed.
      appendFileSync(
        cleanPath,
        `${JSON.stringify({
          type: "user",
          uuid: "bad2",
          sessionId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          message: { role: "user", content: "still foreign" },
        })}\n`,
      );
      await waitFor(() => !restarted.isCaptureHealthy(), "restart re-degrade");
    } finally {
      await restarted.stop();
    }
  });

  it("lifecycle subscriber exception does not poison intake", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-sub-"));
    const cwd = "/work/sub";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const path = join(projectDir, `${sid}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u0", sessionId: sid, message: { role: "user", content: "hello" } })}\n`,
    );
    const intake: string[] = [];
    let throws = 0;
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: () => {
        throws += 1;
        if (throws === 1) throw new Error("subscriber boom");
      },
      launchThread: { threadId: "th_s", createdAtLaunch: true },
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: ThreadRef, events: Array<{ payload?: { text?: string } }>) => {
              for (const e of events) {
                if (e.payload?.text) intake.push(e.payload.text);
              }
              return {
                ok: true,
                value: {
                  events: events.map((e) => ({
                    idempotencyKey: (e as { idempotencyKey: string }).idempotencyKey,
                    outcome: "recorded" as const,
                  })),
                },
              };
            },
          },
        }) as unknown as Lhc,
    });
    try {
      await waitFor(() => intake.includes("hello") || session.getCaptureHealth().phase === "degraded", "progress");
      appendFileSync(
        path,
        `${JSON.stringify({ type: "user", uuid: "u1", sessionId: sid, message: { role: "user", content: "second" } })}\n`,
      );
      await waitFor(() => intake.includes("second") || intake.includes("hello"), "intake continued");
      expect(intake.length).toBeGreaterThan(0);
    } finally {
      await session.stop();
    }
  });

  it("parse failure degrades capture", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-parse-"));
    const cwd = "/work/parse";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "11111111-1111-1111-1111-111111111111";
    const path = join(projectDir, `${sid}.jsonl`);
    writeFileSync(path, "{not json\n");
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_p", createdAtLaunch: true },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async () => {},
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded" || session.stats.parseFailures > 0, "parse");
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "degraded phase");
      expect(session.isCaptureHealthy()).toBe(false);
    } finally {
      await session.stop();
    }
  });

  it("rebuilt handoff binds expected rebuilt session id from path", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-handoff-"));
    const cwd = "/work/handoff";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const newId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const path = join(projectDir, `${newId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "h1", sessionId: newId, message: { role: "user", content: "handoff" } })}\n`,
    );

    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: newId, source: "rebuilt_handoff" },
      knownRolloutPath: path,
      // Explicit none: this unit only proves path bind; full rebuild fence is
      // covered by rebuilt-prefix-resume tests with verified boundaries.
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_h", createdAtLaunch: false },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async () => {},
    });
    try {
      await waitFor(() => session.getRolloutInfo().sessionId === newId, "handoff bind");
      await waitFor(() => session.isCaptureReady(), "handoff ready");
      expect(session.getRolloutInfo().path).toBe(path);
    } finally {
      await session.stop();
    }
  });
});
