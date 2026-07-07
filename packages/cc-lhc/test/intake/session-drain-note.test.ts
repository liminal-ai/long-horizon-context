// Doctrine test: pending derivation work at capture stop (drain not settled)
// reaches the injected log sink and the thread record as a runtime_note —
// and never the terminal (console.error is the old default sink; it must not
// fire when a logError is supplied, which run.ts always does).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lhc, ThreadRef } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAIN_NOT_SETTLED_MESSAGE, startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("drain-not-settled at capture stop", () => {
  const savedNoInference = process.env.CC_LHC_NO_INFERENCE;

  afterEach(() => {
    if (savedNoInference === undefined) delete process.env.CC_LHC_NO_INFERENCE;
    else process.env.CC_LHC_NO_INFERENCE = savedNoInference;
    vi.restoreAllMocks();
  });

  it("logs to the injected sink and records a runtime_note; nothing hits the terminal", async () => {
    delete process.env.CC_LHC_NO_INFERENCE;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const tmp = mkdtempSync(join(tmpdir(), "cc-lhc-drain-"));
    const projectsRoot = join(tmp, "projects");
    const cwd = "/work/drain-note";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "session.jsonl");
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } })}\n`,
    );

    const recordedEvents: unknown[][] = [];
    const fakeSdk = {
      // never settles: forces the cap timeout
      drainSettled: () => new Promise<void>(() => {}),
      intakeStream: {
        messageEvents: async (_ref: unknown, events: unknown[]) => {
          recordedEvents.push(events);
          return { ok: true, value: { events: [] } };
        },
      },
    } as unknown as Lhc;

    const logged: string[] = [];
    let sdkBuilt = false;
    const session = startCaptureSession({
      cwd,
      startedAt: new Date(Date.now() - 60_000),
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(tmp, "lineage.sqlite"),
      registryPath: join(tmp, "registry.sqlite"),
      log: () => {},
      logError: (message) => logged.push(message),
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_drain", registryPath: join(tmp, "registry.sqlite") } as ThreadRef,
      }),
      initSdkFn: () => {
        sdkBuilt = true;
        return fakeSdk;
      },
      flushBatchFn: async () => {},
      drainSettledCapMs: 50,
    });

    await waitFor(() => sdkBuilt, "capture to attach");
    await session.stop();

    expect(logged.some((line) => line.includes(DRAIN_NOT_SETTLED_MESSAGE))).toBe(true);
    const note = recordedEvents
      .flat()
      .find((event) => (event as { eventKind?: string }).eventKind === "runtime_note") as
      | { payload: { text: string }; idempotencyKey: string }
      | undefined;
    expect(note).toBeDefined();
    expect(note!.payload.text).toContain(DRAIN_NOT_SETTLED_MESSAGE);
    expect(note!.idempotencyKey).toMatch(/^cc-lhc:drain-not-settled:/);
    expect(consoleError).not.toHaveBeenCalled();
  }, 15_000);
});
