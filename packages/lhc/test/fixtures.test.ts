import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EventKind } from "../src/index.js";
import { conversationTurn, eventBatch, openRaw, tempStore, validEvent } from "./fixtures/index.js";

const ALL_KINDS: readonly EventKind[] = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "model_change",
  "thinking_level_change",
  "tool_call",
  "tool_result",
  "turn_end",
];

const GOLDEN_PAYLOAD_KEYS: Record<EventKind, string[]> = {
  user_prompt: ["text"],
  assistant_text: ["text"],
  assistant_thinking: ["text"],
  runtime_note: ["text"],
  model_change: ["previousModel", "newModel"],
  thinking_level_change: ["previousLevel", "newLevel"],
  tool_call: ["toolCallId", "toolName", "arguments"],
  tool_result: ["toolCallId", "content", "isError"],
  turn_end: [],
};

describe("FC-0.4: fixture builders", () => {
  it("validEvent produces a golden-shaped event for every kind", () => {
    for (const kind of ALL_KINDS) {
      const event = validEvent(kind);
      expect(event.eventKind).toBe(kind);
      expect(event.idempotencyKey.length).toBeGreaterThan(0);
      expect(event.actor.length).toBeGreaterThan(0);
      expect(event.harness.length).toBeGreaterThan(0);
      expect(Object.keys(event.payload).sort()).toEqual([...GOLDEN_PAYLOAD_KEYS[kind]].sort());
      expect(Object.keys(event).sort()).toEqual(["actor", "eventKind", "harness", "idempotencyKey", "payload"].sort());
    }
  });

  it("validEvent applies overrides without changing the kind", () => {
    const event = validEvent("user_prompt", {
      actor: "custom-actor",
      payload: { text: "custom prompt" },
    });
    expect(event.eventKind).toBe("user_prompt");
    expect(event.actor).toBe("custom-actor");
    expect(event.payload.text).toBe("custom prompt");
  });

  it("building an invalid kind/payload pairing requires an explicit cast", () => {
    const forced = validEvent("user_prompt", {
      // @ts-expect-error — a tool_call payload on a user_prompt event must not compile
      payload: { toolCallId: "x", toolName: "y", arguments: {} },
    });
    expect(forced.eventKind).toBe("user_prompt");
  });

  it("eventBatch yields unique idempotency keys in order", () => {
    const batch = eventBatch(ALL_KINDS);
    expect(batch.map((e) => e.eventKind)).toEqual([...ALL_KINDS]);
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(batch.length);
  });

  it("conversationTurn is one complete turn", () => {
    expect(conversationTurn().map((e) => e.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
  });

  it("tempStore creates an isolated directory and cleans it up", () => {
    const store = tempStore();
    expect(existsSync(store.dir)).toBe(true);
    expect(store.registryPath.startsWith(store.dir)).toBe(true);
    const a = store.threadPath();
    const b = store.threadPath();
    expect(a).not.toBe(b);
    store.cleanup();
    expect(existsSync(store.dir)).toBe(false);
  });

  it("openRaw opens a real sqlite handle for below-SDK assertions", () => {
    const store = tempStore();
    const path = store.threadPath("raw");
    const writer = openRaw(path);
    writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)");
    writer.exec("INSERT INTO probe (note) VALUES ('hello')");
    writer.close();
    const reader = openRaw(path);
    const row = reader.prepare("SELECT note FROM probe WHERE id = 1").get() as { note: string } | undefined;
    expect(row?.note).toBe("hello");
    reader.close();
    store.cleanup();
  });
});

// ── Story 0 (Epic 02): inference callbacks double, shared types, fixture builders ──

import { afterEach, beforeEach } from "vitest";
import {
  type Derivation,
  type InferenceCallbacks,
  type InferenceResult,
  initLhc,
  intakeStream,
  messages,
  turns,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  damagedSourceThread,
  multiStateThread,
  readDerivedForms,
  type TempStore,
  threadWithClosedTurns,
  threadWithToolRun,
} from "./fixtures/index.js";

// One call per operation with a fixed, distinct input — the operation sweep
// FC-0.1/FC-0.2 iterate.
function callAllOperations(double: InferenceCallbacks): Array<Promise<InferenceResult>> {
  return [
    double.smoothPrompt({ text: "please smooth this prompt text" }),
    double.summarizeToolResult({ toolName: "read_file", content: "tool result content" }),
    double.composeTurnRendering({
      parts: [{ messageId: "m1", kind: "user_prompt", text: "smoothed prompt", fallback: false }],
    }),
    double.compressSmoothTurn({
      rendering: "the rendering text",
      inputTokens: 10,
      targetMinTokens: 4,
      targetAimTokens: 5,
      targetMaxTokens: 7,
    }),
    double.summarizeChunkDetailed({ memberProjections: ["projection one", "projection two"] }),
    double.summarizeChunkBrief({
      text: "detailed projection text",
      inputTokens: 10,
      targetMinTokens: 1,
      targetAimTokens: 2,
      targetMaxTokens: 3,
    }),
  ];
}

const OPERATION_MARKERS = ["smoothed", "toolresult", "rendering", "projection", "detailed", "brief"] as const;

describe("FC-0.1 / FC-0.2: deterministic inference callbacks double", () => {
  it("FC-0.1: implements all operations with marked, input-derived output", async () => {
    const results = await Promise.all(callAllOperations(createInferenceCallbacksDouble()));
    for (const [index, result] of results.entries()) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.text.startsWith(`${OPERATION_MARKERS[index]}(`)).toBe(true);
    }
    // Input-derived, not canned: a different input to the same operation
    // yields different marked output.
    const double = createInferenceCallbacksDouble();
    const a = await double.smoothPrompt({ text: "first input" });
    const b = await double.smoothPrompt({ text: "second input" });
    if (!a.ok || !b.ok) throw new Error("double failed unscripted");
    expect(a.text).not.toBe(b.text);
    expect(a.text).toContain("first input");
  });

  it("FC-0.2: identical input yields identical output across double instances; operations are distinguishable", async () => {
    const first = await Promise.all(callAllOperations(createInferenceCallbacksDouble()));
    const second = await Promise.all(callAllOperations(createInferenceCallbacksDouble()));
    expect(first).toEqual(second);
    const texts = first.map((r) => (r.ok ? r.text : ""));
    expect(new Set(texts).size).toBe(6);
    expect(texts.map((t) => t.slice(0, t.indexOf("(")))).toEqual([...OPERATION_MARKERS]);
  });

  it("FC-0.2: failNext drives fail-N-then-succeed with the scripted retryability", async () => {
    const double = createInferenceCallbacksDouble();
    double.failNext(2, { retryable: true });
    const r1 = await double.smoothPrompt({ text: "x" });
    const r2 = await double.summarizeChunkBrief({
      text: "y",
      inputTokens: 10,
      targetMinTokens: 1,
      targetAimTokens: 2,
      targetMaxTokens: 3,
    });
    const r3 = await double.smoothPrompt({ text: "x" });
    expect(r1).toMatchObject({ ok: false, retryable: true });
    expect(r2).toMatchObject({ ok: false, retryable: true });
    expect(r3.ok).toBe(true);
    // ...and exactly N calls consumed the script: the recovered output is
    // the deterministic one a fresh double produces.
    const fresh = await createInferenceCallbacksDouble().smoothPrompt({ text: "x" });
    expect(r3).toEqual(fresh);
  });

  it("FC-0.2: failKind scripts terminal failure per operation, by kind alias, without touching other kinds", async () => {
    const double = createInferenceCallbacksDouble();
    double.failKind("prompt_smoothing", 99, { retryable: false, reason: "content refusal" });
    const failed = await double.smoothPrompt({ text: "x" });
    expect(failed).toEqual({ ok: false, retryable: false, reason: "content refusal" });
    const other = await double.summarizeToolResult({ toolName: "t", content: "c" });
    expect(other.ok).toBe(true);
  });

  it("FC-0.2: delayKind injects latency on the scripted operation", async () => {
    const double = createInferenceCallbacksDouble();
    double.delayKind("chunk_summary_detailed", 40);
    const before = Date.now();
    const result = await double.summarizeChunkDetailed({ memberProjections: ["p"] });
    const elapsed = Date.now() - before;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it("scripting and capture state are per-instance — nothing leaks across doubles", async () => {
    const scripted = createInferenceCallbacksDouble();
    const clean = createInferenceCallbacksDouble();
    const capturedScripted = scripted.captureInputs();
    scripted.failNext(1);
    const cleanResult = await clean.smoothPrompt({ text: "untouched" });
    expect(cleanResult.ok).toBe(true);
    expect(capturedScripted).toHaveLength(0);
    const capturedClean = clean.captureInputs();
    await clean.compressSmoothTurn({
      rendering: "r",
      inputTokens: 10,
      targetMinTokens: 4,
      targetAimTokens: 5,
      targetMaxTokens: 7,
    });
    expect(capturedClean).toEqual([
      {
        op: "compressSmoothTurn",
        input: {
          rendering: "r",
          inputTokens: 10,
          targetMinTokens: 4,
          targetAimTokens: 5,
          targetMaxTokens: 7,
        },
      },
    ]);
    expect(capturedScripted).toHaveLength(0);
    const scriptedResult = await scripted.smoothPrompt({ text: "untouched" });
    expect(scriptedResult.ok).toBe(false);
    expect(capturedScripted).toEqual([{ op: "smoothPrompt", input: { text: "untouched" } }]);
  });
});

describe("FC-0.1 (production seam): initLhc assembles with the double injected where production adapters go", () => {
  it("resolves config defaults centrally and carries the injected inference callbacks and mode", () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
    expect(sdk.config.inferenceCallbacks).toBe(double);
    expect(sdk.config.mode).toBe("manual");
    expect(sdk.config.retry).toEqual({ budget: 3, backoffBaseMs: 5000, backoffCapMs: 60000 });
    expect(sdk.config.lease).toEqual({ durationMs: 120000 });
    expect(sdk.config.chunkPolicy).toEqual({
      targetProjectedTokens: 2200,
      maxProjectedTokens: 4400,
    });
    expect(sdk.scheduler.mode).toBe("manual");
    // The Epic 01 surfaces ride the assembled SDK.
    expect(sdk.threads.newThread).toBeTypeOf("function");
    expect(sdk.intakeStream.messageEvents).toBeTypeOf("function");
    expect(sdk.intakeStream.initLhc).toBeTypeOf("function");
  });

  it("background mode is a validated construction option (behavior lands in Story 1)", () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "background" });
    expect(sdk.scheduler.mode).toBe("background");
    expect(() => sdk.scheduler.poke("th_x")).not.toThrow();
  });

  it("rejects malformed config at construction: bad mode, incomplete callbacks, bad policy values", () => {
    const double = createInferenceCallbacksDouble();
    expect(() => initLhc({ inferenceCallbacks: double, mode: "later" as unknown as "manual" })).toThrow(/mode/);
    const incomplete = { smoothPrompt: double.smoothPrompt.bind(double) };
    expect(() => initLhc({ inferenceCallbacks: incomplete as unknown as InferenceCallbacks, mode: "manual" })).toThrow(
      /missing operation/,
    );
    expect(() =>
      initLhc({
        inferenceCallbacks: double,
        mode: "manual",
        chunkPolicy: { targetProjectedTokens: 4400, maxProjectedTokens: 2200 },
      }),
    ).toThrow(/chunkPolicy/);
    expect(() =>
      initLhc({
        inferenceCallbacks: double,
        mode: "manual",
        retry: { budget: 0, backoffBaseMs: 0, backoffCapMs: 0 },
      }),
    ).toThrow(/retry.budget/);
  });
});

describe("FC-0.3 / FC-0.6: derived-form vocabulary and thread builders, verified by read-back", () => {
  let store: TempStore;
  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  it("threadWithClosedTurns: n closed turns read back closed with their members", async () => {
    const { filePath, turnIds } = await threadWithClosedTurns(store, 2);
    expect(turnIds).toEqual(["t1", "t2"]);
    const listed = await turns.listTurns({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((t) => [t.turnId, t.status])).toEqual([
      ["t1", "closed"],
      ["t2", "closed"],
      ["t3", "open"],
    ]);
    expect(listed.value.map((t) => t.memberMessageIds.length)).toEqual([2, 2, 0]);
  });

  it("threadWithToolRun: call+result pair recorded; error and missing-result variants hold their shapes", async () => {
    const paired = await threadWithToolRun(store);
    const pairedMessages = await messages.list({ filePath: paired.filePath });
    expect(pairedMessages.ok).toBe(true);
    if (!pairedMessages.ok) return;
    expect(pairedMessages.value.map((m) => m.kind)).toEqual(["user_prompt", "tool_call", "tool_result"]);

    const errored = await threadWithToolRun(store, { isError: true });
    const erroredMessages = await messages.list({ filePath: errored.filePath });
    expect(erroredMessages.ok).toBe(true);
    if (!erroredMessages.ok) return;
    const resultBlock = erroredMessages.value[2]?.blocks[0];
    expect(resultBlock?.content.isError).toBe(true);

    const missing = await threadWithToolRun(store, { missingResult: true });
    const missingMessages = await messages.list({ filePath: missing.filePath });
    expect(missingMessages.ok).toBe(true);
    if (!missingMessages.ok) return;
    expect(missingMessages.value.map((m) => m.kind)).toEqual(["user_prompt", "tool_call"]);
  });

  it("FC-0.6: the multi-state thread reads back every claimed state — all four in one file", async () => {
    const { filePath, expected } = await multiStateThread(store);
    const forms = readDerivedForms(filePath);
    for (const claim of expected) {
      const match = forms.find(
        (f) =>
          f.subjectKind === claim.subjectKind &&
          f.subjectId === claim.subjectId &&
          f.derivationType === claim.derivationType,
      );
      expect(match, `${claim.subjectKind}/${claim.subjectId}/${claim.derivationType}`).toBeDefined();
      expect(match?.state).toBe(claim.state);
    }
    const states = new Set(forms.map((f) => f.state));
    expect([...states].sort()).toEqual(["blocked", "failed", "pending", "ready"]);
    // State-shape contract: ready carries content, failed/blocked carry
    // reasons, pending carries neither.
    for (const form of forms) {
      if (form.state === "ready") expect(form.content).toBeDefined();
      if (form.state === "failed" || form.state === "blocked") {
        expect(form.reason).toBeDefined();
        expect(form.content).toBeUndefined();
      }
      if (form.state === "pending") {
        expect(form.content).toBeUndefined();
        expect(form.reason).toBeUndefined();
      }
    }
  });

  it("FC-0.3: tool-activity outcome lives in machine-readable metadata, never inside content", async () => {
    const { filePath } = await multiStateThread(store);
    const toolForm = readDerivedForms(filePath).find((f) => f.derivationType === "tool_result_summary");
    expect(toolForm).toBeDefined();
    expect(toolForm?.metadata).toEqual({ outcome: "succeeded" });
    expect(toolForm?.content).not.toContain("succeeded");
    // The shared vocabulary is the compile-time contract both owning domains
    // consume; this read shape is that type.
    const typed: Derivation | undefined = toolForm;
    expect(typed?.state).toBe("ready");
  });

  it("FC-0.6: the damaged-source thread reads back the corruption it claims (Epic 01 definition)", async () => {
    const { filePath, turnId } = await damagedSourceThread(store);
    expect(turnId).toBe("t1");
    const db = openRaw(filePath);
    try {
      const open = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'open'").get() as { n: number | bigint };
      expect(Number(open.n)).toBe(2);
    } finally {
      db.close();
    }
    // The damage is live: intake refuses the file as corrupt, exactly as
    // Epic 01 defines the state.
    const rejected = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("turn_state_corrupt");
    // The queued turn_derivation work the damage sits under is still there.
    const queueDb = openRaw(filePath);
    try {
      const queued = queueDb.prepare("SELECT kind FROM work_item WHERE owner = 'turns' ORDER BY rowid").all() as Array<{
        kind: string;
      }>;
      expect(queued.map((item) => item.kind)).toEqual(["turn_derivation"]);
    } finally {
      queueDb.close();
    }
  });
});
