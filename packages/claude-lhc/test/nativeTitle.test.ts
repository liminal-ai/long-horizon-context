import { renameSession } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { nativeSessionPath, writeProjectedSession } from "../src/nativeSessionFile.ts";
import { nativeLhcTitle } from "../src/session.ts";

const temps: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("native LHC title", () => {
  test("label is [LHC] plus the logical thread id", () => {
    expect(nativeLhcTitle("th_abc")).toBe("[LHC] th_abc");
  });

  test("renameSession appends a custom-title line on a projected UUID", async () => {
    const home = scratch("claude-lhc-title-home-");
    const cwd = scratch("claude-lhc-title-cwd-");
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const threadId = "th_label_1";
    const dest = await writeProjectedSession({
      sessionId,
      cwd,
      entries: [{ type: "user", message: { role: "user", content: "seed" } }],
      env: { CLAUDE_CONFIG_DIR: home },
    });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      await renameSession(sessionId, nativeLhcTitle(threadId), { dir: cwd });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    expect(dest).toBe(nativeSessionPath({ sessionId, cwd, env: { CLAUDE_CONFIG_DIR: home } }));
    const body = readFileSync(dest, "utf8");
    const lines = body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; customTitle?: string; sessionId?: string });
    const titleLine = lines.find((line) => line.type === "custom-title");
    expect(titleLine).toMatchObject({
      type: "custom-title",
      customTitle: "[LHC] th_label_1",
      sessionId,
    });
  });
});
