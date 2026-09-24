/**
 * The shared summary-worker setup and the core `claude -p` lane that uses it:
 * Lee's prompt, no framing (settings files, tools, MCP, extra turns), an empty
 * scratch cwd removed afterwards, no side traffic, and only the auth part of
 * the user's settings carried over.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClaudeCliModelCall } from "../src/shared-tech/inference-claude-cli.ts";
import {
  SUMMARY_WORKER_CLI_ARGS,
  SUMMARY_WORKER_SYSTEM_PROMPT,
  summaryWorkerAuthSettings,
  summaryWorkerCliLaunch,
} from "../src/shared-tech/summary-worker.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lhc-summary-worker-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in `claude` that records its argv, cwd (and its entries) and env, then prints "ok". */
function standIn(): { bin: string; record: string } {
  const bin = join(dir, "claude");
  const record = join(dir, "record.json");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), stdin,
    traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, config: process.env.CLAUDE_CONFIG_DIR,
  }));
  process.stdout.write("ok");
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, record };
}

describe("summary worker", () => {
  test("Lee's system prompt is 504 bytes; the flags strip settings, tools, MCP and extra turns", () => {
    expect(Buffer.byteLength(SUMMARY_WORKER_SYSTEM_PROMPT)).toBe(504);
    expect(SUMMARY_WORKER_SYSTEM_PROMPT.startsWith("Your role is to smooth or summarize conversation excerpts")).toBe(
      true,
    );
    expect(SUMMARY_WORKER_CLI_ARGS).toEqual([
      "--setting-sources",
      "",
      "--tools",
      "",
      "--strict-mcp-config",
      "--max-turns",
      "1",
    ]);
  });

  test("carries only the auth part of the user's settings", () => {
    const config = join(dir, "config");
    rmSync(config, { force: true, recursive: true });
    expect(summaryWorkerAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
    mkdirSync(config);
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://proxy",
          ANTHROPIC_AUTH_TOKEN: "tok",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
          FOO: "1",
        },
        apiKeyHelper: "/bin/key",
        outputStyle: "Explanatory",
        permissions: { allow: ["Edit"] },
        hooks: { Stop: [] },
      }),
    );
    const auth = { env: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "tok" }, apiKeyHelper: "/bin/key" };
    expect(summaryWorkerAuthSettings({ CLAUDE_CONFIG_DIR: config })).toEqual(auth);
    const launch = summaryWorkerCliLaunch({ model: "sonnet", systemPrompt: "S", env: { CLAUDE_CONFIG_DIR: config } });
    launch.removeCwd();
    expect(launch.args).toEqual([
      "-p",
      "--no-session-persistence",
      ...SUMMARY_WORKER_CLI_ARGS,
      "--settings",
      JSON.stringify(auth),
      "--model",
      "sonnet",
      "--system-prompt",
      "S",
    ]);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ env: { FOO: "1" }, outputStyle: "x" }));
    expect(summaryWorkerAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
  });

  test("the core claude -p lane runs the stripped worker in an empty scratch dir, removed afterwards", async () => {
    const { bin, record } = standIn();
    const config = join(dir, "no-config");
    const call = createClaudeCliModelCall({ binary: bin, env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    const result = await call({
      provider: "claude-cli",
      model: "sonnet",
      messages: [{ role: "user", content: "fix the validator" }],
    });
    expect(result).toEqual({ ok: true, text: "ok" });
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      argv: string[];
      cwd: string;
      entries: string[];
      stdin: string;
      traffic: string;
      config: string;
    };
    expect(seen.argv).toEqual([
      "-p",
      "--no-session-persistence",
      ...SUMMARY_WORKER_CLI_ARGS,
      "--model",
      "sonnet",
      "--system-prompt",
      SUMMARY_WORKER_SYSTEM_PROMPT,
    ]);
    expect(seen.stdin).toBe("fix the validator");
    expect(seen.entries).toEqual([]);
    expect(seen.cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(seen.traffic).toBe("1");
    expect(seen.config).toBe(config);
  });

  test("a template's own system message replaces Lee's prompt on the core lane", async () => {
    const { bin, record } = standIn();
    const call = createClaudeCliModelCall({
      binary: bin,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "none") },
    });
    await call({
      provider: "claude-cli",
      model: "sonnet",
      messages: [
        { role: "system", content: "Summarize this tool response." },
        { role: "user", content: "raw" },
      ],
    });
    const { argv } = JSON.parse(readFileSync(record, "utf8")) as { argv: string[] };
    expect(argv.at(-1)).toBe("Summarize this tool response.");
  });
});
