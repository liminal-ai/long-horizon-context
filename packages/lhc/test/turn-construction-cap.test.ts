// F1 — the bounded per-message construction cap. Construction behavior only:
// a giant message renders as head + marked elision (naming its exact-retrieval
// address) + tail; canonical keeps every byte, retrieval serves them, the
// verbatim tail serves them, and derivation floors are written uncapped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, type ViewCompactParams } from "../src/index.js";
import { CONSTRUCTION_MESSAGE_CAP_TOKENS, capForConstruction } from "../src/turns/internal/compose.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

// Over the construction cap, under retrieval's default budget.
const GIANT = Array.from({ length: 300 }, (_, i) => `line ${i} of a very long assistant message body`).join("\n");

describe("capForConstruction", () => {
  it("is identity under the cap and a priced head/elision/tail over it", () => {
    expect(capForConstruction("short", "m9")).toBe("short");
    const capped = capForConstruction(GIANT, "m9");
    expect(capped.startsWith("line 0 of")).toBe(true);
    expect(capped.endsWith("assistant message body")).toBe(true);
    expect(capped).toMatch(/\n\[… \d+ tokens elided at construction — exact content: m9 …\]\n/);
    expect(capped.length).toBeLessThan(GIANT.length);
    expect(capped).toBe(capForConstruction(GIANT, "m9")); // deterministic
  });
});

describe("the cap in constructions, never in the verbatim tail", () => {
  it("part and whole constructions elide with a pointer; retrieval and the tail keep every byte; the prompt floor is uncapped", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    const giantPrompt = `please read this\n${GIANT}`;
    const sent = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "t1 prompt" } }),
      validEvent("assistant_text", { payload: { text: "t1 answer" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: giantPrompt } }),
      validEvent("assistant_text", { payload: { text: GIANT, stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "step 1 short", stepIndex: 1 } }),
    ]);
    expect(sent.ok).toBe(true);

    // Split after step 0: the part holds the giant prompt (m4) and giant text (m5), capped.
    const params: ViewCompactParams = { lowerBound: 400, percentages: { full: 50, smooth: 50, detailed: 0, brief: 0 } };
    const prepared = await sdk.threadView.prepareCompact({ filePath }, { params });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const part = prepared.value.selection.entries.find((e) => e.part !== undefined);
    expect(part?.part).toEqual({ fromStep: 0, toStep: 0 });
    expect(part!.text).toContain("exact content: m4 …]");
    expect(part!.text).toContain("exact content: m5 …]");
    expect(part!.tokens).toBeLessThan(2 * CONSTRUCTION_MESSAGE_CAP_TOKENS + 400);

    // Retrieval serves the exact bytes the pointer names.
    const exact = await sdk.retrieval.getMessages({ filePath }, ["m5"]);
    expect(exact.ok && exact.value.served[0]?.text).toBe(GIANT);

    // The verbatim tail is never capped: keep the giant text in the tail by
    // not splitting (a huge budget) and read the served context.
    const uncut = await sdk.threadView.compact({ filePath }, { params: { ...params, lowerBound: 100_000 } });
    expect(uncut.ok && uncut.value.parts).toBeUndefined();
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const tailTexts = context.value.messages.map((m) => m.content.map((c) => c.text).join(""));
    expect(tailTexts).toContain(GIANT);
    expect(tailTexts.some((t) => t.includes("elided at construction"))).toBe(false);

    // Close, drain: the smoothed_prompt floor written by the close-time path is
    // the uncapped clean prompt, while the stored rendering is capped.
    await sdk.intakeStream.messageEvents({ filePath }, [validEvent("turn_end")]);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    const db = openRaw(filePath);
    try {
      const rendering = db
        .prepare(`SELECT content FROM derivation WHERE subject_id = 't2' AND derivation_type = 'turn_rendering'`)
        .get() as { content: string };
      expect(rendering.content).toContain("exact content: m5 …]");
      const floors = db
        .prepare(`SELECT content FROM derivation WHERE subject_id = 'm4' AND derivation_type = 'smoothed_prompt'`)
        .get() as { content: string } | undefined;
      expect(floors?.content.includes("elided at construction")).toBe(false);
    } finally {
      db.close();
    }
  });
});
