import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireSessionOwner,
  SessionOwnershipConflictError,
  sessionOwnerPath,
} from "../../src/runtime/session-owner.js";
import { readProcessIdentityLinux } from "../../src/runtime/process-identity.js";

describe("session owner lease", () => {
  it("refuses a second live owner and permits ownership after release", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-"));
    const first = acquireSessionOwner("session-a", { home, token: "first" });
    expect(() => acquireSessionOwner("session-a", { home, token: "second" })).toThrow(
      SessionOwnershipConflictError,
    );
    first.release();
    const second = acquireSessionOwner("session-a", { home, token: "second" });
    second.release();
  });

  it("reclaims a lease only when OS identity proves it stale", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-stale-"));
    const first = acquireSessionOwner("session-a", { home, token: "first" });
    const stored = JSON.parse(readFileSync(first.path, "utf8")) as { processIdentity: { pid: number } };
    const actual = readProcessIdentityLinux(process.pid);
    expect(actual).not.toBeNull();
    let reads = 0;
    const second = acquireSessionOwner("session-a", {
      home,
      token: "second",
      readIdentity: (pid) => {
        reads += 1;
        // First read establishes the would-be new owner; the second checks the
        // stored owner and proves that identity stale.
        return reads === 1 ? actual : pid === stored.processIdentity.pid ? null : actual;
      },
    });
    second.release();
  });

  it("does not confuse two different sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-distinct-"));
    const a = acquireSessionOwner("session-a", { home });
    const b = acquireSessionOwner("session-b", { home });
    a.release();
    b.release();
  });

  it("never reclaims an ambiguous malformed ownership record", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-owner-malformed-"));
    const path = sessionOwnerPath("session-a", home);
    // Create the owners directory through an unrelated valid lease, then place
    // an ambiguous record at the target key.
    const seed = acquireSessionOwner("seed-session", { home });
    writeFileSync(path, "", { mode: 0o600 });
    expect(() => acquireSessionOwner("session-a", { home })).toThrow(SessionOwnershipConflictError);
    expect(readFileSync(path, "utf8")).toBe("");
    seed.release();
  });
});
