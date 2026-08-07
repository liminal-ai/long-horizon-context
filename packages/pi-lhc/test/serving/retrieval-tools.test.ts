// Retrieval tools over a REAL temp thread: pulls call SDK retrieval and return
// the content directly in the tool result (plain tool calling — no injection,
// no board). Impressions accumulate in the thread db. The fake ExtensionAPI
// only captures registrations — everything downstream is production code.
import { createDeterministicInferenceCallbacks, initLhc, intakeStream, type Lhc, retrieval } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, PiToolResult, PiToolSpec } from "../../src/pi/types.js";
import {
  HISTORY_LABEL_GUIDELINES,
  recallClose,
  recallOpen,
  registerRetrievalTools,
} from "../../src/serving/retrieval-tools.js";
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
  it("returns the tagged turn rendering inside the historical envelope", async () => {
    const result = await runTool("get_turns", "call-1", { ids: ["t1"] });
    const text = resultText(result);
    expect(text).toContain("<t1>");
    expect(text).toContain("what does the config do?");
    // Envelope framing: verbose opener before content, explicit closer after.
    expect(text.startsWith(recallOpen("get_turns"))).toBe(true);
    expect(text).toContain(recallClose("get_turns"));
    expect(text.indexOf("<t1>")).toBeGreaterThan(text.indexOf("HISTORICAL"));
    expect(text.indexOf("</recalled-history>")).toBeGreaterThan(text.indexOf("</t1>"));
  });

  it("reports unknown turns as not served, outside any envelope", async () => {
    const result = await runTool("get_turns", "call-2", { ids: ["t99"] });
    const text = resultText(result);
    expect(text).toContain("not served: t99 (not_found)");
    expect(text).not.toContain("<recalled-history");
  });

  it("serves an oversized turn as a head slice with a literal continuation call", async () => {
    const bigBody = Array.from({ length: 2000 }, (_, i) => `line ${i} of the very long log`).join("\n");
    const seeded = await intakeStream.messageEvents({ filePath }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: "big1",
        actor: "lee",
        harness: "pi",
        payload: { text: "dump it" },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: "big2",
        actor: "assistant",
        harness: "pi",
        payload: { text: bigBody },
      },
      { eventKind: "turn_end", idempotencyKey: "big3", actor: "assistant", harness: "pi", payload: {} },
    ] as never);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.reason}`);

    const first = await runTool("get_turns", "call-slice-1", { ids: ["t2"] });
    const firstText = resultText(first);
    expect(firstText).toContain("served tok 0\u20138000 of ");
    expect(firstText).toContain('Next slice: get_turns({"ids":["t2"],"from":8000})');

    // Follow the tool's own instruction verbatim — the JIT contract.
    const second = await runTool("get_turns", "call-slice-2", { ids: ["t2"], from: 8000 });
    const secondText = resultText(second);
    expect(secondText).toContain("served tok 8000\u2013");
    expect(secondText).not.toContain(firstText.slice(recallOpen("get_turns").length + 2, 400));
  });

  it("gives later ids budget receipts with retry instructions instead of starving them silently", async () => {
    const bigBody = Array.from({ length: 2000 }, (_, i) => `filler line ${i} with some words`).join("\n");
    const seeded = await intakeStream.messageEvents({ filePath }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: "mix1",
        actor: "lee",
        harness: "pi",
        payload: { text: "big one" },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: "mix2",
        actor: "assistant",
        harness: "pi",
        payload: { text: bigBody },
      },
      { eventKind: "turn_end", idempotencyKey: "mix3", actor: "assistant", harness: "pi", payload: {} },
    ] as never);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.reason}`);

    // Oversized t2 first, small t1 behind it: t2 slices to the cap, t1 gets a
    // budget receipt naming the exact retry call (the Grok dogfood case).
    const result = await runTool("get_turns", "call-mixed", { ids: ["t2", "t1"] });
    const text = resultText(result);
    expect(text).toContain("served tok 0\u20138000");
    expect(text).toContain("not served: t1 (");
    expect(text).toContain('Pull it separately: get_turns({"ids":["t1"]})');
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
  it("returns verbatim content wrapped in the message's own tag inside the envelope", async () => {
    const result = await runTool("get_messages", "call-6", { ids: ["m1"] });
    const text = resultText(result);
    expect(text).toContain("<m1>\nwhat does the config do?\n</m1>");
    expect(text.startsWith(recallOpen("get_messages"))).toBe(true);
    expect(text).toContain(recallClose("get_messages"));
  });

  it("reports a past-the-end offset without serving content", async () => {
    const result = await runTool("get_messages", "call-7", { ids: ["m1"], from: 5000 });
    const text = resultText(result);
    expect(text).toContain("nothing at token offset 5000");
    expect(text).toContain("total size");
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
