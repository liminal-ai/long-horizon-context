// A process that exits cleanly mid-derivation hands its claim back (queued,
// expiry count unchanged); only a crash or kill leaves it to expire. Real
// child processes (fixtures/drain-runner.ts), since the handback runs from the
// process "exit" event.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, threads } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readDerivedForms,
  registerTestWorkHandlers,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";
import { o200k, withEstimator } from "./fixtures/tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "fixtures/drain-runner.ts");

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function seededThread(): Promise<string> {
  const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  const sdk = initLhc({ tokenFamily: "o200k", inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
  const sent = await withEstimator(o200k, () =>
    sdk.intakeStream.messageEvents({ filePath: created.value.filePath }, [validEvent("user_prompt")]),
  );
  if (!sent.ok) throw new Error(sent.error.reason);
  return created.value.filePath;
}

// Runs the drain runner until it exits (or, with killOnStart, SIGKILLs it once
// its handler starts). Returns the exit code/signal and stdout.
function runDrain(
  threadPath: string,
  opts: { leaseMs: number; exitAfterMs?: number; killOnStart?: boolean },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const config = { threadPath, leaseMs: opts.leaseMs, holdMs: 60_000, holdFrom: 1, exitAfterMs: opts.exitAfterMs };
  const child = spawn(process.execPath, ["--import", "tsx", runner, JSON.stringify(config)], {
    cwd: join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (opts.killOnStart === true && stdout.includes("HANDLER_START 1")) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function headRow(filePath: string): { status: string; claimed_at: string | null; payload: Record<string, unknown> } {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT status, claimed_at, payload FROM work_item ORDER BY rowid LIMIT 1`).get() as {
      status: string;
      claimed_at: string | null;
      payload: string;
    };
    return { status: row.status, claimed_at: row.claimed_at, payload: JSON.parse(row.payload) };
  } finally {
    db.close();
  }
}

async function drainInProcess(filePath: string, leaseMs = 1000) {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    tokenFamily: "o200k",
    inferenceCallbacks: double,
    mode: "manual",
    lease: { durationMs: leaseMs },
  });
  registerTestWorkHandlers(sdk, double);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
  return drained.value;
}

describe("claim handback on clean exit", () => {
  it("a clean exit mid-derivation leaves the item queued with no expiry; a later longer run completes it", async () => {
    const filePath = await seededThread();
    // A long lease: without the handback the claim would sit for a minute.
    const run = await runDrain(filePath, { leaseMs: 60_000, exitAfterMs: 150 });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/HANDLER_START 1 w-m1-prompt_smoothing-v1/);
    expect(run.stdout).toContain("CLEAN_EXIT");

    const handedBack = headRow(filePath);
    expect(handedBack.status).toBe("queued");
    expect(handedBack.claimed_at).toBeNull();
    expect(handedBack.payload.claimExpired).toBeUndefined();
    expect(handedBack.payload.claimAttempt).toBe(1);

    const report = await drainInProcess(filePath);
    expect(report.ran).toEqual([
      expect.objectContaining({ workItemId: "w-m1-prompt_smoothing-v1", disposition: "done" }),
    ]);
    const form = readDerivedForms(filePath).find((entry) => entry.derivationType === "smoothed_prompt");
    expect(form).toMatchObject({ state: "ready" });
  }, 60_000);

  it("a killed process leaves its claim to expire and it counts; a clean exit after it adds nothing", async () => {
    const filePath = await seededThread();
    const killed = await runDrain(filePath, { leaseMs: 50, killOnStart: true });
    expect(killed.signal).toBe("SIGKILL");
    expect(headRow(filePath)).toMatchObject({ status: "claimed", payload: { claimAttempt: 1 } });

    // The next process finds the claim expired (one count), reclaims it, then exits cleanly.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const clean = await runDrain(filePath, { leaseMs: 60_000, exitAfterMs: 150 });
    expect(clean.code).toBe(0);
    expect(headRow(filePath)).toMatchObject({
      status: "queued",
      claimed_at: null,
      payload: { claimAttempt: 2 },
    });

    // The kill's expiry mark is cleared by the clean exit, so it no longer counts.
    expect(headRow(filePath).payload.claimExpired).toBeUndefined();

    const report = await drainInProcess(filePath);
    expect(report.ran).toEqual([expect.objectContaining({ disposition: "done" })]);
  }, 60_000);
});
