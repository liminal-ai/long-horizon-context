import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WireMcpServerConfig } from "../src/protocol.ts";
import { RETRIEVAL_SERVER_NAME } from "../src/retrieval.ts";
import { ClaudeLhcSession } from "../src/session.ts";

interface FakeQuery {
  options: Options;
  sets: Array<Record<string, McpServerConfig>>;
  feed(message: SDKMessage): void;
}

const queries: FakeQuery[] = [];
const SET_RESULT = { added: ["late"], removed: [], errors: {} };

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ options }: { options: Options }) => {
      const backlog: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      const fake: FakeQuery = {
        options,
        sets: [],
        feed(message) {
          backlog.push(message);
          wake?.();
        },
      };
      queries.push(fake);
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = backlog.shift();
            if (next !== undefined) yield next;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        },
        setMcpServers: async (servers: Record<string, McpServerConfig>) => {
          fake.sets.push(servers);
          return SET_RESULT;
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

let dir: string;
const saved = { home: process.env.T3CODE_LHC_HOME, noInf: process.env.T3CODE_LHC_NO_INFERENCE };
beforeEach(() => {
  queries.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-mcp-"));
  process.env.T3CODE_LHC_HOME = join(dir, "lhc-home");
  process.env.T3CODE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.T3CODE_LHC_HOME;
  else process.env.T3CODE_LHC_HOME = saved.home;
  if (saved.noInf === undefined) delete process.env.T3CODE_LHC_NO_INFERENCE;
  else process.env.T3CODE_LHC_NO_INFERENCE = saved.noInf;
  rmSync(dir, { recursive: true, force: true });
});

const START_SERVER: WireMcpServerConfig = { type: "stdio", command: "start-server" };
const LATE: Record<string, WireMcpServerConfig> = { late: { type: "http", url: "http://127.0.0.1:1/mcp" } };

async function startSession(mcpServers?: Record<string, WireMcpServerConfig>) {
  const emitted: SDKMessage[] = [];
  const session = new ClaudeLhcSession({
    emit: (message) => emitted.push(message),
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log(): void {},
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    settings: { autoCompactWindow: 500_000, lhcLowerBound: 180_000 },
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude-home") },
    sessionId: randomUUID(),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
  return { session, emitted, live: () => queries.at(-1)! };
}

const retrievalOf = (fake: FakeQuery) => fake.options.mcpServers?.[RETRIEVAL_SERVER_NAME];

const assistant = (text: string): SDKMessage =>
  ({
    type: "assistant",
    uuid: randomUUID(),
    parent_tool_use_id: null,
    session_id: "",
    message: {
      id: `msg_${randomUUID()}`,
      model: "claude-sonnet-5",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  }) as unknown as SDKMessage;

const result = (): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

const compactPrompt = (): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: "/compact" },
    parent_tool_use_id: null,
    session_id: "",
  }) as SDKUserMessage;

describe("setMcpServers after start", () => {
  test("before any turn, the live generation gets the host set plus retrieval and the SDK result comes back", async () => {
    const { session, live } = await startSession();

    const answer = await session.control("setMcpServers", { servers: LATE });

    expect(answer).toEqual(SET_RESULT);
    expect(live().sets).toEqual([{ ...LATE, [RETRIEVAL_SERVER_NAME]: retrievalOf(live()) }]);
  });

  test("during a turn, the set reaches the live generation without waiting for the turn to end", async () => {
    const { session, emitted, live } = await startSession();
    live().feed(assistant("working"));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    await session.control("setMcpServers", { servers: LATE });

    expect(live().sets).toHaveLength(1);
    expect(Object.keys(live().sets[0]!)).toEqual(["late", RETRIEVAL_SERVER_NAME]);
  });

  test("after a turn ends, the set reaches the same live generation", async () => {
    const { session, emitted, live } = await startSession();
    live().feed(assistant("done"));
    live().feed(result());
    await vi.waitFor(() => expect(emitted.map((m) => m.type)).toEqual(["assistant", "result"]));

    await session.control("setMcpServers", { servers: LATE });

    expect(queries).toHaveLength(1);
    expect(Object.keys(live().sets[0]!)).toEqual(["late", RETRIEVAL_SERVER_NAME]);
  });

  test("a host server named like the retrieval server never replaces retrieval", async () => {
    const { session, live } = await startSession();

    await session.control("setMcpServers", {
      servers: { [RETRIEVAL_SERVER_NAME]: { type: "stdio", command: "impostor" } },
    });

    expect(live().sets[0]).toEqual({ [RETRIEVAL_SERVER_NAME]: retrievalOf(live()) });
  });

  test("the latest set carries into the next generation, and start-frame servers stay in its options", async () => {
    const { session, live } = await startSession({ start: START_SERVER });
    const first = live();
    await session.control("setMcpServers", { servers: { replaced: { type: "stdio", command: "old" } } });
    await session.control("setMcpServers", { servers: LATE });

    await session.pushUser(compactPrompt());

    const next = live();
    expect(next).not.toBe(first);
    expect(Object.keys(next.options.mcpServers ?? {})).toEqual(["start", RETRIEVAL_SERVER_NAME]);
    expect(next.sets).toEqual([{ ...LATE, [RETRIEVAL_SERVER_NAME]: retrievalOf(next) }]);
  });

  test("without a set, a new generation makes no setMcpServers call", async () => {
    const { session, live } = await startSession({ start: START_SERVER });

    await session.pushUser(compactPrompt());

    expect(queries).toHaveLength(2);
    expect(live().sets).toEqual([]);
  });

  test("a set without servers is refused", async () => {
    const { session, live } = await startSession();

    await expect(session.control("setMcpServers", {})).rejects.toThrow("setMcpServers needs params.servers");
    expect(live().sets).toEqual([]);
  });
});
