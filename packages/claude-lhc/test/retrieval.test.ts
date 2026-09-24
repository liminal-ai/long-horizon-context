/**
 * get_turns / get_messages: the in-process MCP server a Claude LHC session
 * gets in every generation, called here through a real MCP client against a
 * real LHC thread.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRetrievalServer, formatRetrieval, recallClose, recallOpen } from "../src/retrieval.ts";

let dir = "";
let lhc: Lhc;
let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};

const event = (eventKind: string, payload: Record<string, unknown>) => ({
  eventKind,
  idempotencyKey: `k-${nextSeq()}`,
  actor: "test",
  harness: "claude-lhc-test",
  payload,
});

async function thread(turns: Array<[string, string]>): Promise<ThreadRef> {
  const ref = { filePath: join(dir, `thread-${nextSeq()}.sqlite`) };
  const created = await lhc.threads.newThread({ filePath: ref.filePath, registryPath: join(dir, "registry.sqlite") });
  if (!created.ok) throw new Error(created.error.reason);
  const events = turns.flatMap(([prompt, answer]) => [
    event("user_prompt", { text: prompt }),
    event("assistant_text", { text: answer }),
    event("turn_end", {}),
  ]);
  const sent = await lhc.intakeStream.messageEvents(ref, events as never);
  if (!sent.ok) throw new Error(sent.error.reason);
  return ref;
}

async function connect(ref: () => ThreadRef): Promise<Client> {
  const server = createRetrievalServer(lhc, ref);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return result.content.map((c) => c.text).join("");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-retrieval-"));
  lhc = initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    tokenFamily: "claude-2026",
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("retrieval server", () => {
  test("lists get_turns and get_messages, read-only, with descriptions that answer the gap marker", async () => {
    const ref = await thread([["q", "a"]]);
    const client = await connect(() => ref);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_messages", "get_turns"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "get_turns")!.description).toContain("not in view; use get-turns");
  });

  test("get_turns returns the turn as its history renders it, inside the historical envelope; receipts outside it", async () => {
    const ref = await thread([
      ["the tide gauge read 7.31 m", "noted: 7.31 m"],
      ["second question", "second answer"],
    ]);
    const client = await connect(() => ref);
    const text = await callText(client, "get_turns", { ids: ["t1", "t99", "x1"] });
    const open = recallOpen("get_turns");
    const close = recallClose("get_turns");
    expect(text.startsWith(open)).toBe(true);
    const inside = text.slice(open.length, text.indexOf(close));
    expect(inside).toContain("<t1>");
    expect(inside).toContain("the tide gauge read 7.31 m");
    expect(inside).not.toContain("second question");
    const after = text.slice(text.indexOf(close) + close.length);
    expect(after).toContain("not served: t99 (no such id in this conversation)");
    expect(after).toContain("not served: x1 (not a valid id");
  });

  test("get_messages returns each message verbatim, wrapped in its <mN> tag", async () => {
    const ref = await thread([["remember BLUE-HERON-4", "remembered"]]);
    const client = await connect(() => ref);
    const turn = await callText(client, "get_turns", { ids: ["t1"] });
    const id = /<(m\d+)>[^<]*BLUE-HERON-4/.exec(turn)?.[1];
    expect(id).toBeDefined();
    const text = await callText(client, "get_messages", { ids: [id!] });
    expect(text).toContain(recallOpen("get_messages"));
    expect(text).toContain(`<${id}>\nremember BLUE-HERON-4\n</${id}>`);
  });

  test("a long turn is served as a head slice with the exact next call; fromToken continues it", async () => {
    const long = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
    const ref = await thread([["write a lot", `${long} THE-END-MARK`]]);
    const client = await connect(() => ref);
    const first = await callText(client, "get_turns", { ids: ["t1"] });
    const next = /Next slice: get_turns\(\{"ids":\["t1"\],"fromToken":(\d+)\}\)/.exec(first);
    expect(next).not.toBeNull();
    expect(first.indexOf("Next slice")).toBeGreaterThan(first.indexOf(recallClose("get_turns")));
    expect(first).not.toContain("THE-END-MARK");
    let from = Number(next![1]);
    let rest = "";
    for (let i = 0; i < 10 && from > 0; i++) {
      const more = await callText(client, "get_turns", { ids: ["t1"], fromToken: from });
      rest += more;
      const again = /"fromToken":(\d+)\}\)/.exec(more);
      from = again === null ? 0 : Number(again[1]);
    }
    expect(rest).toContain("THE-END-MARK");
    expect(rest).toContain("end of content");
  });

  test("the thread is read at call time, so a changed thread is answered from", async () => {
    const a = await thread([["fact in A: ALPHA-1", "ok"]]);
    const b = await thread([["fact in B: BRAVO-2", "ok"]]);
    let current = a;
    const client = await connect(() => current);
    expect(await callText(client, "get_turns", { ids: ["t1"] })).toContain("ALPHA-1");
    current = b;
    expect(await callText(client, "get_turns", { ids: ["t1"] })).toContain("BRAVO-2");
  });

  test("deleted and budget-spent ids are reported with the recovery", () => {
    const text = formatRetrieval(
      "get_turns",
      [{ id: "t1", text: "<t1>x</t1>" }],
      [
        { id: "t2", reason: "deleted" },
        { id: "t3", reason: "budget", tokens: 9000 },
      ],
    );
    expect(text).toContain("not served: t2 (deleted from the record)");
    expect(text).toContain(
      'not served: t3 (9000 tok — call budget spent). Pull it separately: get_turns({"ids":["t3"]})',
    );
    expect(text.indexOf("not served")).toBeGreaterThan(text.indexOf(recallClose("get_turns")));
  });

  test("a failed store read is an error result, not an exception", async () => {
    const client = await connect(() => ({ filePath: join(dir, "missing", "nope.sqlite") }));
    const result = (await client.callTool({ name: "get_turns", arguments: { ids: ["t1"] } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^get_turns failed: /);
  });
});

// ── session wiring ──────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: SDK query options are checked structurally below
type LooseOptions = Record<string, any>;
const captured: LooseOptions[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    query: ({ options }: { options: LooseOptions }) => {
      captured.push(options);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        interrupt: async () => {},
        close: () => {},
        setPermissionMode: async () => {},
      };
    },
  };
});

describe("session wiring", () => {
  const saved = { home: process.env.T3CODE_LHC_HOME, noInf: process.env.T3CODE_LHC_NO_INFERENCE };
  beforeEach(() => {
    captured.length = 0;
    process.env.T3CODE_LHC_HOME = join(dir, "home");
    process.env.T3CODE_LHC_NO_INFERENCE = "1";
  });
  afterEach(() => {
    if (saved.home === undefined) delete process.env.T3CODE_LHC_HOME;
    else process.env.T3CODE_LHC_HOME = saved.home;
    if (saved.noInf === undefined) delete process.env.T3CODE_LHC_NO_INFERENCE;
    else process.env.T3CODE_LHC_NO_INFERENCE = saved.noInf;
  });

  async function startSession(requests: string[], extra: Record<string, unknown> = {}) {
    const { ClaudeLhcSession } = await import("../src/session.ts");
    const session = new ClaudeLhcSession({
      emit(): void {},
      request: async (method: string) => {
        requests.push(method);
        return { behavior: "deny", message: "host said no" };
      },
      end(): void {},
      fail(): void {},
      log(): void {},
    } as never);
    await session.start({
      cwd: dir,
      model: "claude-opus-5-5",
      permissionMode: "default",
      settings: { autoCompactWindow: 500_000, lhcLowerBound: 180_000 },
      mcpServers: {
        "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } },
      },
      allowedTools: ["Read"],
      ...extra,
    } as never);
    return session;
  }

  test("the tools are registered alongside the host's MCP servers and allowed tools", async () => {
    await startSession([]);
    const options = captured.at(-1)!;
    expect(Object.keys(options.mcpServers).sort()).toEqual(["lhc", "t3-code"]);
    expect(options.mcpServers["t3-code"].url).toBe("http://127.0.0.1:1/mcp");
    expect(options.mcpServers.lhc.type).toBe("sdk");
    expect(options.allowedTools).toEqual(["Read", "mcp__lhc__get_turns", "mcp__lhc__get_messages"]);
  });

  test("a host MCP server named like ours is refused at start, never silently replaced", async () => {
    const host = { type: "http", url: "http://127.0.0.1:2/mcp" };
    await expect(startSession([], { mcpServers: { lhc: host } })).rejects.toThrow(
      "start option mcpServers.lhc is reserved for claude-lhc's history tools (mcp__lhc__get_turns, mcp__lhc__get_messages)",
    );
    await expect(startSession([], { mcpServers: { "t3-code": host, lhc: host } })).rejects.toThrow(/reserved/);
    expect(captured.some((o) => o.mcpServers?.lhc?.url === host.url)).toBe(false);
  });

  test("get_turns / get_messages are allowed without an approval request; other tools still ask the host", async () => {
    const requests: string[] = [];
    await startSession(requests);
    const canUseTool = captured.at(-1)!.canUseTool;
    const signal = new AbortController().signal;
    for (const name of ["mcp__lhc__get_turns", "mcp__lhc__get_messages"]) {
      const input = { ids: ["t1"] };
      expect(await canUseTool(name, input, { signal, toolUseID: "x" })).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
    }
    expect(requests).toEqual([]);
    expect(await canUseTool("Bash", { command: "ls" }, { signal, toolUseID: "y" })).toMatchObject({ behavior: "deny" });
    expect(requests).toEqual(["canUseTool"]);
  });

  test("after a compaction the new generation's server answers from the same thread", async () => {
    const first = await startSession([]);
    const threadId = first.threadId;
    const { bindSession, threadRef } = await import("../src/lhcHome.ts");
    const ref = threadRef(threadId);
    const sent = await lhc.intakeStream.messageEvents(ref, [
      event("user_prompt", { text: "the codeword is OTTER-LANTERN-77" }),
      event("assistant_text", { text: "got it" }),
      event("turn_end", {}),
    ] as never);
    if (!sent.ok) throw new Error(sent.error.reason);
    // A compaction binds the rebuilt Claude session to the same LHC thread.
    const rebuilt = "22222222-2222-4222-8222-222222222222";
    await bindSession(threadId, rebuilt);
    captured.length = 0;
    const resumed = await startSession([], { resume: rebuilt });
    expect(resumed.threadId).toBe(threadId);
    const server = captured.at(-1)!.mcpServers.lhc;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    expect(await callText(client, "get_turns", { ids: ["t1"] })).toContain("OTTER-LANTERN-77");
    // get_turns serves the rendered turn (smoothed prompts, summarized tool output), never claimed verbatim.
    const { tools } = await client.listTools();
    const getTurns = tools.find((t) => t.name === "get_turns")!.description!;
    expect(getTurns).not.toContain("verbatim");
    expect(getTurns).toContain("smoothed");
    expect(getTurns).toContain("For the exact original content of a message, use get_messages.");
  });
});
