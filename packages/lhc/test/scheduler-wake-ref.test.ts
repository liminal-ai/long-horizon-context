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
    expect(r.ms).toBeLessThan(15_000);
  }, 40_000);
});
