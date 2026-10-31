import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type LhcQuery, type LhcQueryOptions, query } from "../src/index.ts";

const sdkShaped: typeof sdkQuery = query;
void sdkShaped;

const SIDECAR = fileURLToPath(new URL("../src/sidecar.ts", import.meta.url));
const FAKE_SDK = fileURLToPath(new URL("./support/fakeSdkHooks.mjs", import.meta.url));

let dir = "";
const open: LhcQuery[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-client-"));
});
afterEach(() => {
  for (const q of open.splice(0)) q.close();
  rmSync(dir, { recursive: true, force: true });
});

class Input implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  push(text: string): void {
    this.#items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) yield next;
      else if (this.#ended) return;
      else await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }
}

function start(prompt: string | AsyncIterable<SDKUserMessage>, extra: LhcQueryOptions = {}) {
  const stderr: string[] = [];
  const q = query({
    prompt,
    options: {
      cwd: dir,
      model: "claude-sonnet-5",
      env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
      stderr: (data) => stderr.push(data),
      ...extra,
      lhc: {
        home: join(dir, "lhc"),
        compact: { trigger: 700_000, target: 140_000 },
        spawn: {
          command: process.execPath,
          args: ["--import", "tsx", "--import", FAKE_SDK, SIDECAR],
          env: { ...process.env, CLAUDE_LHC_NO_INFERENCE: "1" },
        },
        ...extra.lhc,
      },
    },
  });
  open.push(q);
  return { q, stderr };
}

async function untilResult(q: LhcQuery): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = [];
  for (;;) {
    const next = await q.next();
    if (next.done) throw new Error(`stream ended before a result: ${JSON.stringify(seen)}`);
    seen.push(next.value);
    if (next.value.type === "result") return seen;
  }
}

const replyText = (messages: SDKMessage[]): string =>
  messages
    .flatMap((message) => (message.type === "assistant" ? message.message.content : []))
    .map((block) => ("text" in block ? block.text : ""))
    .join("");

describe("query through the sidecar", () => {
  test("streams the SDK messages for each prompt the input yields", async () => {
    const input = new Input();
    const { q } = start(input);
    input.push("hello");
    const first = await untilResult(q);
    expect(first[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(replyText(first)).toBe("echo: hello");
    input.push("again");
    expect(replyText(await untilResult(q))).toBe("echo: again");
    q.close();
    expect(await q.next()).toEqual({ done: true, value: undefined });
  });

  test("a string prompt runs one turn and ends the stream", async () => {
    const { q } = start("just once");
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(replyText(messages)).toBe("echo: just once");
  });

  test("an input that ends closes the sidecar after its last turn", async () => {
    const input = new Input();
    const { q } = start(input);
    input.push("last");
    input.end();
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(replyText(messages)).toBe("echo: last");
  });

  test("an input that yields several prompts and ends gets every reply", async () => {
    const prompts = (async function* () {
      for (const text of ["one", "slow:two", "three"])
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as const;
    })();
    const { q } = start(prompts);
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(replyText(messages)).toBe("echo: oneecho: slow:twoecho: three");
  });

  test("a large final result reaches the client before the sidecar exits", async () => {
    const { q } = start("big:1800000");
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(replyText(messages)).toHaveLength(1_800_000);
    expect(messages.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  test("a /compact deferred into an open turn gets its own result after the compact", async () => {
    const prompts = (async function* () {
      for (const text of ["slow:one", "/compact"])
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as const;
    })();
    const { q } = start(prompts);
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(replyText(messages)).toBe("echo: slow:one");
    const results = messages.flatMap((m, i) => (m.type === "result" ? [i] : []));
    const boundary = messages.findIndex((m) => m.type === "system" && m.subtype === "compact_boundary");
    expect(results).toHaveLength(2);
    expect(boundary).toBeGreaterThan(-1);
    expect(results[1]).toBeGreaterThan(boundary);
  });

  test("a /compact sent after a held prompt runs after that prompt's turn", async () => {
    const prompts = (async function* () {
      for (const text of ["slow:one", "/compact", "two", "/compact"])
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as const;
    })();
    const { q } = start(prompts);
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    const boundaries = messages.flatMap((m, i) => (m.type === "system" && m.subtype === "compact_boundary" ? [i] : []));
    const two = messages.findIndex((m) => m.type === "assistant" && replyText([m]) === "echo: two");
    const results = messages.flatMap((m, i) => (m.type === "result" ? [i] : []));
    expect(results).toHaveLength(4);
    expect(boundaries).toHaveLength(2);
    expect(two).toBeGreaterThan(boundaries[0] ?? -1);
    expect(boundaries[1]).toBeGreaterThan(two);
    expect(results[2]).toBeGreaterThan(two);
    expect(results[3]).toBeGreaterThan(boundaries[1] ?? -1);
  });

  test("two /compact inputs sent during a turn each get a result", async () => {
    const prompts = (async function* () {
      for (const text of ["slow:one", "/compact", "/compact"])
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as const;
    })();
    const { q } = start(prompts);
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(messages.filter((m) => m.type === "result")).toHaveLength(3);
  });

  test("a /compact sent right after a prompt runs after that turn and before the next prompt", async () => {
    const prompts = (async function* () {
      for (const text of ["one", "/compact", "two"])
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as const;
    })();
    const { q } = start(prompts);
    const messages: SDKMessage[] = [];
    for await (const message of q) messages.push(message);
    expect(replyText(messages)).toBe("echo: oneecho: two");
    const boundary = messages.findIndex((m) => m.type === "system" && m.subtype === "compact_boundary");
    const second = messages.findIndex((m) => m.type === "assistant" && replyText([m]) === "echo: two");
    expect(boundary).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(boundary);
    expect(messages.filter((m) => m.type === "result")).toHaveLength(3);
  });

  test("an input that throws fails the stream with its error", async () => {
    const prompts = (async function* () {
      yield { type: "user", message: { role: "user", content: "first" }, parent_tool_use_id: null } as const;
      throw new Error("the host's input broke");
    })();
    const { q } = start(prompts);
    await expect(
      (async () => {
        for await (const _ of q);
      })(),
    ).rejects.toThrow("the host's input broke");
  });

  test("streamInput feeds more prompts into the open session", async () => {
    const input = new Input();
    const { q } = start(input);
    await q.streamInput(
      (async function* () {
        yield { type: "user", message: { role: "user", content: "streamed" }, parent_tool_use_id: null } as const;
      })(),
    );
    expect(replyText(await untilResult(q))).toBe("echo: streamed");
  });

  test("canUseTool answers the sidecar's permission request", async () => {
    const input = new Input();
    const asked: string[] = [];
    const { q } = start(input, {
      canUseTool: async (toolName, toolInput) => {
        asked.push(`${toolName} ${JSON.stringify(toolInput)}`);
        return { behavior: "deny", message: "not here" };
      },
    });
    input.push("tool:ls");
    expect(replyText(await untilResult(q))).toBe("tool decision: deny");
    expect(asked).toEqual(['Bash {"command":"ls"}']);
  });

  test("a restart resumes the thread by its first session id", async () => {
    const first = randomUUID();
    const input = new Input();
    const { q } = start(input, { sessionId: first });
    input.push("remember");
    await untilResult(q);
    q.close();
    await q.next();

    const again = new Input();
    const { q: resumed, stderr } = start(again, { resume: first });
    again.push("recall");
    const messages = await untilResult(resumed);
    expect(replyText(messages)).toBe("echo: recall");
    expect(messages[0]?.session_id).not.toBe(first);
    expect(stderr.join("")).toContain(`via ${first} as generation`);
  });
});

describe("controls", () => {
  test("forward and forward-and-replay rows reach the SDK Query with their arguments", async () => {
    const { q } = start(new Input());
    expect(await q.supportedModels()).toEqual({ method: "supportedModels", args: [] });
    expect(await q.readFile("notes.md", { maxBytes: 10 } as never)).toEqual({
      method: "readFile",
      args: ["notes.md", { maxBytes: 10 }],
    });
    expect(await q.setModel("claude-opus-5")).toEqual({ method: "setModel", args: ["claude-opus-5"] });
    expect(await q.setPermissionMode("plan")).toEqual({ method: "setPermissionMode", args: ["plan"] });
  });

  test("setCompactPolicy is answered by the sidecar", async () => {
    const { q, stderr } = start(new Input());
    await q.setCompactPolicy({ trigger: 600_000, target: 120_000 });
    expect(stderr.join("")).toContain("compact policy set on thread: trigger 600000 target 120000");
    await expect(q.setCompactPolicy({ trigger: 10, target: 20 })).rejects.toThrow("setCompactPolicy params.policy");
  });

  test("refused rows fail by name and the session keeps answering", async () => {
    const { q } = start(new Input());
    await expect(q.rewindFiles("msg")).rejects.toThrow("rewindFiles is refused");
    await expect(q.reinitialize()).rejects.toThrow("reinitialize is refused");
    expect(await q.mcpServerStatus()).toEqual({ method: "mcpServerStatus", args: [] });
  });

  test("close ends the stream and refuses later controls", async () => {
    const { q } = start(new Input());
    await q.supportedAgents();
    q.close();
    expect(await q.next()).toEqual({ done: true, value: undefined });
    await expect(q.interrupt()).rejects.toThrow("claude-lhc sidecar is closed");
  });

  test("abortController closes the query", async () => {
    const abortController = new AbortController();
    const { q } = start(new Input(), { abortController });
    await q.supportedCommands();
    abortController.abort();
    expect(await q.next()).toEqual({ done: true, value: undefined });
  });
});

describe("start options", () => {
  test("an abortController aborted before query() starts nothing", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const marker = join(dir, "spawned");
    const { q } = start("never sent", {
      abortController,
      lhc: {
        home: join(dir, "lhc"),
        spawn: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`],
        },
      },
    });
    expect(await q.next()).toEqual({ done: true, value: undefined });
    await expect(q.supportedModels()).rejects.toThrow("claude-lhc sidecar is closed");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(marker)).toBe(false);
  });

  test("a start without lhc.home fails the stream with the sidecar's error", async () => {
    const { q } = start("hi", { lhc: { home: "" } });
    await expect(untilResult(q)).rejects.toThrow("lhc.home is required");
  });

  test("resumeDropsTurn is refused by name before anything is written", async () => {
    const { q } = start("hi", { resumeDropsTurn: randomUUID() });
    await expect(untilResult(q)).rejects.toThrow("resumeDropsTurn is refused");
    expect(existsSync(join(dir, "lhc"))).toBe(false);
  });

  test("lhc.spawn runs the host's command", async () => {
    const { q } = start("hi", {
      lhc: { home: join(dir, "lhc"), spawn: { command: join(dir, "no-such-sidecar") } },
    });
    await expect(untilResult(q)).rejects.toThrow(
      `claude-lhc sidecar failed to start (${join(dir, "no-such-sidecar")})`,
    );
  });

  test("options that cannot cross the process boundary are named on stderr", async () => {
    const { q, stderr } = start(new Input(), { hooks: {}, spawnClaudeCodeProcess: () => ({}) as never });
    await q.supportedModels();
    expect(stderr.join("")).toContain("options.hooks cannot cross to the sidecar and is ignored");
    expect(stderr.join("")).toContain("options.spawnClaudeCodeProcess cannot cross to the sidecar and is ignored");
  });
});
