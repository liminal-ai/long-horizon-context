// F1 — the bounded per-message construction cap. Construction behavior only:
// a giant message renders as head + marked elision (naming its exact-retrieval
// address) + tail; canonical keeps every byte, retrieval serves them, the
// verbatim tail serves them, and derivation floors are written uncapped.
import { copyFileSync } from "node:fs";
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

describe("the cap is a bounded-plan serving-time transformation", () => {
  it("parts and served renderings elide with a pointer; retrieval, the tail, the stored rendering, and the floors keep every byte; legacy serves the stored row verbatim", async () => {
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

    // Close, drain: the durable artifacts both plans consume are uncapped —
    // the stored turn_rendering row and the smoothed_prompt floor.
    await sdk.intakeStream.messageEvents({ filePath }, [validEvent("turn_end")]);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    const db = openRaw(filePath);
    let rendering: string;
    try {
      rendering = (
        db
          .prepare(`SELECT content FROM derivation WHERE subject_id = 't2' AND derivation_type = 'turn_rendering'`)
          .get() as { content: string }
      ).content;
      const floor = db
        .prepare(`SELECT content FROM derivation WHERE subject_id = 'm4' AND derivation_type = 'smoothed_prompt'`)
        .get() as { content: string } | undefined;
      expect(floor?.content.includes("elided at construction")).toBe(false);
    } finally {
      db.close();
    }
    expect(rendering).toContain(GIANT);
    expect(rendering).not.toContain("elided at construction");

    // The frozen differential: the same record, banded under each plan.
    // Legacy serves the stored row byte-for-byte; bounded serves it capped.
    const legacy = store.threadPath("legacy");
    const bounded = store.threadPath("bounded");
    copyFileSync(filePath, legacy);
    copyFileSync(filePath, bounded);
    const legacyBand = await servedSmooth(sdk, legacy, "legacy", params, "t2");
    expect(legacyBand.rung).toBe("turn_rendering");
    expect(legacyBand.text).toContain(rendering);
    expect(legacyBand.text).not.toContain("elided at construction");
    const boundedBand = await servedSmooth(sdk, bounded, "bounded", params, "t2");
    expect(boundedBand.rung).toBe("composed_in_walk");
    expect(boundedBand.text).toContain("exact content: m5 …]");
    expect(boundedBand.text).not.toContain(GIANT);
  });

  it("caps at the true message boundary when a body carries its own tag-shaped close text; legacy and durable bytes stay exact", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    // m2 is the giant message; its body carries "</m2>" early, then keeps going.
    const lines = GIANT.split("\n");
    const trap = [...lines.slice(0, 20), "</m2>", "<m2>", ...lines.slice(20)].join("\n");
    const sent = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "t1 prompt" } }),
      validEvent("assistant_text", { payload: { text: trap, stepIndex: 0 } }),
      validEvent("assistant_text", { payload: { text: "step 1 short", stepIndex: 1 } }),
    ]);
    expect(sent.ok).toBe(true);

    const params: ViewCompactParams = { lowerBound: 400, percentages: { full: 50, smooth: 50, detailed: 0, brief: 0 } };
    const prepared = await sdk.threadView.prepareCompact({ filePath }, { params });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const part = prepared.value.selection.entries.find((e) => e.part !== undefined)!;
    expect(part.part).toEqual({ fromStep: 0, toStep: 0 });
    // One cap over the whole body: the embedded close text sits inside the
    // kept head, the elision follows it, and nothing behind it leaks uncapped.
    const body = part.text.slice(part.text.indexOf("<m2>") + 4, part.text.lastIndexOf("</m2>"));
    expect(body.split("exact content: m2 …]")).toHaveLength(2);
    expect(body).toContain("line 19 of a very long");
    expect(body).toContain("\n</m2>\n<m2>\n");
    expect(body).not.toContain("line 150 of a very long");
    expect(body).toContain("line 299 of a very long");
    expect(part.tokens).toBeLessThan(CONSTRUCTION_MESSAGE_CAP_TOKENS + 400);

    // Durable and legacy bytes are exact.
    const exact = await sdk.retrieval.getMessages({ filePath }, ["m2"]);
    expect(exact.ok && exact.value.served[0]?.text).toBe(trap);
    await sdk.intakeStream.messageEvents({ filePath }, [validEvent("turn_end")]);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok && drained.value.remaining).toBe(0);
    const db = openRaw(filePath);
    const rendering = (
      db
        .prepare(`SELECT content FROM derivation WHERE subject_id = 't1' AND derivation_type = 'turn_rendering'`)
        .get() as { content: string }
    ).content;
    db.close();
    expect(rendering).toContain(trap);
    const legacy = store.threadPath("legacy-trap");
    copyFileSync(filePath, legacy);
    const legacyBand = await servedSmooth(sdk, legacy, "legacy", params, "t1");
    expect(legacyBand.rung).toBe("turn_rendering");
    expect(legacyBand.text).toContain(rendering);
    const boundedBand = await servedSmooth(sdk, filePath, "bounded", params, "t1");
    expect(boundedBand.rung).toBe("composed_in_walk");
    expect(boundedBand.text).toContain("exact content: m2 …]");
    expect(boundedBand.text).not.toContain("line 150 of a very long");
  });
});

// The smooth band a compact under one plan serves, with one subject's arrangement rung.
async function servedSmooth(
  sdk: ReturnType<typeof initLhc>,
  filePath: string,
  algorithm: "legacy" | "bounded",
  params: ViewCompactParams,
  subjectId: string,
): Promise<{ text: string; rung: string | undefined }> {
  const previous = process.env["LHC_COMPACT_ALGORITHM"];
  if (algorithm === "legacy") process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
  else delete process.env["LHC_COMPACT_ALGORITHM"];
  try {
    const receipt = await sdk.threadView.compact({ filePath }, { params });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) throw new Error(receipt.error.reason);
    const described = await sdk.threadView.describe({ filePath });
    if (!described.ok || described.value === null) throw new Error("no installed view");
    return {
      text: receipt.value.renderedBands.find((b) => b.band === "smooth")?.text ?? "",
      rung: described.value.arrangement.find((e) => e.subjectId === subjectId)?.derivationUsed,
    };
  } finally {
    if (previous === undefined) delete process.env["LHC_COMPACT_ALGORITHM"];
    else process.env["LHC_COMPACT_ALGORITHM"] = previous;
  }
}
