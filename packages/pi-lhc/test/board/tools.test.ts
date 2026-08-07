// Board tools over a REAL temp thread: pulls call SDK retrieval, content lands
// on the board (anchored, right ttl), the tool result is only a receipt, and
// impressions accumulate in the thread db. The fake ExtensionAPI only captures
// registrations — everything downstream is production code.
import { createDeterministicInferenceCallbacks, initLhc, intakeStream, type Lhc, retrieval } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardState, createBoardState } from "../../src/board/index.js";
import { HISTORY_LABEL_GUIDELINES, registerBoardTools } from "../../src/board/tools.js";
import type { ExtensionAPI, PiToolResult, PiToolSpec } from "../../src/pi/types.js";
import type { LhcInstance } from "../../src/shared/instance.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
let sdk: Lhc;
let filePath: string;
let board: BoardState;
let tools: Map<string, PiToolSpec>;

function fakePi(): ExtensionAPI {
  return {
    registerTool: (tool: PiToolSpec) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
}

async function runTool(name: string, toolCallId: string, params: unknown): Promise<PiToolResult> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool.execute(toolCallId, params, undefined, undefined, {} as never);
}

function receiptText(result: PiToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const thread = await makeTempThread(store);
  filePath = thread.filePath;
  board = createBoardState({});
  tools = new Map();

  const instance: LhcInstance = {
    sdk,
    threadRef: { filePath },
    dispose: async () => ({ ok: true, value: undefined }),
  };
  registerBoardTools(fakePi(), {
    getBoard: () => board,
    getThreadRef: () => ({ filePath }),
    getInstance: () => instance,
  });

  const seeded = await intakeStream.messageEvents({ filePath }, [
    {
      eventKind: "user_prompt",
      idempotencyKey: "e1",
      actor: "lee",
      harness: "pi",
      payload: { text: "what does the config do?" },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: "e2",
      actor: "assistant",
      harness: "pi",
      payload: { text: "it configures things" },
    },
    { eventKind: "turn_end", idempotencyKey: "e3", actor: "assistant", harness: "pi", payload: {} },
  ] as never);
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.reason}`);
});
afterEach(() => {
  store.cleanup();
});

describe("registration", () => {
  it("registers the three tools with the history-labels contract on get_turns", () => {
    expect([...tools.keys()].sort()).toEqual(["board_post", "get_messages", "get_turns"]);
    expect(tools.get("get_turns")!.promptGuidelines).toBe(HISTORY_LABEL_GUIDELINES);
    expect(tools.get("get_turns")!.description).toContain("<tNNN>");
    expect(tools.get("get_messages")!.description).toContain("<mNNN>");
  });
});

describe("get_turns", () => {
  it("posts pulled turns to the board anchored at the call, returns a receipt only", async () => {
    const result = await runTool("get_turns", "call-1", { ids: ["t1"] });
    const text = receiptText(result);
    expect(text).toContain("posted: t1");
    expect(text).toContain("ttl 1");
    expect(text).toContain("board: 1 entries");
    // Receipt must not carry the pulled content.
    expect(text).not.toContain("what does the config do?");

    expect(board.entries).toHaveLength(1);
    const entry = board.entries[0]!;
    expect(entry.kind).toBe("turns");
    expect(entry.ids).toEqual(["t1"]);
    expect(entry.ttl).toBe(1);
    expect(entry.src).toBe("pull");
    expect(entry.anchorToolCallId).toBe("call-1");
    expect(entry.text).toContain("<t1>");
    expect(entry.text).toContain("what does the config do?");
  });

  it("reports unknown turns in the receipt without posting", async () => {
    const result = await runTool("get_turns", "call-2", { ids: ["t99"] });
    expect(receiptText(result)).toContain("not served: t99 (not_found)");
    expect(board.entries).toHaveLength(0);
  });

  it("rejects malformed ids loudly", async () => {
    await expect(runTool("get_turns", "call-3", { ids: ["m1"] })).rejects.toThrow(/invalid turn id/);
    await expect(runTool("get_turns", "call-4", { ids: [] })).rejects.toThrow(/non-empty/);
  });

  it("writes impressions with the get_turns surface", async () => {
    await runTool("get_turns", "call-5", { ids: ["t1"] });
    const impressions = await retrieval.listImpressions({ filePath });
    expect(impressions.ok).toBe(true);
    if (!impressions.ok) return;
    expect(impressions.value).toHaveLength(1);
    expect(impressions.value[0]).toMatchObject({ surface: "get_turns", entityId: "t1", served: true });
  });

  it("fails before retrieval while the board is off, leaving no impression side effect", async () => {
    board.enabled = false;
    await expect(runTool("get_turns", "call-off", { ids: ["t1"] })).rejects.toThrow(/board is off/);
    const impressions = await retrieval.listImpressions({ filePath });
    expect(impressions.ok).toBe(true);
    if (impressions.ok) expect(impressions.value).toEqual([]);
  });
});

describe("get_messages", () => {
  it("posts verbatim messages with size-based ttl", async () => {
    const result = await runTool("get_messages", "call-6", { ids: ["m1"] });
    const text = receiptText(result);
    expect(text).toContain("posted: m1");
    expect(text).toContain("ttl 3");
    const entry = board.entries[0]!;
    expect(entry.kind).toBe("messages");
    expect(entry.text).toBe("what does the config do?");
    expect(entry.ttl).toBe(3);
  });
});

describe("board_post", () => {
  it("posts a note anchored at its call with the requested ttl", async () => {
    const result = await runTool("board_post", "call-7", { text: "planted probe", ttl: 4 });
    expect(receiptText(result)).toContain("posted b1");
    const entry = board.entries[0]!;
    expect(entry.kind).toBe("note");
    expect(entry.text).toBe("planted probe");
    expect(entry.ttl).toBe(4);
    expect(entry.anchorToolCallId).toBe("call-7");
  });

  it("surfaces board-off as a tool error, not a silent drop", async () => {
    board.enabled = false;
    await expect(runTool("board_post", "call-8", { text: "x" })).rejects.toThrow(/board is off/);
  });
});

describe("no active thread", () => {
  it("pull tools fail loudly without a thread", async () => {
    registerBoardTools(fakePi(), {
      getBoard: () => board,
      getThreadRef: () => null,
      getInstance: () => null,
    });
    await expect(runTool("get_turns", "call-9", { ids: ["t1"] })).rejects.toThrow(/no active LHC thread/);
  });
});
