/**
 * The summary worker: one Agent SDK query per derivation with none of Claude
 * Code's framing (no settings files, tools, MCP, skills; one turn; empty cwd),
 * Lee's system prompt, and only the auth part of the user's settings.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { SUMMARY_WORKER_SYSTEM_PROMPT, summaryWorkerAuthSettings as userAuthSettings } from "lhc";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createSummaryWorkerModelCall,
  SUMMARY_WORKER_PROVIDER,
  summaryWorkerAssignments,
} from "../src/summaryWorker.ts";

let config = "";
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "claude-lhc-worker-cfg-"));
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

type Seen = { prompt: string; options: Options; cwdEntries: string[] };

function fakeQuery(seen: Seen[], reply: Record<string, unknown> | Error): typeof query {
  return (({ prompt, options }: { prompt: string; options: Options }) => {
    seen.push({ prompt, options, cwdEntries: readdirSync(options.cwd!) });
    return (async function* () {
      if (reply instanceof Error) throw reply;
      yield { type: "system", subtype: "init" };
      yield { type: "result", ...reply };
    })();
  }) as unknown as typeof query;
}

const ok = { subtype: "success", is_error: false, result: "the smoothed prompt" };
const input = (messages: Array<{ role: "system" | "user"; content: string }>) => ({
  provider: SUMMARY_WORKER_PROVIDER,
  model: "sonnet",
  messages,
});

describe("summary worker", () => {
  test("runs one query with no settings files, tools, MCP or extra turns, in an empty directory removed afterwards", async () => {
    const seen: Seen[] = [];
    const call = createSummaryWorkerModelCall({
      claudeBin: "/bin/claude",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    });
    expect(await call(input([{ role: "user", content: "rewrite: fix the validator" }]))).toEqual({
      ok: true,
      text: "the smoothed prompt",
    });
    const { prompt, options, cwdEntries } = seen[0]!;
    expect(prompt).toBe("rewrite: fix the validator");
    expect(options).toMatchObject({
      systemPrompt: SUMMARY_WORKER_SYSTEM_PROMPT,
      settingSources: [],
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
      thinking: { type: "adaptive", display: "omitted" },
      persistSession: false,
      model: "sonnet",
      pathToClaudeCodeExecutable: "/bin/claude",
    });
    expect(options.settings).toBeUndefined();
    expect(options.env).toMatchObject({ DISABLE_AUTO_COMPACT: "1", CLAUDE_CONFIG_DIR: config });
    expect(cwdEntries).toEqual([]);
    expect(existsSync(options.cwd!)).toBe(false);
  });

  test("always uses Lee's system prompt, 504 bytes; a template's system text leads the prompt", async () => {
    expect(Buffer.byteLength(SUMMARY_WORKER_SYSTEM_PROMPT)).toBe(504);
    expect(SUMMARY_WORKER_SYSTEM_PROMPT.startsWith("Your role is to smooth or summarize conversation excerpts")).toBe(
      true,
    );
    const seen: Seen[] = [];
    const call = createSummaryWorkerModelCall({
      claudeBin: "c",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    });
    await call(
      input([
        { role: "system", content: "Summarize this tool response." },
        { role: "user", content: "raw" },
      ]),
    );
    expect(seen[0]!.options.systemPrompt).toBe(SUMMARY_WORKER_SYSTEM_PROMPT);
    expect(seen[0]!.prompt).toBe("Summarize this tool response.\n\nraw");
  });

  test("carries only the auth part of the user's settings", async () => {
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
    const expected = {
      env: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "tok" },
      apiKeyHelper: "/bin/key",
    };
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toEqual(expected);
    const seen: Seen[] = [];
    await createSummaryWorkerModelCall({
      claudeBin: "c",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    })(input([{ role: "user", content: "x" }]));
    expect(seen[0]!.options.settings).toEqual(expected);
  });

  test("no settings file, or one without auth, carries nothing", () => {
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
    writeFileSync(join(config, "settings.json"), JSON.stringify({ env: { FOO: "1" }, outputStyle: "x" }));
    expect(userAuthSettings({ CLAUDE_CONFIG_DIR: config })).toBeNull();
  });

  test("failures map to the core's kinds and never throw", async () => {
    const call = (reply: Record<string, unknown> | Error) =>
      createSummaryWorkerModelCall({ claudeBin: "c", env: { CLAUDE_CONFIG_DIR: config }, run: fakeQuery([], reply) })(
        input([{ role: "user", content: "x" }]),
      );
    expect(
      await call({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
    ).toMatchObject({
      ok: false,
      kind: "auth",
    });
    expect(await call({ subtype: "error_max_turns", is_error: true })).toMatchObject({ ok: false, kind: "other" });
    expect(await call(new Error("429 rate limited"))).toMatchObject({ ok: false, kind: "rate_limit" });
  });

  test("times out by aborting the query", async () => {
    const hang = (({ options }: { options: Options }) =>
      (async function* () {
        await new Promise((_, reject) =>
          options.abortController!.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      })()) as unknown as typeof query;
    const result = await createSummaryWorkerModelCall({
      claudeBin: "c",
      env: { CLAUDE_CONFIG_DIR: config },
      timeoutMs: 50,
      run: hang,
    })(input([{ role: "user", content: "x" }]));
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
  });

  test("auth settings come from the session env's home, not this process's", async () => {
    const childHome = join(config, "child-home");
    mkdirSync(join(childHome, ".claude"), { recursive: true });
    writeFileSync(join(childHome, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/child/key" }));
    const seen: Seen[] = [];
    await createSummaryWorkerModelCall({
      claudeBin: "c",
      env: { HOME: childHome, USERPROFILE: childHome },
      run: fakeQuery(seen, ok),
    })(input([{ role: "user", content: "x" }]));
    expect(seen[0]!.options.settings).toEqual({ apiKeyHelper: "/child/key" });
    expect(seen[0]!.options.env).toMatchObject({ HOME: childHome });
  });

  test("a failed scratch setup returns a failure and gives its slot back", async () => {
    const seen: Seen[] = [];
    const call = createSummaryWorkerModelCall({
      claudeBin: "c",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    });
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
    const tmpVars = ["TMPDIR", "TEMP", "TMP"] as const;
    const priorTmp = tmpVars.map((k) => process.env[k]);
    for (const k of tmpVars) process.env[k] = join(config, "no-such-tmp");
    try {
      for (let i = 0; i < 4; i += 1) {
        expect(await call(input([{ role: "user", content: "x" }]))).toMatchObject({
          ok: false,
          message: expect.stringContaining("ENOENT"),
        });
      }
    } finally {
      tmpVars.forEach((k, i) => {
        const prior = priorTmp[i];
        if (prior === undefined) delete process.env[k];
        else process.env[k] = prior;
      });
    }
    const after = await Promise.race([
      call(input([{ role: "user", content: "x" }])),
      new Promise((r) => setTimeout(() => r("stuck"), 5_000)),
    ]);
    expect(after).toEqual({ ok: true, text: "the smoothed prompt" });
    expect(seen).toHaveLength(1);
  });

  test("an explicit relative claude binary is resolved from the caller's cwd", async () => {
    const seen: Seen[] = [];
    await createSummaryWorkerModelCall({
      claudeBin: "./bin/claude",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    })(input([{ role: "user", content: "x" }]));
    expect(seen[0]!.options.pathToClaudeCodeExecutable).toBe(join(process.cwd(), "bin", "claude"));
    await createSummaryWorkerModelCall({
      claudeBin: "claude",
      env: { CLAUDE_CONFIG_DIR: config },
      run: fakeQuery(seen, ok),
    })(input([{ role: "user", content: "x" }]));
    expect(seen[1]!.options.pathToClaudeCodeExecutable).toBe("claude");
  });

  test("serves the core's derivation assignments under its own provider, model unchanged", () => {
    const assignments = summaryWorkerAssignments();
    expect(Object.keys(assignments).sort()).toEqual([
      "chunk_summary_brief",
      "detailed_turn_compression",
      "smoothed_prompt",
      "tool_result_summary",
    ]);
    for (const a of Object.values(assignments))
      expect(a).toMatchObject({ provider: SUMMARY_WORKER_PROVIDER, model: "sonnet" });
  });
});
