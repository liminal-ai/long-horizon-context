// Retrieval tools over a REAL temp thread: pulls call SDK retrieval and return
// the content directly in the tool result (plain tool calling — no injection,
// no board). Impressions accumulate in the thread db. The fake ExtensionAPI
// only captures registrations — everything downstream is production code.
import { createDeterministicInferenceCallbacks, initLhc, intakeStream, type Lhc, retrieval } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, PiToolResult, PiToolSpec } from "../../src/pi/types.js";
import { HISTORY_LABEL_GUIDELINES, registerRetrievalTools } from "../../src/serving/retrieval-tools.js";
import type { LhcInstance } from "../../src/shared/instance.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
let sdk: Lhc;
let filePath: string;
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

function resultText(result: PiToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

beforeEach(async () => {
  store = tempStore();
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const thread = await makeTempThread(store);
  filePath = thread.filePath;
  tools = new Map();

  const instance: LhcInstance = {
    sdk,
    threadRef: { filePath },
    dispose: async () => ({ ok: true, value: undefined }),
  };
  registerRetrievalTools(fakePi(), {
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
  it("registers the two tools with the history-labels contract on get_turns", () => {
    expect([...tools.keys()].sort()).toEqual(["get_messages", "get_turns"]);
    expect(tools.get("get_turns")!.promptGuidelines).toBe(HISTORY_LABEL_GUIDELINES);
    expect(tools.get("get_turns")!.description).toContain("<tNNN>");
    expect(tools.get("get_messages")!.description).toContain("<mNNN>");
  });
});

describe("get_turns", () => {
  it("returns the tagged turn rendering directly in the tool result", async () => {
    const result = await runTool("get_turns", "call-1", { ids: ["t1"] });
    const text = resultText(result);
    expect(text).toContain("<t1>");
    expect(text).toContain("what does the config do?");
  });

  it("reports unknown turns as not served", async () => {
    const result = await runTool("get_turns", "call-2", { ids: ["t99"] });
    expect(resultText(result)).toContain("not served: t99 (not_found)");
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
});

describe("get_messages", () => {
  it("returns verbatim content wrapped in the message's own tag", async () => {
    const result = await runTool("get_messages", "call-6", { ids: ["m1"] });
    const text = resultText(result);
    expect(text).toContain("<m1>\nwhat does the config do?\n</m1>");
  });
});

describe("no active thread", () => {
  it("pull tools fail loudly without a thread", async () => {
    registerRetrievalTools(fakePi(), {
      getThreadRef: () => null,
      getInstance: () => null,
    });
    await expect(runTool("get_turns", "call-9", { ids: ["t1"] })).rejects.toThrow(/no active LHC thread/);
  });
});
