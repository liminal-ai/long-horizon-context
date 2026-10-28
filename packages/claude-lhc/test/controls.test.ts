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
  calls: Array<[method: string, arg: unknown]>;
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
        calls: [],
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
        setModel: async (model?: string) => {
          fake.calls.push(["setModel", model]);
        },
        applyFlagSettings: async (settings: unknown) => {
          fake.calls.push(["applyFlagSettings", settings]);
        },
        stopTask: async (taskId: string) => {
          fake.calls.push(["stopTask", taskId]);
        },
        backgroundTasks: async (toolUseId?: string) => {
          fake.calls.push(["backgroundTasks", toolUseId]);
          return toolUseId !== "toolu_finished";
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
  const logs: string[] = [];
  const session = new ClaudeLhcSession({
    emit: (message) => emitted.push(message),
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log: (line) => logs.push(line),
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    settings: { autoCompactWindow: 500_000, lhcLowerBound: 180_000 },
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude-home") },
    sessionId: randomUUID(),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
  return { session, emitted, logs, live: () => queries.at(-1)! };
}

const retrievalOf = (fake: FakeQuery) => fake.options.mcpServers?.[RETRIEVAL_SERVER_NAME];

const assistant = (text: string, inputTokens = 0): SDKMessage =>
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
      usage: { input_tokens: inputTokens, output_tokens: 1 },
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

describe("flag settings, task controls, and setModel windows", () => {
  test("applyFlagSettings reaches the live generation", async () => {
    const { session, live } = await startSession();

    const answer = await session.control("applyFlagSettings", { settings: { effortLevel: "low", fastMode: true } });

    expect(answer).toBeUndefined();
    expect(live().calls).toEqual([["applyFlagSettings", { effortLevel: "low", fastMode: true }]]);
  });

  test("the merged flag layer, cleared keys included, carries into the next generation", async () => {
    const { session, live } = await startSession();
    const first = live();
    await session.control("applyFlagSettings", { settings: { effortLevel: "low", fastMode: true } });
    await session.control("applyFlagSettings", { settings: { fastMode: null } });

    await session.pushUser(compactPrompt());

    const next = live();
    expect(next).not.toBe(first);
    expect(next.calls).toEqual([["applyFlagSettings", { effortLevel: "low", fastMode: null }]]);
  });

  test("without applied flags, a new generation makes no applyFlagSettings call", async () => {
    const { session, live } = await startSession();

    await session.pushUser(compactPrompt());

    expect(queries).toHaveLength(2);
    expect(live().calls).toEqual([]);
  });

  test("applyFlagSettings without settings is refused", async () => {
    const { session, live } = await startSession();

    await expect(session.control("applyFlagSettings", {})).rejects.toThrow("applyFlagSettings needs params.settings");
    expect(live().calls).toEqual([]);
  });

  test("stopTask reaches the live generation with the task id", async () => {
    const { session, live } = await startSession();

    expect(await session.control("stopTask", { taskId: "task-7" })).toBeUndefined();
    await expect(session.control("stopTask", {})).rejects.toThrow("stopTask needs params.taskId");

    expect(live().calls).toEqual([["stopTask", "task-7"]]);
  });

  test("backgroundTasks returns the SDK's answer, and no toolUseId backgrounds every task", async () => {
    const { session, live } = await startSession();

    expect(await session.control("backgroundTasks", { toolUseId: "toolu_running" })).toBe(true);
    expect(await session.control("backgroundTasks", { toolUseId: "toolu_finished" })).toBe(false);
    expect(await session.control("backgroundTasks", {})).toBe(true);

    expect(live().calls).toEqual([
      ["backgroundTasks", "toolu_running"],
      ["backgroundTasks", "toolu_finished"],
      ["backgroundTasks", undefined],
    ]);
  });

  test("setModel with settings compacts against the new windows; without settings the windows stay", async () => {
    const { session, emitted, logs, live } = await startSession();
    const turn = async (expected: number) => {
      live().feed(assistant("working", 150_000));
      live().feed(result());
      await vi.waitFor(() => expect(emitted.filter((m) => m.type === "result")).toHaveLength(expected));
    };

    await session.control("setModel", { model: "claude-opus-5" });
    await turn(1);
    expect(queries).toHaveLength(1);

    await session.control("setModel", {
      model: "claude-sonnet-5",
      settings: { autoCompactWindow: 100_000, lhcLowerBound: 60_000 },
    });
    await turn(2);

    expect(queries).toHaveLength(2);
    expect(queries[0]!.calls).toEqual([
      ["setModel", "claude-opus-5"],
      ["setModel", "claude-sonnet-5"],
    ]);
    expect(logs.some((line) => line.startsWith("[lhc compact:auto]") && line.includes("(target 60000)"))).toBe(true);
  });

  test("setModel with invalid windows is refused before the model changes", async () => {
    const { session, live } = await startSession();

    await expect(
      session.control("setModel", {
        model: "claude-opus-5",
        settings: { autoCompactWindow: 100_000, lhcLowerBound: 200_000 },
      }),
    ).rejects.toThrow("lhcLowerBound must be less than autoCompactWindow");
    expect(live().calls).toEqual([]);
  });
});
