// Scheduler wake-reference regressions (LIM-113 root fix).
//
// Defect: armWake() unconditionally unref'd the claim-expiry wake while
// drainSettled() counted that wake as unsettled and pushed a Promise waiter.
// A Promise waiter does not keep Node's event loop alive, so a process whose
// last live work was that waiter drained and exited 13 (unsettled top-level
// await) instead of settling. Loop-liveness is only observable at the process
// boundary, so each scenario runs in a child process (see
// fixtures/scheduler-wake-child.mts).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const childPath = fileURLToPath(new URL("./fixtures/scheduler-wake-child.mts", import.meta.url));

function runChild(scenario: string): { status: number | null; stdout: string; stderr: string; ms: number } {
  const started = Date.now();
  const result = spawnSync(tsxBin, [childPath, scenario], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
}

describe("scheduler wake keeps the loop alive exactly when someone awaits settlement", () => {
  it("waiter-before-arm: a waiter present at arm time settles after claim expiry (no exit 13)", () => {
    const r = runChild("waiter-before-arm");
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("SETTLED");
    // Settlement requires outliving the 1.5s foreign claim.
    expect(r.ms).toBeGreaterThan(1_000);
  }, 40_000);

  it("waiter-after-arm: drainSettled references an already-armed idle wake (no exit 13)", () => {
    const r = runChild("waiter-after-arm");
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("SETTLED");
    expect(r.ms).toBeGreaterThan(1_000);
  }, 40_000);

  it("idle-unobserved: an armed far-future wake with no waiters never blocks process exit", () => {
    const r = runChild("idle-unobserved");
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("IDLE-EXIT");
    // The claim expires in 60s; a referenced wake would hold the process.
    expect(r.ms).toBeLessThan(15_000);
  }, 40_000);
});
