import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

interface FakeQuery {
  options: Record<string, unknown>;
  prompt: AsyncIterable<unknown>;
  calls: Array<[method: string, ...args: unknown[]]>;
  readsAfter: number[];
}

const queries: FakeQuery[] = [];
let contextUsage: () => Promise<unknown> = async () => ({ rawMaxTokens: 1_000_000 });
const delays: Record<string, number> = {};
const answers: Record<string, unknown> = {
  mcpServerStatus: [{ name: "late", status: "connected" }],
  setMcpServers: { added: ["late"], removed: [], errors: {} },
  backgroundTasks: false,
};

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      const fake: FakeQuery = { options, prompt, calls: [], readsAfter: [] };
      queries.push(fake);
      const never = new Promise<IteratorResult<never>>(() => {});
      const base = {
        [Symbol.asyncIterator]: () => ({ next: () => never }),
        getContextUsage: () => {
          fake.readsAfter.push(fake.calls.length);
          return contextUsage();
        },
        close: () => {},
      };
      return new Proxy(base, {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          return async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, delays[String(key)] ?? 5));
            fake.calls.push([String(key), ...args]);
            return answers[String(key)];
          };
        },
      });
    },
  };
});

const { ClaudeLhcSession } = await import("../src/session.ts");
const { threadRef } = await import("../src/lhcHome.ts");
const { RETRIEVAL_SERVER_NAME } = await import("../src/retrieval.ts");

let dir = "";
let home = "";
let logs: string[] = [];
const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-controls-"));
  home = join(dir, "lhc");
  logs = [];
  queries.length = 0;
  contextUsage = async () => ({ rawMaxTokens: 1_000_000 });
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
  else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  rmSync(dir, { recursive: true, force: true });
});

async function started(compact = { trigger: 700_000, target: 140_000 }) {
  const session = new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log: (line: string) => logs.push(line),
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-4-6",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc: { home, compact },
  } as never);
  await vi.waitFor(() => expect(logs.some((line) => line.startsWith("context window"))).toBe(true));
  return session;
}

const prompt = (text: string) =>
  ({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  }) as never;

const LATE = { late: { type: "http", url: "http://127.0.0.1:1/mcp" } };
const methods = (fake: FakeQuery) => fake.calls.map(([method]) => method);
const retrievalOf = (fake: FakeQuery) => (fake.options["mcpServers"] as Record<string, unknown>)[RETRIEVAL_SERVER_NAME];

describe("forward controls", () => {
  test("reach the live generation with their SDK arguments and return the SDK's answer", async () => {
    const session = await started();
    expect(await session.control("mcpServerStatus", {})).toEqual(answers["mcpServerStatus"]);
    expect(await session.control("backgroundTasks", { toolUseId: "toolu_1" })).toBe(false);
    await session.control("readFile", { path: "a.txt", options: { maxBytes: 10 } });
    expect(queries[0]!.calls).toEqual([
      ["mcpServerStatus"],
      ["backgroundTasks", "toolu_1"],
      ["readFile", "a.txt", { maxBytes: 10 }],
    ]);
  });

  test("are not sent again to the generation a compact starts", async () => {
    const session = await started();
    await session.control("stopTask", { taskId: "task-1" });
    await session.pushUser(prompt("/compact"));
    expect(queries).toHaveLength(2);
    expect(queries[1]!.calls).toEqual([]);
  });
});

describe("replay controls", () => {
  test("hold after a compact swap: the new generation gets the latest calls before compact returns", async () => {
    const session = await started();
    await session.control("setMcpServers", { servers: LATE });
    await session.control("applyFlagSettings", { settings: { effortLevel: "low" } });
    await session.control("applyFlagSettings", { settings: { ultracode: true } });
    await session.control("toggleMcpServer", { serverName: "late", enabled: false });
    await session.control("toggleMcpServer", { serverName: "late", enabled: true });
    await session.control("setPermissionMode", { mode: "plan" });

    await session.pushUser(prompt("/compact"));

    const next = queries[1]!;
    expect(next.options["permissionMode"]).toBe("plan");
    expect(next.calls).toEqual([
      ["setMcpServers", { ...LATE, [RETRIEVAL_SERVER_NAME]: retrievalOf(next) }],
      ["applyFlagSettings", { effortLevel: "low" }],
      ["applyFlagSettings", { ultracode: true }],
      ["toggleMcpServer", "late", true],
      ["setPermissionMode", "plan"],
    ]);
    expect(logs).toContain(
      `generation ${(next.options["resume"] ?? next.options["sessionId"]) as string}: replayed setMcpServers, applyFlagSettings, applyFlagSettings, toggleMcpServer, setPermissionMode`,
    );

    expect(await session.control("mcpServerStatus", {})).toEqual(answers["mcpServerStatus"]);
    expect(methods(next).at(-1)).toBe("mcpServerStatus");
    expect(methods(queries[0]!)).not.toContain("mcpServerStatus");
  });

  test("replay keeps the host's order across controls that touch the same setting", async () => {
    const session = await started();
    await session.control("applyFlagSettings", { settings: { model: "model-a", effortLevel: "high" } });
    await session.control("setModel", { model: "model-b" });
    await session.control("applyFlagSettings", { settings: { effortLevel: "low" } });
    await session.control("applyFlagSettings", { settings: { effortLevel: null } });

    await session.pushUser(prompt("/compact"));

    expect(queries[1]!.calls).toEqual([
      ["applyFlagSettings", { model: "model-a" }],
      ["setModel", "model-b"],
      ["applyFlagSettings", { effortLevel: null }],
    ]);
  });

  test("the new generation reads its window after the replay", async () => {
    const session = await started();
    await session.control("setMcpServers", { servers: LATE });
    await session.control("setModel", { model: "claude-sonnet-4-5" });
    await session.pushUser(prompt("/compact"));
    expect(queries[1]!.readsAfter[0]).toBe(2);
  });

  test("a control sent while the replay waits reaches the new generation", async () => {
    const session = await started();
    await session.control("setMcpServers", { servers: LATE });
    delays["setMcpServers"] = 200;
    try {
      const compacted = session.pushUser(prompt("/compact"));
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      await session.control("setPermissionMode", { mode: "plan" });
      await compacted;
    } finally {
      delete delays["setMcpServers"];
    }
    expect(methods(queries[1]!)).toEqual(["setMcpServers", "setPermissionMode"]);
  });

  test("a control still in flight on the old generation when the replay ends reaches the new one", async () => {
    const session = await started();
    await session.control("setMcpServers", { servers: LATE });
    delays["setMcpServers"] = 50;
    delays["applyFlagSettings"] = 300;
    try {
      const compacted = session.pushUser(prompt("/compact"));
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      await session.control("applyFlagSettings", { settings: { effortLevel: "low" } });
      await compacted;
    } finally {
      delete delays["setMcpServers"];
      delete delays["applyFlagSettings"];
    }
    expect(queries[1]!.calls).toContainEqual(["applyFlagSettings", { effortLevel: "low" }]);
  });

  test("setMcpServers keeps the retrieval server under its own name", async () => {
    const session = await started();
    await session.control("setMcpServers", {
      servers: { ...LATE, [RETRIEVAL_SERVER_NAME]: { type: "stdio", command: "x" } },
    });
    const [, servers] = queries[0]!.calls[0]!;
    expect((servers as Record<string, unknown>)[RETRIEVAL_SERVER_NAME]).toBe(retrievalOf(queries[0]!));
  });

  test("a failed replay is logged and the compact still swaps", async () => {
    const session = await started();
    await session.control("setMcpServers", { servers: LATE });
    answers["setMcpServers"] = { added: [], removed: [], errors: { late: "connect ECONNREFUSED" } };
    try {
      await session.pushUser(prompt("/compact"));
    } finally {
      answers["setMcpServers"] = { added: ["late"], removed: [], errors: {} };
    }
    expect(queries).toHaveLength(2);
    expect(logs.some((line) => line.endsWith("replayed MCP server(s) failed: late"))).toBe(true);
  });
});

describe("window after a model change", () => {
  test("a flag setting that names a model rereads the window and caps the pair", async () => {
    const session = await started();
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    await session.control("applyFlagSettings", { settings: { model: "claude-sonnet-4-5" } });
    expect(logs).toContain("compact policy capped to window 200000: trigger 160000 target 80000");
  });

  test("a flag setting without a model leaves the window alone", async () => {
    const session = await started();
    contextUsage = async () => ({ rawMaxTokens: 200_000 });
    await session.control("applyFlagSettings", { settings: { effortLevel: "low" } });
    expect(logs.some((line) => line.startsWith("compact policy capped"))).toBe(false);
  });
});

describe("refused and malformed controls", () => {
  test.each([
    ["rewindFiles", { userMessageId: "u1" }],
    ["reinitialize", {}],
    ["seedReadState", { path: "a.txt", mtime: 1 }],
  ])("%s is refused by name and the session stays usable", async (method, params) => {
    const session = await started();
    await expect(session.control(method, params)).rejects.toThrow(
      `${method} is refused: it changes the Claude session outside the LHC record`,
    );
    expect(await session.control("mcpServerStatus", {})).toEqual(answers["mcpServerStatus"]);
    expect(methods(queries[0]!)).toEqual(["mcpServerStatus"]);
  });

  test("an unknown method and a missing parameter are refused before the SDK", async () => {
    const session = await started();
    await expect(session.control("forkSession", {})).rejects.toThrow("unknown control forkSession");
    await expect(session.control("toString", {})).rejects.toThrow("unknown control toString");
    await expect(session.control("setMcpServers", {})).rejects.toThrow("setMcpServers needs params.servers");
    expect(queries[0]!.calls).toEqual([]);
  });
});

describe("setCompactPolicy", () => {
  const stored = async (session: InstanceType<typeof ClaudeLhcSession>) => {
    const read = await threads.getCompactPolicy(threadRef(session.threadId, home));
    if (!read.ok) throw new Error(read.error.reason);
    return read.value;
  };

  test("stores the pair on the thread and caps it to the live window", async () => {
    contextUsage = async () => ({ rawMaxTokens: 200_000, totalTokens: 10_000 });
    const session = await started({ trigger: 150_000, target: 40_000 });
    await session.control("setCompactPolicy", { policy: { trigger: 700_000, target: 300_000 } });
    expect(await stored(session)).toEqual({ trigger: 700_000, target: 300_000 });
    expect(logs).toContain("compact policy set on thread: trigger 700000 target 300000");
    expect(logs.at(-1)).toBe("compact policy capped to window 200000: trigger 160000 target 80000");
  });

  test("a trigger below the served context queues a compact before the next prompt", async () => {
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: 300_000 });
    const session = await started();
    let reads = 0;
    contextUsage = async () => ({ rawMaxTokens: 1_000_000, totalTokens: reads++ === 0 ? 300_000 : 40_000 });

    await session.control("setCompactPolicy", { policy: { trigger: 200_000, target: 60_000 } });
    expect(logs).toContain(
      "served context 300000 tokens is at or past the compact trigger 200000; compacting before the next prompt",
    );
    expect(queries).toHaveLength(1);

    await session.pushUser(prompt("NEXT-PROMPT"));
    expect(logs.find((line) => line.startsWith("[lhc compact:auto]"))).toContain("(target 60000)");
    expect(queries).toHaveLength(2);
    const delivered = await queries[1]!.prompt[Symbol.asyncIterator]().next();
    expect(JSON.stringify(delivered.value)).toContain("NEXT-PROMPT");
  });

  test("a malformed pair is refused naming the control and the stored pair stays", async () => {
    const session = await started();
    await expect(
      session.control("setCompactPolicy", { policy: { trigger: 100_000, target: 100_000 } }),
    ).rejects.toThrow(/^setCompactPolicy params\.policy must be/);
    await expect(session.control("setCompactPolicy", {})).rejects.toThrow("setCompactPolicy needs params.policy");
    expect(await stored(session)).toEqual({ trigger: 700_000, target: 140_000 });
  });
});
