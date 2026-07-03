// Story 3 (Epic 02): turn composition and chunk formation — Flow 3. The
// turn_derivation handler composing from message forms with recorded
// fallback gaps (TC-3.2), the no-auto-cascade rule (TC-3.3, architecture
// risk), outcome-explicit tool-run accounts (TC-3.4), placement in the
// completion transaction (TC-3.5), the accumulated close policy's golden
// cases (TC-3.6/3.7, architecture risk), the two summary kinds with
// independent lifecycles (TC-3.8), and determinism under replay (TC-3.9,
// architecture risk). Every drain dispatches the production handlers
// registered by the turns domain at initLhc; the TC-3.3/TC-3.8 re-queues
// drive the queue util directly per the story note (the public re-queue
// surface is Story 4's).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BatchResult,
  countLiveItems,
  createDbWriteTransaction,
  type DrainReport,
  deterministicText,
  type EnqueueInput,
  enqueue,
  estimateTokens,
  type InferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type RenderingPart,
  type SdkConfig,
  threads,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  readChunks,
  readDerivedForms,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

async function newThread(): Promise<string> {
  const created = await threads.newThread({
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return created.value.filePath;
}

function manualSdk(inferenceCallbacks: InferenceCallbacks, chunkPolicy?: SdkConfig["chunkPolicy"]): Lhc {
  const config: SdkConfig = {
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
  };
  if (chunkPolicy !== undefined) config.chunkPolicy = chunkPolicy;
  return initLhc(config);
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<BatchResult> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
  return result.value;
}

async function drain(sdk: Lhc, filePath: string): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath });
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
}

// One closed prompt+answer turn through real intake.
async function sendTurn(sdk: Lhc, filePath: string, prompt: string, answer: string): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find((f) => f.subjectId === subjectId && f.derivationType === derivationType);
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

function deleteWorkItem(filePath: string, workItemId: string): void {
  const db = openRaw(filePath);
  try {
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ?`).run(workItemId);
  } finally {
    db.close();
  }
}

function dialogueAssemblyText(prompt: string, answer: string): string {
  return `User:\n${prompt}\n\n⏺ ${answer}`;
}

function assemblyTokens(prompt: string, answer: string): number {
  return estimateTokens(dialogueAssemblyText(prompt, answer));
}

function structuredRendering(parts: readonly RenderingPart[]): string {
  const labels: Record<RenderingPart["kind"], string> = {
    user_prompt: "User prompt",
    assistant_text: "Assistant response",
    assistant_thinking: "Assistant thinking",
    runtime_note: "Runtime note",
    model_change: "Model change",
    thinking_level_change: "Thinking level change",
    tool_call: "Tool call",
    tool_result: "Tool result",
  };
  return parts
    .map((part, index) => {
      const annotations = [
        part.fallback ? "fallback" : undefined,
        part.outcome === undefined ? undefined : `outcome: ${part.outcome}`,
      ].filter((annotation): annotation is string => annotation !== undefined);
      const suffix = annotations.length === 0 ? "" : ` [${annotations.join("; ")}]`;
      return `[${index + 1}] ${labels[part.kind]} (${part.messageId})${suffix}\n${part.text}`;
    })
    .join("\n\n");
}

// The story-sanctioned re-queue path for TC-3.3/TC-3.8: the Story 1 queue
// util driven directly inside a real transaction (the public re-queue
// operation with refusal/idempotency semantics is Story 4's surface).
async function requeueDirect(filePath: string, input: EnqueueInput): Promise<void> {
  const queued = await createDbWriteTransaction({ filePath }, (transaction) => enqueue(transaction, input));
  if (!queued.ok) throw new Error(`direct requeue failed: ${queued.error.reason}`);
}

describe("TC-3.1 / AC-3.1: a closed turn lands a rendering and smooth-turn compression as independent rows", () => {
  it("all message forms ready → both turn forms ready, composed from the forms, each its own state row", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    const prompt = "compose this turn";
    const answer = "the composed answer";
    await sendTurn(sdk, filePath, prompt, answer);

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "done"],
      ["w-t1-turn_derivation-v1", "done"],
      ["w-t1-detailed_turn_compression-v1", "done"],
    ]);

    // Reconstruct the exact composition: the smoothed form verbatim, the
    // assistant text raw (never had a form) — proof the rendering consumed
    // forms, not raw re-derivation.
    const smoothed = deterministicText("smoothPrompt", { text: prompt }, prompt);
    const parts: RenderingPart[] = [
      { messageId: "m1", kind: "user_prompt", text: smoothed, fallback: false },
      { messageId: "m2", kind: "assistant_text", text: answer, fallback: false },
    ];
    const renderingText = structuredRendering(parts);
    const assemblyText = dialogueAssemblyText(smoothed, answer);
    const inputTokens = estimateTokens(assemblyText);
    const compressionInput = {
      dialogueText: assemblyText,
      inputTokens,
      targetMinTokens: Math.max(1, Math.round(inputTokens * 0.35)),
      targetAimTokens: Math.max(1, Math.round(inputTokens * 0.5)),
      targetMaxTokens: Math.max(1, Math.round(inputTokens * 0.65)),
    };
    const rendering = formOf(filePath, "t1", "turn_rendering");
    const assembly = formOf(filePath, "t1", "pre_detailed_assembly");
    const compression = formOf(filePath, "t1", "detailed_turn_compression");
    expect(rendering).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: renderingText,
      sourceVersion: 1,
    });
    expect(rendering?.gaps).toBeUndefined();
    expect(assembly).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: assemblyText,
      sourceVersion: 1,
    });
    expect(compression).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: deterministicText("compressDetailedTurn", compressionInput, assemblyText),
      sourceVersion: 1,
    });
    expect(liveCount(filePath)).toBe(0);
  });
});

describe("TC-3.2 / AC-3.2: a non-ready message form falls back and records a gap; the rendering still lands ready", () => {
  it("failed smoothing → rendering ready with the raw prompt text and a gap naming message and form", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    double.failKind("prompt_smoothing", 4, { retryable: true, reason: "scripted smoothing failure" });
    await sendTurn(sdk, filePath, "raw prompt one", "answer text");

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "failed_terminal"],
      ["w-t1-turn_derivation-v1", "done"],
      ["w-t1-detailed_turn_compression-v1", "done"],
    ]);

    // Message-derivation fallback degrades the rendering's inputs; it does
    // not fail the turn. The ready row stays clean; the fallback is durable
    // in the log.
    const rendering = formOf(filePath, "t1", "turn_rendering");
    expect(rendering?.state).toBe("ready");
    expect(rendering?.content).toContain("raw prompt one");
    expect(rendering?.gaps).toBeUndefined();
    const log = await sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.map((entry) => [entry.derivationType, entry.subjectId])).toEqual([["smoothed_prompt", "m1"]]);
    expect(formOf(filePath, "t1", "detailed_turn_compression")?.state).toBe("ready");
    expect(formOf(filePath, "m1", "smoothed_prompt")?.state).toBe("ready");
  });

  it("does not re-run message inference for pending or failed message derivations during turn construction", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double);
    const filePath = await newThread();

    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "  pending prompt  " } }),
      validEvent("assistant_text", { payload: { text: "answer text" } }),
      validEvent("turn_end"),
    ]);
    deleteWorkItem(filePath, "w-m1-prompt_smoothing-v1");
    const callsBeforeTurn = captured.length;
    await drain(sdk, filePath);

    expect(captured.slice(callsBeforeTurn).filter((entry) => entry.op === "smoothPrompt")).toEqual([]);
    expect(formOf(filePath, "t1", "turn_rendering")).toMatchObject({ state: "ready" });
    expect(formOf(filePath, "t1", "detailed_turn_compression")).toMatchObject({ state: "ready" });
  });
});

describe("TC-3.3 / AC-3.3 (architecture risk): derived content stands after dependency repair; only an explicit rebuild refreshes it", () => {
  it("repairing the smoothing changes nothing; re-queueing the rendering rebuilds it at the next source version", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    double.failKind("prompt_smoothing", 4, { retryable: true, reason: "scripted smoothing failure" });
    await sendTurn(sdk, filePath, "gapped prompt", "gapped answer");
    await drain(sdk, filePath);
    const gapped = formOf(filePath, "t1", "turn_rendering");
    expect(gapped?.state).toBe("ready");
    expect(gapped?.gaps).toBeUndefined();
    const placedBefore = readChunks(filePath);

    // Leg 1: repair the failed smoothing through the queue util (now
    // healthy — the script above is consumed). The dependent must not move:
    // no live link, no auto-cascade, no queued turn work.
    await requeueDirect(filePath, {
      owner: "messages",
      kind: "prompt_smoothing",
      sourceRef: { messageId: "m1" },
      derivations: [{ subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" }],
    });
    const repairReport = await drain(sdk, filePath);
    expect(repairReport.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "done"],
    ]);
    expect(formOf(filePath, "m1", "smoothed_prompt")?.state).toBe("ready");
    // Byte-for-byte: the fallback-composed rendering is exactly the row that landed —
    // content, derivedAt, source version, all of it.
    expect(formOf(filePath, "t1", "turn_rendering")).toEqual(gapped);
    expect(liveCount(filePath)).toBe(0);

    // Leg 2: the explicit rebuild — turn_derivation re-queued at the next
    // source version through the queue util. Gaps recompute from current
    // dependency states: the smoothing is ready now, so the gap clears.
    await requeueDirect(filePath, {
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
      sourceVersion: 2,
      derivations: [
        { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering" },
        { subjectKind: "turn", subjectId: "t1", derivationType: "pre_detailed_assembly" },
      ],
    });
    const rebuildReport = await drain(sdk, filePath);
    expect(rebuildReport.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-t1-turn_derivation-v2", "done"],
      ["w-t1-detailed_turn_compression-v2", "done"],
    ]);
    const rebuilt = formOf(filePath, "t1", "turn_rendering");
    expect(rebuilt?.state).toBe("ready");
    expect(rebuilt?.sourceVersion).toBe(2);
    expect(rebuilt?.gaps).toBeUndefined();
    expect(rebuilt?.content).not.toBe(gapped?.content);
    // Rebuild keeps placement: membership is never re-cut by derivation —
    // the turn sits exactly where its first placement put it.
    expect(readChunks(filePath)).toEqual(placedBefore);
  });
});

describe("TC-3.4 / AC-3.4: tool runs compose as outcome-explicit accounts; a state-changing call's outcome survives", () => {
  it("a three-call edit run with one isError carries per-call outcomes into the composition input, from the forms", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    const call = (id: string, path: string) =>
      validEvent("tool_call", {
        payload: { toolCallId: id, toolName: "edit_file", arguments: { path } },
      });
    const result = (id: string, content: string, isError: boolean) =>
      validEvent("tool_result", { payload: { toolCallId: id, content, isError } });
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "edit three files" } }),
      call("call-a", "a.txt"),
      result("call-a", "edited a.txt", false),
      call("call-b", "b.txt"),
      result("call-b", "permission denied", true),
      call("call-c", "c.txt"),
      result("call-c", "edited c.txt", false),
      validEvent("turn_end"),
    ]);

    await drain(sdk, filePath);
    expect(formOf(filePath, "t1", "turn_rendering")?.state).toBe("ready");

    const rendering = formOf(filePath, "t1", "turn_rendering");
    const receipts = rendering?.metadata?.receipts ?? [];
    expect(receipts).toHaveLength(1);
    // Fix 2 grouping (AC-3.4): the three-call edit run folds into ONE run part
    // after the prompt — outcome-explicit, not one part per tool message.
    expect(receipts[0]?.messageId).toBe("m2");
    const run = receipts[0];
    // A run with any failed call reads failed at run level — the state-changing
    // failure cannot be lost — and the mixed tally stays explicit, never a
    // vague success.
    expect(run?.outcome).toBe("failed");
    const account = run?.account ?? "";
    expect(account).toContain("2 succeeded, 1 failed");
    expect(account).not.toMatch(/\b3 succeeded\b/);
    // Composition consumed the ready forms, not the raw record: every tool
    // message's summary form content rides the run account verbatim, each
    // stamped with its record outcome — the failed pair (m4/m5) included.
    const toolMessages = [
      { id: "m2", kind: "tool_call", outcome: "succeeded", text: 'edit_file({"path":"a.txt"})' },
      { id: "m3", kind: "tool_result", outcome: "succeeded" },
      { id: "m4", kind: "tool_call", outcome: "failed", text: 'edit_file({"path":"b.txt"})' },
      { id: "m5", kind: "tool_result", outcome: "failed" },
      { id: "m6", kind: "tool_call", outcome: "succeeded", text: 'edit_file({"path":"c.txt"})' },
      { id: "m7", kind: "tool_result", outcome: "succeeded" },
    ] as const;
    for (const m of toolMessages) {
      const summary = m.kind === "tool_call" ? m.text : formOf(filePath, m.id, "tool_result_summary")?.content;
      expect(summary).toBeDefined();
      expect(account).toContain(`${summary} ⇒ ${m.outcome}`);
    }
  });
});

describe("TC-3.5 / AC-3.5: placement is recorded with the turn and readable through turns", () => {
  it("draining a closed turn shows chunkId and memberIdx on the turn read-back", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "place me", "placed");

    await drain(sdk, filePath);
    const turns = await sdk.turns.listTurns({ filePath });
    expect(turns.ok).toBe(true);
    if (!turns.ok) return;
    expect(turns.value[0]).toEqual(
      expect.objectContaining({ turnId: "t1", status: "closed", chunkId: "c1", memberIdx: 0 }),
    );
  });
});

describe("TC-3.6 / AC-3.6 (architecture risk): the accumulated close rule — the crossing turn is excluded", () => {
  const PROMPT = "prompt text";
  const ANSWER = "answer text";
  const SMOOTHED = deterministicText("smoothPrompt", { text: PROMPT }, PROMPT);

  it("three turns at ~equal size: the third's placement closes the chunk holding two, and the third opens chunk 2", async () => {
    const per = assemblyTokens(SMOOTHED, ANSWER);
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      targetProjectedTokens: 2 * per + 1,
      maxProjectedTokens: 100 * per,
    });
    const filePath = await newThread();
    for (let i = 1; i <= 3; i += 1) await sendTurn(sdk, filePath, PROMPT, ANSWER);

    await drain(sdk, filePath);
    const snapshot = readChunks(filePath);
    expect(snapshot.chunks).toEqual([
      { chunkId: "c1", chunkOrder: 1, status: "closed", accumulatedProjectedTokens: 2 * per },
      { chunkId: "c2", chunkOrder: 2, status: "open", accumulatedProjectedTokens: per },
    ]);
    expect(snapshot.members).toEqual([
      { chunkId: "c1", turnId: "t1", memberIdx: 0 },
      { chunkId: "c1", turnId: "t2", memberIdx: 1 },
      { chunkId: "c2", turnId: "t3", memberIdx: 0 },
    ]);
    // The close queued both summary kinds for c1 and the drain ran them;
    // the still-open c2 has none.
    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
    expect(formOf(filePath, "c2", "chunk_summary_detailed")).toBeUndefined();
    expect(liveCount(filePath)).toBe(0);
  });

  it("threshold exactness: accumulated + incoming equal to the target closes (inclusive), holding only the prior member", async () => {
    const per = assemblyTokens(SMOOTHED, ANSWER);
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      targetProjectedTokens: 2 * per,
      maxProjectedTokens: 100 * per,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, PROMPT, ANSWER);
    await sendTurn(sdk, filePath, PROMPT, ANSWER);

    await drain(sdk, filePath);
    const snapshot = readChunks(filePath);
    expect(snapshot.members).toEqual([
      { chunkId: "c1", turnId: "t1", memberIdx: 0 },
      { chunkId: "c2", turnId: "t2", memberIdx: 0 },
    ]);
    expect(snapshot.chunks.map((chunk) => [chunk.chunkId, chunk.status])).toEqual([
      ["c1", "closed"],
      ["c2", "open"],
    ]);
  });
});

describe("TC-3.7 / AC-3.7: a single compression at or above the max forms its own chunk, closed immediately", () => {
  const BIG_ANSWER = "omega ".repeat(120).trim();

  it("one oversized turn → its own closed chunk with both summaries derived", async () => {
    const prompt = "huge turn";
    const smoothed = deterministicText("smoothPrompt", { text: prompt }, prompt);
    const big = assemblyTokens(smoothed, BIG_ANSWER);
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      targetProjectedTokens: big,
      maxProjectedTokens: big,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, prompt, BIG_ANSWER);

    await drain(sdk, filePath);
    expect(readChunks(filePath)).toEqual({
      chunks: [{ chunkId: "c1", chunkOrder: 1, status: "closed", accumulatedProjectedTokens: big }],
      members: [{ chunkId: "c1", turnId: "t1", memberIdx: 0 }],
    });
    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
  });

  it("an oversized turn arriving behind an open chunk closes both: the open chunk without it, its own chunk with it", async () => {
    const smallPrompt = "small turn";
    const smallAnswer = "small answer";
    const hugePrompt = "huge turn";
    const hugeSmoothed = deterministicText("smoothPrompt", { text: hugePrompt }, hugePrompt);
    const big = assemblyTokens(hugeSmoothed, BIG_ANSWER);
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      targetProjectedTokens: big,
      maxProjectedTokens: big,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, smallPrompt, smallAnswer);
    await sendTurn(sdk, filePath, hugePrompt, BIG_ANSWER);

    await drain(sdk, filePath);
    const snapshot = readChunks(filePath);
    expect(snapshot.chunks.map((chunk) => [chunk.chunkId, chunk.status])).toEqual([
      ["c1", "closed"],
      ["c2", "closed"],
    ]);
    expect(snapshot.members).toEqual([
      { chunkId: "c1", turnId: "t1", memberIdx: 0 },
      { chunkId: "c2", turnId: "t2", memberIdx: 0 },
    ]);
    for (const chunkId of ["c1", "c2"]) {
      expect(formOf(filePath, chunkId, "chunk_summary_detailed")?.state).toBe("ready");
      expect(formOf(filePath, chunkId, "chunk_summary_brief")?.state).toBe("ready");
    }
  });
});

describe("TC-3.8 / AC-3.8: chunk close queues two summary work items with independent lifecycles", () => {
  // target=max=1: every turn self-chunks and closes immediately, the
  // smallest deterministic way to manufacture closed chunks.
  const SELF_CHUNK = { targetProjectedTokens: 1, maxProjectedTokens: 1 };

  it("both summaries land ready as distinct chunk-level forms", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, SELF_CHUNK);
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "summarize me", "summarized");

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.kind, entry.disposition])).toEqual([
      ["prompt_smoothing", "done"],
      ["turn_derivation", "done"],
      ["detailed_turn_compression", "done"],
      ["chunk_summary_detailed", "done"],
      ["chunk_summary_brief", "done"],
    ]);
    const detailed = formOf(filePath, "c1", "chunk_summary_detailed");
    const brief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(detailed?.state).toBe("ready");
    expect(brief?.state).toBe("ready");
    // Detailed is deterministic material assembly; brief still goes through
    // its own inference operation over projections + outcomes.
    const memberProjections = [formOf(filePath, "t1", "detailed_turn_compression")?.content ?? ""];
    expect(detailed?.content).toBe(`[turn 0001]\n${memberProjections[0]}`);
    const briefInputText = detailed?.content ?? "";
    const briefInputTokens = estimateTokens(briefInputText);
    const briefInput = {
      text: briefInputText,
      inputTokens: briefInputTokens,
      targetMinTokens: Math.max(1, Math.round(briefInputTokens * 0.08)),
      targetAimTokens: Math.max(1, Math.round(briefInputTokens * 0.12)),
      targetMaxTokens: Math.max(1, Math.round(briefInputTokens * 0.2)),
    };
    expect(brief?.content).toBe(deterministicText("summarizeChunkBrief", briefInput, briefInputText));
    expect(brief?.metadata?.sizeDisposition).toBeDefined();
    expect(detailed?.content).not.toBe(brief?.content);
  });

  it("detailed preserves the tool-run receipts; brief consumes the detailed text", async () => {
    const double = createInferenceCallbacksDouble();
    const captured = double.captureInputs();
    const sdk = manualSdk(double, SELF_CHUNK);
    const filePath = await newThread();
    // The run-receipts fixture: a two-call edit run, one isError, closing
    // into its own chunk so both summaries derive over it.
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "edit two files" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "rcpt-a", toolName: "edit_file", arguments: { path: "ok.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "rcpt-a", content: "edited ok.txt", isError: false },
      }),
      validEvent("tool_call", {
        payload: { toolCallId: "rcpt-b", toolName: "edit_file", arguments: { path: "ro.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "rcpt-b", content: "read-only file", isError: true },
      }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    // Fix 2 grouping (AC-3.4/3.8): the two-call run folds into ONE receipt —
    // its account names each call's summary content with its record outcome,
    // and the run-level outcome is failed because one half failed. The summary
    // contents are what the detailed summary must preserve.
    const callA = 'edit_file({"path":"ok.txt"})';
    const resultA = formOf(filePath, "m3", "tool_result_summary")?.content;
    const callB = 'edit_file({"path":"ro.txt"})';
    const resultB = formOf(filePath, "m5", "tool_result_summary")?.content;
    const receipts = formOf(filePath, "t1", "turn_rendering")?.metadata?.receipts;
    expect(receipts).toHaveLength(1);
    const receipt = receipts?.[0];
    expect(receipt?.messageId).toBe("m2");
    expect(receipt?.activity).toBe("tool_call");
    expect(receipt?.outcome).toBe("failed");
    const account = receipt?.account ?? "";
    expect(account).toContain("1 succeeded, 1 failed");
    expect(account).toContain(`${callA} ⇒ succeeded`);
    expect(account).toContain(`${resultA} ⇒ succeeded`);
    expect(account).toContain(`${callB} ⇒ failed`);
    expect(account).toContain(`${resultB} ⇒ failed`);

    // Seam evidence: only the brief call crosses the inference boundary, and
    // it receives the detailed chunk text rather than raw member projections.
    const briefInput = captured.find((entry) => entry.op === "summarizeChunkBrief")?.input;
    const detailed = formOf(filePath, "c1", "chunk_summary_detailed");
    const detailedText = detailed?.content ?? "";
    expect(briefInput).toMatchObject({ text: detailedText });
    expect(JSON.stringify(briefInput)).not.toContain(
      formOf(filePath, "t1", "detailed_turn_compression")?.content ?? "",
    );
    expect(detailedText).toContain(`${account}=>failed`);
    for (const summary of [callA, resultA, callB, resultB]) expect(detailedText).toContain(summary as string);

    // Artifact evidence: detailed carries the run receipt's account and
    // outcome; brief is produced from detailed and carries size metadata.
    const brief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(detailed?.state).toBe("ready");
    expect(brief?.state).toBe("ready");
    expect(detailed?.content).toContain(`${account}=>failed`);
    expect(detailed?.content).toContain("[turn 0001]");
    expect(brief?.metadata?.sizeDisposition).toBeDefined();
  });

  it("the brief item fails past budget alone: detailed ready, brief failed, brief re-queueable by itself", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, SELF_CHUNK);
    const filePath = await newThread();
    double.failKind("chunk_summary_brief", 3, {
      retryable: true,
      reason: "scripted brief failure",
    });
    await sendTurn(sdk, filePath, "independent retry", "answer");

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.kind, entry.disposition])).toEqual([
      ["prompt_smoothing", "done"],
      ["turn_derivation", "done"],
      ["detailed_turn_compression", "done"],
      ["chunk_summary_detailed", "done"],
      ["chunk_summary_brief", "failed_terminal"],
    ]);
    const detailedBefore = formOf(filePath, "c1", "chunk_summary_detailed");
    expect(detailedBefore?.state).toBe("ready");
    const failedBrief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(failedBrief?.state).toBe("failed");
    expect(failedBrief?.reason).toBe("scripted brief failure");

    const derivationLog = await sdk.logging.queryDerivationLog(
      { filePath },
      { subjectId: "c1", derivationType: "chunk_summary_brief" },
    );
    expect(derivationLog.ok).toBe(true);
    if (!derivationLog.ok) return;
    expect(derivationLog.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "inference_failed",
          payload: expect.objectContaining({ reason: "scripted brief failure" }),
        }),
        expect.objectContaining({
          eventKind: "terminal_failed",
          payload: expect.objectContaining({ reason: "scripted brief failure" }),
        }),
      ]),
    );

    // Re-queue the brief alone through the queue util (Story 4 owns the
    // public surface); the detailed form must not move.
    await requeueDirect(filePath, {
      owner: "turns",
      kind: "chunk_summary_brief",
      sourceRef: { chunkId: "c1" },
      derivations: [{ subjectKind: "chunk", subjectId: "c1", derivationType: "chunk_summary_brief" }],
    });
    const requeued = await drain(sdk, filePath);
    expect(requeued.ran.map((entry) => [entry.kind, entry.disposition])).toEqual([["chunk_summary_brief", "done"]]);
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_detailed")).toEqual(detailedBefore);
  });
});

describe("TC-3.9 / AC-3.9 (architecture risk): chunk boundaries are deterministic under replay", () => {
  it("the same event stream into a fresh thread re-chunks identically — membership and boundaries deep-equal", async () => {
    const policy = { targetProjectedTokens: 60, maxProjectedTokens: 4400 };
    const turnsContent: Array<[string, string]> = [
      ["first prompt about the parser", "parser answer with detail"],
      ["second prompt about the cache", "cache answer, longer, with extra words"],
      ["third prompt about the index rebuild", "index answer"],
      ["fourth prompt, short", "fourth answer, also short"],
      ["fifth prompt to push past one chunk", "fifth answer closing things out"],
    ];

    async function buildAndDrain(): Promise<string> {
      const double = createInferenceCallbacksDouble();
      const sdk = manualSdk(double, policy);
      const filePath = await newThread();
      for (const [prompt, answer] of turnsContent) await sendTurn(sdk, filePath, prompt, answer);
      await drain(sdk, filePath);
      return filePath;
    }

    const first = await buildAndDrain();
    const second = await buildAndDrain();

    const firstSnapshot = readChunks(first);
    expect(firstSnapshot).toEqual(readChunks(second));
    // The replay claim is only meaningful if the policy actually cut: the
    // stream must span more than one chunk.
    expect(firstSnapshot.chunks.length).toBeGreaterThan(1);
    // No inference joined placement anywhere: the closed chunks' summary
    // artifacts are byte-identical across the two records too.
    const summariesOf = (filePath: string) =>
      readDerivedForms(filePath)
        .filter((form) => form.subjectKind === "chunk")
        .map((form) => [form.subjectId, form.derivationType, form.state, form.content]);
    expect(summariesOf(first)).toEqual(summariesOf(second));
  });
});
