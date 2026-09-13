import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc } from "lhc";
import { describe, expect, it } from "vitest";
import { startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

async function waitFor(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

describe("capture stop: each step reports its own failure and closed is always applied", () => {
  it("a failing pending-summary read logs the step by name, does not throw, and still closes the capture", async () => {
    const prior = process.env.CC_LHC_NO_INFERENCE;
    delete process.env.CC_LHC_NO_INFERENCE;
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-stop-steps-"));
    const cwd = "/work/stop-steps";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    writeFileSync(
      join(projectDir, `${sid}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "seed-u", sessionId: sid, message: { role: "user", content: "seed" } })}\n`,
    );
    const errors: string[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: (m) => errors.push(m),
      launchThread: { threadId: "th_stop_steps", createdAtLaunch: true },
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: unknown, events: Array<{ idempotencyKey: string }>) => ({
              ok: true,
              value: { events: events.map((e) => ({ idempotencyKey: e.idempotencyKey, outcome: "recorded" as const })) },
            }),
          },
          inspect: {
            overview: async () => {
              throw new TypeError("inspect.overview requires an SDK initialised with tokenFamily");
            },
          },
        }) as unknown as Lhc,
    });
    try {
      await waitFor(() => session.isCaptureReady(), "initial ready");
      await expect(session.stop()).resolves.toBeUndefined();
      expect(session.getCaptureHealth().phase).toBe("closed");
      const stepLine = errors.find((m) => m.includes("pending-summary count for stats failed"));
      expect(stepLine).toBeDefined();
      expect(stepLine).toContain("tokenFamily");
      expect(errors.some((m) => m.includes("drain"))).toBe(false);
    } finally {
      if (prior !== undefined) process.env.CC_LHC_NO_INFERENCE = prior;
    }
  });
});
