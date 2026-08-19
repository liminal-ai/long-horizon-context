import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ProbeProcessIdentity, ProcessIdentity } from "../../src/runtime/process-identity.js";
import {
  acquireThreadOwner,
  ThreadOwnerGuardError,
  ThreadOwnerLivenessError,
  ThreadOwnershipConflictError,
  threadOwnerGuardPath,
  threadOwnerPath,
} from "../../src/runtime/thread-owner.js";
import { aliveResult, indeterminateResult, notFoundResult, selfIdentity, selfOnlyProbe } from "../helpers/identity.js";
import { tsxCommand } from "../helpers/tsx.js";

function storedOwnerJson(threadId: string, token: string, identity: ProcessIdentity): string {
  return `${JSON.stringify({
    version: 1,
    threadId,
    token,
    processIdentity: identity,
    acquiredAt: new Date().toISOString(),
  })}\n`;
}

/** A pid that cannot be this test process; identity is obviously foreign. */
const STALE_IDENTITY: ProcessIdentity = {
  pid: 999_999_901,
  bootId: "long-dead-boot-id",
  starttime: "1",
};

describe("thread owner lease", () => {
  it("refuses a second live owner and permits ownership after release", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-"));
    const first = acquireThreadOwner("th_a", { home, token: "first" });
    expect(() => acquireThreadOwner("th_a", { home, token: "second" })).toThrow(ThreadOwnershipConflictError);
    first.release();
    const second = acquireThreadOwner("th_a", { home, token: "second" });
    second.release();
  });

  it("reclaims a lease when the kernel proves the owner not_found", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-stale-"));
    const first = acquireThreadOwner("th_a", { home, token: "first" });
    const stored = JSON.parse(readFileSync(first.path, "utf8")) as { processIdentity: { pid: number } };
    const actual = selfIdentity();
    let reads = 0;
    const second = acquireThreadOwner("th_a", {
      home,
      token: "second",
      readIdentity: (pid: number) => {
        reads += 1;
        // First read establishes the would-be new owner; the second checks the
        // stored owner and proves that identity dead.
        return reads === 1 ? aliveResult(actual) : notFoundResult(pid);
      },
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(stored.processIdentity.pid).toBe(process.pid);
    second.release();
  });

  it("reclaims a lease on exact live-identity mismatch (PID reuse)", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-reuse-"));
    const actual = selfIdentity();
    const first = acquireThreadOwner("th_a", { home, token: "first" });
    // The stored owner pid is now occupied by a *different* incarnation:
    // same pid, different starttime.
    const reused = { ...actual, starttime: String(Number(actual.starttime) + 7) };
    let selfRead = false;
    const second = acquireThreadOwner("th_a", {
      home,
      token: "second",
      readIdentity: () => {
        if (!selfRead) {
          selfRead = true;
          return aliveResult(actual);
        }
        return aliveResult(reused);
      },
    });
    const now = JSON.parse(readFileSync(second.path, "utf8")) as { token: string };
    expect(now.token).toBe("second");
    second.release();
    void first;
  });

  it("indeterminate liveness fails closed: throws and leaves the lease untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-indet-"));
    const actual = selfIdentity();
    const first = acquireThreadOwner("th_a", { home, token: "first" });
    const before = readFileSync(first.path, "utf8");
    let selfRead = false;
    expect(() =>
      acquireThreadOwner("th_a", {
        home,
        token: "second",
        readIdentity: () => {
          if (!selfRead) {
            selfRead = true;
            return aliveResult(actual);
          }
          return indeterminateResult("access_denied: kernel refused the query");
        },
      }),
    ).toThrow(ThreadOwnerLivenessError);
    // Fail closed: the existing lease must not be deleted, rotated, or replaced.
    expect(readFileSync(first.path, "utf8")).toBe(before);
    first.release();
  });

  it("acquisition fails with an actionable error when own identity is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-noaddon-"));
    expect(() =>
      acquireThreadOwner("th_a", {
        home,
        readIdentity: () => indeterminateResult("addon_unavailable: no prebuilt artifact; run build:native"),
      }),
    ).toThrow(/cannot establish process identity for thread ownership.*build:native/);
  });

  it("does not confuse two different sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-distinct-"));
    const a = acquireThreadOwner("th_a", { home });
    const b = acquireThreadOwner("th_b", { home });
    a.release();
    b.release();
  });

  it("never reclaims an ambiguous malformed ownership record", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-malformed-"));
    const path = threadOwnerPath("th_a", home);
    // Create the owners directory through an unrelated valid lease, then place
    // an ambiguous record at the target key.
    const seed = acquireThreadOwner("seed-session", { home });
    writeFileSync(path, "", { mode: 0o600 });
    expect(() => acquireThreadOwner("th_a", { home })).toThrow(ThreadOwnershipConflictError);
    expect(readFileSync(path, "utf8")).toBe("");
    seed.release();
  });
});

describe("thread owner acquisition guard (TOCTOU serialization)", () => {
  it("deterministic interleaving: an acquirer arriving mid-reclaim fails at the guard, touching nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-toctou-"));
    const path = threadOwnerPath("th_a", home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const staleJson = storedOwnerJson("th_a", "stale", STALE_IDENTITY);
    writeFileSync(path, staleJson, { mode: 0o600 });

    const self = selfIdentity();
    let bError: unknown = null;
    let bProbeCalls = 0;
    let interleaved = false;
    // A's probe of the stale owner runs inside A's guarded transaction, at
    // exactly the point where the unguarded implementation raced: after
    // observing the stale lease, before deleting it. Interleave B's whole
    // acquisition attempt right there.
    const aProbe: ProbeProcessIdentity = (pid: number) => {
      if (pid === process.pid) return aliveResult(self);
      interleaved = true;
      try {
        acquireThreadOwner("th_a", {
          home,
          token: "b",
          readIdentity: (p: number) => {
            bProbeCalls += 1;
            return p === process.pid ? aliveResult(self) : notFoundResult(p);
          },
        });
      } catch (cause) {
        bError = cause;
      }
      return notFoundResult(pid);
    };

    const a = acquireThreadOwner("th_a", { home, token: "a", readIdentity: aProbe });
    expect(interleaved).toBe(true);
    // B failed closed at the guard: it read its own identity once and never
    // inspected, deleted, or published a lease.
    expect(bError).toBeInstanceOf(ThreadOwnerGuardError);
    expect(bProbeCalls).toBe(1);
    // A's reclaim won; its lease is intact (B could not delete it).
    const now = JSON.parse(readFileSync(a.path, "utf8")) as { token: string };
    expect(now.token).toBe("a");
    a.release();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(threadOwnerGuardPath("th_a", home))).toBe(false);
  });

  it("orphaned guard fails closed with an actionable error and is never auto-deleted", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-orphan-"));
    const guard = threadOwnerGuardPath("th_a", home);
    mkdirSync(guard, { recursive: true, mode: 0o700 });
    const path = threadOwnerPath("th_a", home);
    const staleJson = storedOwnerJson("th_a", "stale", STALE_IDENTITY);
    writeFileSync(path, staleJson, { mode: 0o600 });

    const probe = selfOnlyProbe();
    let caught: unknown = null;
    try {
      acquireThreadOwner("th_a", { home, readIdentity: probe });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ThreadOwnerGuardError);
    expect(String(caught)).toMatch(/never\s+removes it automatically/);
    expect(String(caught)).toContain(guard);
    // Fail closed: guard still standing, stale lease untouched.
    expect(existsSync(guard)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(staleJson);

    // Operator recovery: remove the guard, then normal crashed-owner reclaim
    // (stale identity → not_found) works.
    rmdirSync(guard);
    const lease = acquireThreadOwner("th_a", { home, readIdentity: probe });
    expect(JSON.parse(readFileSync(lease.path, "utf8"))).toMatchObject({ token: lease.token });
    lease.release();
  });

  it("guard is released after success, conflict, and fail-closed liveness errors", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-guardrel-"));
    const guard = threadOwnerGuardPath("th_a", home);
    const self = selfIdentity();

    const lease = acquireThreadOwner("th_a", { home, readIdentity: selfOnlyProbe(self) });
    expect(existsSync(guard)).toBe(false);

    expect(() => acquireThreadOwner("th_a", { home, readIdentity: selfOnlyProbe(self) })).toThrow(
      ThreadOwnershipConflictError,
    );
    expect(existsSync(guard)).toBe(false);

    let reads = 0;
    expect(() =>
      acquireThreadOwner("th_a", {
        home,
        readIdentity: () => {
          reads += 1;
          return reads === 1 ? aliveResult(self) : indeterminateResult("access_denied: probe blocked");
        },
      }),
    ).toThrow(ThreadOwnerLivenessError);
    expect(existsSync(guard)).toBe(false);
    lease.release();
  });

  it("release verifies the token under the guard and never deletes another owner's record", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-reltoken-"));
    const lease = acquireThreadOwner("th_a", { home, readIdentity: selfOnlyProbe() });
    const foreign = storedOwnerJson("th_a", "someone-else", STALE_IDENTITY);
    writeFileSync(lease.path, foreign, { mode: 0o600 });
    lease.release();
    expect(readFileSync(lease.path, "utf8")).toBe(foreign);
  });

  it("release fails open (no delete) while the guard is contended, and works after", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-relguard-"));
    const lease = acquireThreadOwner("th_a", { home, readIdentity: selfOnlyProbe() });
    const guard = threadOwnerGuardPath("th_a", home);
    mkdirSync(guard, { mode: 0o700 });
    lease.release();
    expect(existsSync(lease.path)).toBe(true);
    rmdirSync(guard);
    lease.release();
    expect(existsSync(lease.path)).toBe(false);
  });

  it("concurrent workers: exactly one acquisition wins, losers fail closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-race-"));
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = join(here, "../fixtures/thread-owner-race-worker.ts");
    const tsx = tsxCommand(worker);
    const N = 8;

    const children: ChildProcess[] = [];
    const outcomes = new Map<number, string>();
    const done: Array<Promise<void>> = [];
    for (let i = 0; i < N; i += 1) {
      const child = spawn(tsx.command, tsx.args, {
        env: { ...process.env, RACE_HOME: home, RACE_THREAD: "th_race" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      done.push(
        new Promise<void>((resolve, reject) => {
          let buffer = "";
          const timer = setTimeout(() => reject(new Error(`worker ${i} produced no outcome`)), 20_000);
          child.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const line = buffer.split("\n", 1)[0];
            if (line !== undefined && buffer.includes("\n")) {
              clearTimeout(timer);
              outcomes.set(i, line.trim());
              resolve();
            }
          });
          child.once("error", (cause) => {
            clearTimeout(timer);
            reject(cause);
          });
        }),
      );
    }

    try {
      await Promise.all(done);
      const results = [...outcomes.values()];
      const wins = results.filter((r) => r.startsWith("WON "));
      const losses = results.filter((r) => r.startsWith("LOST "));
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(N - 1);
      for (const loss of losses) {
        expect(["LOST ThreadOwnershipConflictError", "LOST ThreadOwnerGuardError"]).toContain(loss);
      }
      // The surviving lease belongs to the single winner, and no guard leaked.
      const winnerToken = wins[0]!.slice("WON ".length);
      const stored = JSON.parse(readFileSync(threadOwnerPath("th_race", home), "utf8")) as { token: string };
      expect(stored.token).toBe(winnerToken);
      expect(existsSync(threadOwnerGuardPath("th_race", home))).toBe(false);
    } finally {
      // Cooperative shutdown: tsx runs the worker as a grandchild, so killing
      // the spawned wrapper would orphan the real process and leak its stdio
      // pipes. The stop file makes the winner exit itself; then wait for full
      // stdio teardown ("close", not just "exit") so no handles leak.
      writeFileSync(join(home, "race-stop"), "", { mode: 0o600 });
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              const settle = (): void => {
                child.stdout?.destroy();
                child.removeAllListeners();
                resolve();
              };
              if (child.exitCode !== null || child.signalCode !== null) settle();
              else child.once("close", settle);
            }),
        ),
      );
    }
  }, 30_000);
});
