import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionThreadView } from "lhc";

import { writeRebuiltRollout, rebuiltRolloutPath } from "../../src/rollout/write-rebuilt.js";

const FIXED_WHEN = new Date(2026, 6, 7, 9, 30, 5); // local 2026-07-07T09-30-05

function view(): SessionThreadView {
  return {
    threadId: "th_test",
    entries: [
      { role: "user", content: "hello", sourceMessages: [] },
      { role: "assistant", content: [{ type: "text", text: "world" }], sourceMessages: [] },
    ],
  };
}

describe("rebuiltRolloutPath", () => {
  it("uses codex local date-dir + filename convention", () => {
    const path = rebuiltRolloutPath("/home/.codex", "abc-123", FIXED_WHEN);
    expect(path).toBe("/home/.codex/sessions/2026/07/07/rollout-2026-07-07T09-30-05-abc-123.jsonl");
  });
});

describe("writeRebuiltRollout", () => {
  it("writes an fsynced rollout whose meta ids match the filename uuid", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-rebuild-"));
    const result = await writeRebuiltRollout({ view: view(), cwd: "/w", codexHome, clock: () => FIXED_WHEN });

    expect(basename(result.rolloutPath)).toBe(`rollout-2026-07-07T09-30-05-${result.sessionId}.jsonl`);
    const lines = readFileSync(result.rolloutPath, "utf8").trimEnd().split("\n").map((raw) => JSON.parse(raw));
    expect(lines).toHaveLength(result.lineCount);
    const meta = lines[0];
    expect(meta.type).toBe("session_meta");
    expect(meta.payload.id).toBe(result.sessionId);
    expect(meta.payload.session_id).toBe(result.sessionId);
    // no receipt requested: every line is replayed prefix
    expect(result.replayedPrefixLines).toBe(result.lineCount);
    // nothing else created under codexHome (no sqlite, no session_index)
    expect(readdirSync(codexHome)).toEqual(["sessions"]);
  });

  it("appends receipt lines outside the replayed prefix and copies source provenance", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-rebuild-"));
    const sourcePath = join(codexHome, "source.jsonl");
    const sourceContent = JSON.stringify({
      timestamp: "t",
      type: "session_meta",
      payload: { id: "src-uuid", cli_version: "0.142.5", cwd: "/w", base_instructions: { text: "b" } },
    }) + "\n";
    writeFileSync(sourcePath, sourceContent);

    const result = await writeRebuiltRollout({
      view: view(),
      cwd: "/w",
      codexHome,
      clock: () => FIXED_WHEN,
      sourceRolloutPath: sourcePath,
      swapReceipt: { oldSessionId: "src-uuid", threadId: "th_test", op: "compact", tokensBefore: 100, tokensAfter: 10 },
    });

    const lines = readFileSync(result.rolloutPath, "utf8").trimEnd().split("\n").map((raw) => JSON.parse(raw));
    expect(result.lineCount).toBe(lines.length);
    expect(result.replayedPrefixLines).toBe(lines.length - 2); // receipt response_item + event twin are new history
    expect(lines[0].payload.forked_from_id).toBe("src-uuid");
    expect(lines[0].payload.cli_version).toBe("0.142.5");
    expect(lines[0].payload.base_instructions).toEqual({ text: "b" });
    const receipt = lines[lines.length - 2];
    expect(receipt.type).toBe("response_item");
    expect(receipt.payload.content[0].text).toContain("[runtime note] codex-lhc compact: thread th_test");
    // original source untouched
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
  });

  it("tolerates an unreadable source rollout", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-rebuild-"));
    const result = await writeRebuiltRollout({
      view: view(),
      cwd: "/w",
      codexHome,
      clock: () => FIXED_WHEN,
      sourceRolloutPath: join(codexHome, "missing.jsonl"),
    });
    const lines = readFileSync(result.rolloutPath, "utf8").trimEnd().split("\n").map((raw) => JSON.parse(raw));
    expect(lines[0].payload.forked_from_id).toBeUndefined();
  });
});
