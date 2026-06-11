// Story 1 (Epic 02), process-boundary suite: the architecture-risk tests
// that in-process fixtures cannot prove. TC-1.3 SIGKILLs a real drain in the
// reclaim window (between an item's claim and its complete) and shows a later
// drain finishes the queue with nothing lost and nothing duplicated. TC-1.4
// proves cross-process claim exclusion through the durable lease alone — the
// second process is the real spawned CLI. The parity rows prove `lhc work
// drain` through dist/cli.js, including DD-11 provider resolution. Runs
// under verify-all only (LHC_PROCESS_SUITE=1).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  createSdk,
  intakeStream,
  queueDetail,
  resolveNamedProvider,
  threads,
  type DrainReport,
  type OpResult,
} from "../src/index.js";
import {
  createProviderDouble,
  openRaw,
  readDerivedForms,
  registerTestWorkHandlers,
  validEvent,
} from "./fixtures/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pkgRoot, "dist", "cli.js");
const runnerPath = path.join(pkgRoot, "test", "fixtures", "drain-runner.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBinary(
  args: string[],
  env?: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface RunnerHandle {
  child: ChildProcess;
  stdout: () => string;
  waitForLine: (prefix: string) => Promise<string>;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// Spawns the drain runner under tsx — a real second process draining through
// the real SDK surface, no in-process shortcuts.
function spawnRunner(config: {
  threadPath: string;
  leaseMs: number;
  holdMs: number;
  holdFrom: number;
}): RunnerHandle {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", runnerPath, JSON.stringify(config)],
    { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffered = "";
  let errBuffered = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    errBuffered += chunk;
  });
  return {
    child,
    stdout: () => buffered,
    waitForLine: (prefix: string) =>
      new Promise<string>((resolve, reject) => {
        const check = (): void => {
          const line = buffered.split("\n").find((candidate) => candidate.startsWith(prefix));
          if (line !== undefined) {
            child.stdout?.off("data", check);
            resolve(line);
          }
        };
        child.stdout?.on("data", check);
        child.on("exit", () =>
          reject(
            new Error(`runner exited before "${prefix}"; stdout=${buffered} stderr=${errBuffered}`),
          ),
        );
        check();
      }),
    waitForExit: () =>
      new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      }),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-drain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function newThreadFile(name: string): Promise<string> {
  const filePath = path.join(dir, `${name}.sqlite`);
  const created = await threads.newThread({
    filePath,
    registryPath: path.join(dir, "registry.sqlite"),
  });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

function rawLiveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

function rawDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

describe("TC-1.3 / AC-1.3 (architecture risk): queued and claimed work survives SIGKILL mid-drain", () => {
  it("kills the drain between item 2's claim and complete; a later drain reclaims and finishes with nothing lost or duplicated", async () => {
    const threadPath = await newThreadFile("kill");
    const seeded = await intakeStream.messageEvents({ filePath: threadPath }, [
      validEvent("user_prompt"),
      validEvent("tool_call"),
      validEvent("tool_result"),
      validEvent("turn_end"),
    ]);
    expect(seeded.ok).toBe(true);
    // 4 items since Epic 02 Story 2: tool_call queues its summary
    // (sanctioned amendment — was 3).
    expect(rawLiveCount(threadPath)).toBe(4);

    // Runner: item 1 completes normally; from item 2 on, the handler holds —
    // so the HANDLER_START 2 marker means item 1's complete landed and item
    // 2 sits claimed inside the reclaim window.
    const runner = spawnRunner({ threadPath, leaseMs: 250, holdMs: 8000, holdFrom: 2 });
    await runner.waitForLine("HANDLER_START 2");

    // Pre-kill read of item 1's landed artifact — the byte-compare baseline.
    const preKill = readDerivedForms(threadPath).find(
      (form) => form.subjectId === "m1" && form.form === "smoothed_prompt",
    );
    expect(preKill?.state).toBe("ready");

    runner.child.kill("SIGKILL");
    const exit = await runner.waitForExit();
    expect(exit.signal).toBe("SIGKILL");

    // The kill landed in the reclaim window: item 2 is still claimed in the
    // record, item 3 untouched, and no artifact beyond item 1's is visible
    // as ready (NFR: a killed drain leaves no partial artifact).
    const afterKill = rawDetail(threadPath);
    expect(afterKill.map((row) => [row.workItemId, row.status])).toEqual([
      ["w-m2-tool_call_summary-v1", "claimed"],
      ["w-m3-tool_result_summary-v1", "queued"],
      ["w-t1-turn_derivation-v1", "queued"],
    ]);
    const readyAfterKill = readDerivedForms(threadPath).filter((f) => f.state === "ready");
    expect(readyAfterKill.map((f) => `${f.subjectId}/${f.form}`)).toEqual(["m1/smoothed_prompt"]);

    // Let the orphaned lease expire, then drain from a fresh process-side
    // handle: the expired claim is reclaimed with attempts incremented — the
    // crash made visible in the report.
    await sleep(450);
    const double = createProviderDouble();
    const sdk = createSdk({
      provider: double,
      mode: "manual",
      lease: { durationMs: 250 },
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });
    registerTestWorkHandlers(sdk, double);
    const drained = await sdk.work.drain({ filePath: threadPath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m2-tool_call_summary-v1", "done"],
      ["w-m3-tool_result_summary-v1", "done"],
      ["w-t1-turn_derivation-v1", "done"],
    ]);
    expect(drained.value.ran[0]?.attempts).toBe(1); // the reclaim, counted

    // Item 1's artifact is byte-unchanged against the pre-kill read; every
    // unfinished item ran exactly once; no duplicate rows anywhere.
    const finalForms = readDerivedForms(threadPath);
    const postKill = finalForms.find(
      (form) => form.subjectId === "m1" && form.form === "smoothed_prompt",
    );
    expect(postKill).toEqual(preKill);
    expect(finalForms).toHaveLength(5);
    expect(finalForms.every((form) => form.state === "ready")).toBe(true);
    expect(rawLiveCount(threadPath)).toBe(0);
  }, 30000);
});

describe("TC-1.4 / AC-1.4 (architecture risk): two drains cannot interleave — the lease is the only coordination", () => {
  it("a second process's drain against a live claim reports in_flight, runs nothing, and never skips ahead", async () => {
    const threadPath = await newThreadFile("hold");
    const seeded = await intakeStream.messageEvents({ filePath: threadPath }, [
      validEvent("user_prompt"),
      validEvent("turn_end"),
    ]);
    expect(seeded.ok).toBe(true);
    expect(rawLiveCount(threadPath)).toBe(2);

    // Process A claims the head under a 10s lease and holds mid-handler.
    const runner = spawnRunner({ threadPath, leaseMs: 10000, holdMs: 2500, holdFrom: 1 });
    await runner.waitForLine("HANDLER_START 1");

    // Process B: the real spawned CLI, against A's live claim.
    const second = runBinary(["work", "drain", "--file-path", threadPath], {
      LHC_PROVIDER: "deterministic",
    });
    expect(second.status).toBe(0);
    const parsed = JSON.parse(second.stdout) as OpResult<DrainReport>;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.stoppedBecause).toBe("in_flight");
    expect(parsed.value.ran).toEqual([]);
    expect(parsed.value.remaining).toBe(2);

    // The skip-ahead proof: the queued item behind the live head was not
    // claimed by B — exclusion without this is half the test.
    const detail = rawDetail(threadPath);
    expect(detail[1]).toMatchObject({
      workItemId: "w-t1-turn_derivation-v1",
      status: "queued",
      attempts: 0,
    });
    expect(detail[1]?.claimedAt).toBeUndefined();

    // A finishes its drain normally.
    const exit = await runner.waitForExit();
    expect(exit.code).toBe(0);
    expect(runner.stdout()).toContain("DRAIN_DONE");
    expect(rawLiveCount(threadPath)).toBe(0);
    expect(readDerivedForms(threadPath).every((form) => form.state === "ready")).toBe(true);
  }, 30000);
});

describe("CLI parity: lhc work drain through the spawned binary (DD-11 provider resolution)", () => {
  it("report JSON matches the SDK shape on twin threads; exits 0 with work", async () => {
    const batch = [validEvent("user_prompt"), validEvent("turn_end")];
    const cliThread = await newThreadFile("cli-twin");
    const sdkThread = await newThreadFile("sdk-twin");
    for (const filePath of [cliThread, sdkThread]) {
      const seeded = await intakeStream.messageEvents(
        { filePath },
        batch.map((event, index) => ({ ...event, idempotencyKey: `twin-${index}` })),
      );
      expect(seeded.ok).toBe(true);
    }

    const viaCli = runBinary(["work", "drain", "--file-path", cliThread], {
      LHC_PROVIDER: "deterministic",
    });
    expect(viaCli.status).toBe(0);
    const cliReport = JSON.parse(viaCli.stdout) as OpResult<DrainReport>;
    expect(cliReport.ok).toBe(true);

    // The SDK twin drains through the same production assembly the CLI uses:
    // registry provider, manual mode, the production domain handler tables
    // (messages registered in Story 2) — so the two reports must be
    // identical, shape and content.
    const provider = resolveNamedProvider("deterministic");
    if (provider === undefined) throw new Error("deterministic provider not registered");
    const sdk = createSdk({ provider, mode: "manual" });
    const viaSdk = await sdk.work.drain({ filePath: sdkThread });
    expect(viaSdk.ok).toBe(true);
    if (!cliReport.ok || !viaSdk.ok) return;
    expect(cliReport.value).toEqual(viaSdk.value);
  });

  it("exits 0 on an empty queue and 1 on a missing thread", async () => {
    const emptyThread = await newThreadFile("empty");
    const empty = runBinary(["work", "drain", "--file-path", emptyThread], {
      LHC_PROVIDER: "deterministic",
    });
    expect(empty.status).toBe(0);
    const emptyReport = JSON.parse(empty.stdout) as OpResult<DrainReport>;
    expect(emptyReport.ok).toBe(true);
    if (!emptyReport.ok) return;
    expect(emptyReport.value).toEqual({ ran: [], stoppedBecause: "empty", remaining: 0 });

    const missing = runBinary(
      ["work", "drain", "--file-path", path.join(dir, "nope.sqlite")],
      { LHC_PROVIDER: "deterministic" },
    );
    expect(missing.status).toBe(1);
    const missingResult = JSON.parse(missing.stdout) as { ok: boolean; error: { code: string } };
    expect(missingResult.ok).toBe(false);
    expect(missingResult.error.code).toBe("thread_not_found");
  });

  it("refuses to drain without a resolvable provider, naming the flag and env var (DD-11)", async () => {
    const threadPath = await newThreadFile("no-provider");
    const result = runBinary(["work", "drain", "--file-path", threadPath], {
      LHC_PROVIDER: undefined,
    });
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; reason: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("provider_not_configured");
    expect(parsed.error.reason).toContain("--provider");
    expect(parsed.error.reason).toContain("LHC_PROVIDER");

    const unknown = runBinary(
      ["work", "drain", "--file-path", threadPath, "--provider", "no-such-provider"],
      {},
    );
    expect(unknown.status).toBe(1);
    const unknownParsed = JSON.parse(unknown.stdout) as { ok: boolean; error: { code: string } };
    expect(unknownParsed.error.code).toBe("provider_not_configured");
  });
});
