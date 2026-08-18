/**
 * R15 / LIM-93 concurrency evidence, across real processes — same-process
 * callers cannot interleave, because node:sqlite is synchronous.
 *
 * Two properties are under test, both of which would break if the registry
 * were built differently:
 *  - a reader can never see a current-alias pointer whose alias is not
 *    registered to that thread (it would, if register and advance were
 *    separate commits);
 *  - resolve returns the alias's thread and that thread's current alias from
 *    one state (it would not, if the pair were read in two statements while a
 *    concurrent writer advanced between them).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threads } from "../src/index.js";
import { type TempStore, tempStore } from "./fixtures/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerFixture = join(here, "fixtures/registry-alias-multiproc-worker.ts");
const tsxBin = join(here, "../node_modules/.bin/tsx");

interface WorkerSpec {
  mode: "advance" | "resolve" | "claim";
  registryPath: string;
  threadId: string;
  rounds: number;
  workerId: string;
  seedAlias?: string;
  sharedAlias?: string;
}

interface WorkerReport {
  mode: string;
  workerId: string;
  registered: string[];
  violations: string[];
  failures: string[];
  observations: number;
  claimed: { ok: boolean; code?: string };
}

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Every worker imports and signals READY first; the parent releases them all
// with one barrier file so they hit the registry simultaneously.
async function runWorkers(specs: WorkerSpec[]): Promise<WorkerReport[]> {
  const goPath = join(store.dir, "go");
  const children = specs.map((spec, index) => {
    const outPath = join(store.dir, `out-${index}.json`);
    const readyPath = join(store.dir, `ready-${index}`);
    const child = spawn(tsxBin, [workerFixture, JSON.stringify(spec), outPath, readyPath, goPath], {
      cwd: join(here, ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    return { spec, outPath, readyPath, child, exited, stderr: () => stderr };
  });

  try {
    await waitFor(() => children.every((c) => existsSync(c.readyPath)), "workers READY");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(goPath, "go\n", "utf8");
    await Promise.all(children.map((c) => c.exited));
  } finally {
    for (const c of children) c.child.kill("SIGKILL");
  }

  return children.map((c) => {
    if (!existsSync(c.outPath)) throw new Error(`worker ${c.spec.workerId} wrote no report; stderr=${c.stderr()}`);
    return JSON.parse(readFileSync(c.outPath, "utf8")) as WorkerReport;
  });
}

describe("registry alias map under concurrent processes", () => {
  it("concurrent advancement and resolution never expose an inconsistent thread/current pair", async () => {
    const created = await threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.value.threadId;

    const seedAlias = "claude-code:seed";
    const seeded = await threads.registerCurrentAlias({ alias: seedAlias, threadId, registryPath: store.registryPath });
    expect(seeded.ok).toBe(true);

    const rounds = 60;
    const specs: WorkerSpec[] = [
      ...["a", "b", "c"].map(
        (workerId): WorkerSpec => ({
          mode: "advance",
          registryPath: store.registryPath,
          threadId,
          rounds,
          workerId,
        }),
      ),
      ...["r1", "r2", "r3"].map(
        (workerId): WorkerSpec => ({
          mode: "resolve",
          registryPath: store.registryPath,
          threadId,
          rounds,
          workerId,
          seedAlias,
        }),
      ),
    ];

    const reports = await runWorkers(specs);

    for (const report of reports) {
      expect(report.violations, `worker ${report.workerId} violations`).toEqual([]);
      expect(report.failures, `worker ${report.workerId} failures`).toEqual([]);
    }

    const readers = reports.filter((report) => report.mode === "resolve");
    const totalObservations = readers.reduce((sum, report) => sum + report.observations, 0);
    expect(totalObservations).toBeGreaterThanOrEqual(readers.length * rounds);

    const advanced = reports.filter((report) => report.mode === "advance").flatMap((report) => report.registered);
    expect(advanced).toHaveLength(3 * rounds);

    // Every alias any writer registered still names this thread, and the
    // pointer that survived the race is one of them.
    for (const alias of advanced) {
      const resolved = await threads.resolveAlias({ alias, registryPath: store.registryPath });
      expect(resolved.ok, `alias ${alias} lost its binding`).toBe(true);
      if (resolved.ok) expect(resolved.value.threadId).toBe(threadId);
    }

    const current = await threads.currentAlias({ threadId, registryPath: store.registryPath });
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.currentAlias).not.toBeNull();
      expect([...advanced, seedAlias]).toContain(current.value.currentAlias);
    }
  }, 120_000);

  it("concurrent processes racing one alias against different threads produce exactly one binding", async () => {
    const threadIds = ["th_aaaaaaaaaaaaaaa1", "th_aaaaaaaaaaaaaaa2", "th_aaaaaaaaaaaaaaa3", "th_aaaaaaaaaaaaaaa4"];
    const sharedAlias = "claude-code:contested";
    const specs: WorkerSpec[] = threadIds.map((threadId, index) => ({
      mode: "claim",
      registryPath: store.registryPath,
      threadId,
      rounds: 1,
      workerId: `claim-${index}`,
      sharedAlias,
    }));

    const reports = await runWorkers(specs);

    const winners = reports.filter((report) => report.claimed.ok);
    const losers = reports.filter((report) => !report.claimed.ok);
    expect(winners).toHaveLength(1);
    for (const loser of losers) expect(loser.claimed.code).toBe("alias_bound_to_other_thread");

    const winnerIndex = reports.findIndex((report) => report.claimed.ok);
    const winnerThreadId = threadIds[winnerIndex]!;

    const resolved = await threads.resolveAlias({ alias: sharedAlias, registryPath: store.registryPath });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.threadId).toBe(winnerThreadId);
      expect(resolved.value.currentAlias).toBe(sharedAlias);
    }

    // A losing thread never acquired a pointer to an alias it does not hold.
    for (const threadId of threadIds.filter((id) => id !== winnerThreadId)) {
      const current = await threads.currentAlias({ threadId, registryPath: store.registryPath });
      expect(current.ok && current.value.currentAlias).toBeNull();
    }
  }, 120_000);
});
