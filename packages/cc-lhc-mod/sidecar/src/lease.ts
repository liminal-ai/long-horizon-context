import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Lease = { held: true; release: () => void } | { held: false; ownerPid: number };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerOf(path: string): number | undefined {
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One live Claude Code process records a thread. The owner is the Claude
 * process, not the sidecar, so a sidecar that restarts under the same Claude
 * (a hot reload, a crash) keeps the lease, and a dead owner's file is taken over.
 */
export function acquireLease(home: string, threadId: string, pid: number): Lease {
  const dir = join(home, "owners");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${threadId}.json`);
  const body = JSON.stringify({ pid, threadId, acquiredAt: new Date().toISOString() });
  const held: Lease = { held: true, release: () => ownerOf(path) === pid && unlinkSync(path) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      return held;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = ownerOf(path);
    if (owner === pid) return held;
    if (owner !== undefined && isAlive(owner)) return { held: false, ownerPid: owner };
    unlinkSync(path);
  }
  return { held: false, ownerPid: ownerOf(path) ?? 0 };
}
