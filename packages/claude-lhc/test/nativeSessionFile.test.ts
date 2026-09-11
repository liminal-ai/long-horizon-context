import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  canonicalizeCwd,
  effectiveClaudeHome,
  encodeProjectKey,
  javaStringHash,
  nativeSessionPath,
  writeProjectedSession,
} from "../src/nativeSessionFile.ts";
import { projectView } from "../src/projection/project.ts";

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

// Independent of encodeProjectKey / javaStringHash in this file: pinned SDK Oy("hello")
// and So("/"+ "a"*250) from Agent SDK 0.3.170.
const PINNED_OY_HELLO = 99162322;
const PINNED_SO_LONG = `-${"a".repeat(199)}-feo44x`;

describe("nativeSessionFile", () => {
  test("qt: CLAUDE_CONFIG_DIR ?? ~/.claude, NFC, no trim", () => {
    expect(effectiveClaudeHome({})).toBe(join(homedir(), ".claude").normalize("NFC"));
    expect(effectiveClaudeHome({ CLAUDE_CONFIG_DIR: "/tmp/claude-home" })).toBe("/tmp/claude-home".normalize("NFC"));
    expect(effectiveClaudeHome({ CLAUDE_CONFIG_DIR: "  " })).toBe("  ".normalize("NFC"));
    expect(effectiveClaudeHome({ CLAUDE_CONFIG_DIR: "" })).toBe("".normalize("NFC"));
  });

  test("project key matches pinned So constants", () => {
    expect(encodeProjectKey("/srv/work/app")).toBe("-srv-work-app");
    expect(javaStringHash("hello")).toBe(PINNED_OY_HELLO);
    expect(encodeProjectKey(`/${"a".repeat(250)}`)).toBe(PINNED_SO_LONG);
  });

  test("canonicalizeCwd follows a directory link (junction on win32)", () => {
    const root = scratch("claude-lhc-cwd-");
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    if (process.platform === "win32") symlinkSync(real, link, "junction");
    else symlinkSync(real, link);
    expect(canonicalizeCwd(link)).toBe(realpathSync(link));
  });

  test("writeProjectedSession completes before returning and uses the UUID filename", async () => {
    const home = scratch("claude-lhc-home-");
    const cwd = scratch("claude-lhc-proj-");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const entries = projectView(
      {
        threadId: "t",
        entries: [
          { role: "user", content: "retain cedar-41", sourceMessages: [] },
          {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId: "toolu_1", toolName: "Read", arguments: { f: 1 } }],
            sourceMessages: [],
          },
          { role: "toolResult", toolCallId: "toolu_1", content: "cedar-41", sourceMessages: [] },
          { role: "assistant", content: [{ type: "text", text: "done" }], sourceMessages: [] },
        ],
      },
      { sessionId, cwd, version: "2.1.259", permissionMode: "default", model: "claude-sonnet-5" },
    );
    const dest = await writeProjectedSession({
      sessionId,
      cwd,
      entries,
      env: { CLAUDE_CONFIG_DIR: home },
    });
    expect(dest).toBe(nativeSessionPath({ sessionId, cwd, env: { CLAUDE_CONFIG_DIR: home } }));
    const body = readFileSync(dest, "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body.includes("cedar-41")).toBe(true);
    expect(body.includes("toolu_1")).toBe(true);
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(entries.length);
    expect(JSON.parse(lines[0]!).sessionId).toBe(sessionId);
  });

  test("write failure from a real filesystem error leaves no resume file", async () => {
    const home = scratch("claude-lhc-home-");
    const cwd = scratch("claude-lhc-proj-");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const dest = nativeSessionPath({ sessionId, cwd, env: { CLAUDE_CONFIG_DIR: home } });
    mkdirSync(join(home, "projects"), { recursive: true });
    writeFileSync(dirname(dest), "not-a-directory");
    await expect(
      writeProjectedSession({
        sessionId,
        cwd,
        entries: [{ type: "user", message: { role: "user", content: "x" } }],
        env: { CLAUDE_CONFIG_DIR: home },
      }),
    ).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });
});
