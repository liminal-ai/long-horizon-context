import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyDescriptorRolloutBinding } from "../../src/retrieval/rollout-bind.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

describe("verifyDescriptorRolloutBinding", () => {
  it("nonexistent refuses", () => {
    const r = verifyDescriptorRolloutBinding({
      sessionId: SID,
      rolloutPath: join(tmpdir(), "no-such-rollout.jsonl"),
    });
    expect(r.ok).toBe(false);
  });

  it("basename mismatch refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, "wrong.jsonl");
    writeFileSync(path, line({ type: "user", sessionId: SID }));
    const r = verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/basename/);
  });

  it("unreadable refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, line({ type: "user", sessionId: SID }));
    chmodSync(path, 0o000);
    try {
      const r = verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path });
      expect(r.ok).toBe(false);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("malformed JSON refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, "not-json\n");
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(false);
  });

  it("conflicting camelCase refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, line({ type: "user", sessionId: "other-session-id-xxxx" }));
    const r = verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/conflict/);
  });

  it("matching camelCase accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, line({ type: "user", sessionId: SID, message: { role: "user", content: "hi" } }));
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(true);
  });

  it("matching snake-only accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, line({ type: "user", session_id: SID }));
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(true);
  });

  it("dual current/origin (camel current, snake origin) accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(
      path,
      line({
        type: "user",
        sessionId: SID,
        session_id: "origin-session-id-yyyyyyyyyyyy",
      }),
    );
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(true);
  });

  it("swapped dual fields (camel is origin wrong current) refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    // camel is current; if camel is wrong, conflict even if snake matches expected
    writeFileSync(
      path,
      line({
        type: "user",
        sessionId: "wrong-current-session-zzzz",
        session_id: SID,
      }),
    );
    const r = verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path });
    expect(r.ok).toBe(false);
  });

  it("empty / no session fields refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-rb-"));
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, "");
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(false);
    writeFileSync(path, line({ type: "file-history-snapshot", message: {} }));
    expect(verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path }).ok).toBe(false);
  });

  it("internally consistent nonexistent path (basename only) still refuses", () => {
    // The old bug: basename(desc.rolloutPath)===sessionId with no file I/O.
    const path = join("/tmp/definitely-missing-cc-lhc", `${SID}.jsonl`);
    const r = verifyDescriptorRolloutBinding({ sessionId: SID, rolloutPath: path });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing|unreadable/);
  });
});
