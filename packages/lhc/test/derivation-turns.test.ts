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
  countLiveItems,
  initLhc,
  deterministicText,
  enqueue,
  estimateTokens,
  runInTransaction,
  threads,
  type BatchResult,
  type InferenceCallbacks,
  type DrainReport,
  type EnqueueInput,
  type Lhc,
  type MessageEventInput,
  type ProviderResult,
  type RenderingPart,
  type SdkConfig,
} from "../src/index.js";
import {
  createProviderDouble,
  openRaw,
  readChunks,
  readDerivedForms,
  tempStore,
  validEvent,
  type TempStore,
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

function manualSdk(
  inferenceCallbacks: InferenceCallbacks,
  chunkPolicy?: SdkConfig["chunkPolicy"],
): Lhc {
  const config: SdkConfig = {
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  };
  if (chunkPolicy !== undefined) config.chunkPolicy = chunkPolicy;
  return initLhc(config);
}

async function send(
  sdk: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<BatchResult> {
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
async function sendTurn(
  sdk: Lhc,
  filePath: string,
  prompt: string,
  answer: string,
): Promise<void> {
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: prompt } }),
    validEvent("assistant_text", { payload: { text: answer } }),
    validEvent("turn_end"),
  ]);
}

function formOf(filePath: string, subjectId: string, derivationType: string) {
  return readDerivedForms(filePath).find(
    (f) => f.subjectId === subjectId && f.derivationType === derivationType,
  );
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

// The story-sanctioned re-queue path for TC-3.3/TC-3.8: the Story 1 queue
// util driven directly inside a real transaction (the public re-queue
// operation with refusal/idempotency semantics is Story 4's surface).
function requeueDirect(filePath: string, input: EnqueueInput): void {
  const db = openRaw(filePath);
  try {
    const row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as {
      thread_id: string;
    };
    runInTransaction(db, () => new Date(), row.thread_id, (ctx) => enqueue(ctx, input));
  } finally {
    db.close();
  }
}

// Callbacks that delegate to the deterministic double except for scripted
// lower-band projections — the seam tests use to pin projected token counts
// for the placement golden cases (the projection content is what placement
// arithmetic measures, exactly once, at landing).
function withScriptedProjections(
  base: InferenceCallbacks,
  next: () => string,
): InferenceCallbacks {
  return {
    smoothPrompt: (i) => base.smoothPrompt(i),
    summarizeToolResult: (i) => base.summarizeToolResult(i),
    composeTurnRendering: (i) => base.composeTurnRendering(i),
    compressSmoothTurn: (): Promise<ProviderResult> =>
      Promise.resolve({ ok: true, text: next() }),
    summarizeChunkDetailed: (i) => base.summarizeChunkDetailed(i),
    summarizeChunkBrief: (i) => base.summarizeChunkBrief(i),
  };
}

describe("TC-3.1 / AC-3.1: a closed turn lands a rendering and a lower-band projection as independent rows", () => {
  it("all message forms ready → both turn forms ready, composed from the forms, each its own state row", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    const prompt = "compose this turn";
    const answer = "the composed answer";
    await sendTurn(sdk, filePath, prompt, answer);

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "done"],
      ["w-t1-turn_derivation-v1", "done"],
    ]);

    // Reconstruct the exact composition: the smoothed form verbatim, the
    // assistant text raw (never had a form) — proof the rendering consumed
    // forms, not raw re-derivation.
    const smoothed = deterministicText("smoothPrompt", { text: prompt }, prompt);
    const parts: RenderingPart[] = [
      { messageId: "m1", kind: "user_prompt", text: smoothed, fallback: false },
      { messageId: "m2", kind: "assistant_text", text: answer, fallback: false },
    ];
    const renderingText = parts.map((part) => part.text).join(" | ");
    const rendering = formOf(filePath, "t1", "turn_rendering");
    const projection = formOf(filePath, "t1", "smooth_turn_compression");
    expect(rendering).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: renderingText,
      sourceVersion: 1,
    });
    expect(rendering?.gaps).toBeUndefined();
    expect(projection).toMatchObject({
      subjectKind: "turn",
      state: "ready",
      content: deterministicText("compressSmoothTurn", { rendering: renderingText }, renderingText),
      sourceVersion: 1,
    });
    expect(liveCount(filePath)).toBe(0);
  });
});

describe("TC-3.2 / AC-3.2: a non-ready message form falls back and records a gap; the rendering still lands ready", () => {
  it("failed smoothing → rendering ready with the raw prompt text and a gap naming message and form", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    double.failKind("prompt_smoothing", 4, { retryable: true, reason: "scripted smoothing failure" });
    await sendTurn(sdk, filePath, "raw prompt one", "answer text");

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "failed_terminal"],
      ["w-t1-turn_derivation-v1", "done"],
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
    expect(log.value.map((entry) => [entry.derivationType, entry.subjectId])).toEqual([
      ["smoothed_prompt", "m1"],
    ]);
    expect(formOf(filePath, "t1", "smooth_turn_compression")?.state).toBe("ready");
    expect(formOf(filePath, "m1", "smoothed_prompt")?.state).toBe("ready");
  });
});

describe("TC-3.3 / AC-3.3 (architecture risk): derived content stands after dependency repair; only an explicit rebuild refreshes it", () => {
  it("repairing the smoothing changes nothing; re-queueing the rendering rebuilds it at the next source version", async () => {
    const double = createProviderDouble();
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
    requeueDirect(filePath, {
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
    requeueDirect(filePath, {
      owner: "turns",
      kind: "turn_derivation",
      sourceRef: { turnId: "t1" },
      sourceVersion: 2,
      derivations: [
        { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering" },
        { subjectKind: "turn", subjectId: "t1", derivationType: "smooth_turn_compression" },
      ],
    });
    const rebuildReport = await drain(sdk, filePath);
    expect(rebuildReport.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-t1-turn_derivation-v2", "done"],
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
    const double = createProviderDouble();
    const captured = double.captureInputs();
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
      const summary =
        m.kind === "tool_call" ? m.text : formOf(filePath, m.id, "tool_result_summary")?.content;
      expect(summary).toBeDefined();
      expect(account).toContain(`${summary} ⇒ ${m.outcome}`);
    }
  });
});

describe("TC-3.5 / AC-3.5: placement is recorded with the turn and readable through turns", () => {
  it("draining a closed turn shows chunkId and memberIdx on the turn read-back", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "place me", "placed");

    await drain(sdk, filePath);
    const turns = await sdk.turns.listTurns({ filePath });
    expect(turns.ok).toBe(true);
    if (!turns.ok) return;
    expect(turns.value).toEqual([
      expect.objectContaining({ turnId: "t1", status: "closed", chunkId: "c1", memberIdx: 0 }),
    ]);
  });
});

describe("TC-3.6 / AC-3.6 (architecture risk): the accumulated close rule — the crossing turn is excluded", () => {
  const PROJ = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";

  it("three turns at ~equal size: the third's placement closes the chunk holding two, and the third opens chunk 2", async () => {
    const per = estimateTokens(PROJ);
    const double = createProviderDouble();
    const callbacks = withScriptedProjections(double, () => PROJ);
    const sdk = manualSdk(callbacks, {
      targetProjectedTokens: 2 * per + 1,
      maxProjectedTokens: 100 * per,
    });
    const filePath = await newThread();
    for (let i = 1; i <= 3; i += 1) await sendTurn(sdk, filePath, `prompt ${i}`, `answer ${i}`);

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
    const per = estimateTokens(PROJ);
    const double = createProviderDouble();
    const callbacks = withScriptedProjections(double, () => PROJ);
    const sdk = manualSdk(callbacks, {
      targetProjectedTokens: 2 * per,
      maxProjectedTokens: 100 * per,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "first", "one");
    await sendTurn(sdk, filePath, "second", "two");

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

describe("TC-3.7 / AC-3.7: a single projection at or above the max forms its own chunk, closed immediately", () => {
  const BIG = "omega ".repeat(120).trim();

  it("one oversized turn → its own closed chunk with both summaries derived", async () => {
    const big = estimateTokens(BIG);
    const double = createProviderDouble();
    const callbacks = withScriptedProjections(double, () => BIG);
    const sdk = manualSdk(callbacks, {
      targetProjectedTokens: big,
      maxProjectedTokens: big,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "huge turn", "huge answer");

    await drain(sdk, filePath);
    expect(readChunks(filePath)).toEqual({
      chunks: [
        { chunkId: "c1", chunkOrder: 1, status: "closed", accumulatedProjectedTokens: big },
      ],
      members: [{ chunkId: "c1", turnId: "t1", memberIdx: 0 }],
    });
    expect(formOf(filePath, "c1", "chunk_summary_detailed")?.state).toBe("ready");
    expect(formOf(filePath, "c1", "chunk_summary_brief")?.state).toBe("ready");
  });

  it("an oversized turn arriving behind an open chunk closes both: the open chunk without it, its own chunk with it", async () => {
    const SMALL = "tiny projection text";
    const big = estimateTokens(BIG);
    const projections = [SMALL, BIG];
    const double = createProviderDouble();
    const callbacks = withScriptedProjections(double, () => {
      const next = projections.shift();
      if (next === undefined) throw new Error("scripted projections exhausted");
      return next;
    });
    // target = max = big: the small turn sits safely under both; the big
    // turn's arrival crosses the target (small + big ≥ big) and its own
    // projection meets the max.
    const sdk = manualSdk(callbacks, {
      targetProjectedTokens: big,
      maxProjectedTokens: big,
    });
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "small turn", "small answer");
    await sendTurn(sdk, filePath, "huge turn", "huge answer");

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
    const double = createProviderDouble();
    const sdk = manualSdk(double, SELF_CHUNK);
    const filePath = await newThread();
    await sendTurn(sdk, filePath, "summarize me", "summarized");

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.kind, entry.disposition])).toEqual([
      ["prompt_smoothing", "done"],
      ["turn_derivation", "done"],
      ["chunk_summary_detailed", "done"],
      ["chunk_summary_brief", "done"],
    ]);
    const detailed = formOf(filePath, "c1", "chunk_summary_detailed");
    const brief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(detailed?.state).toBe("ready");
    expect(brief?.state).toBe("ready");
    // Detailed is deterministic material assembly; brief still goes through
    // its own inference operation over projections + outcomes.
    const memberProjections = [formOf(filePath, "t1", "smooth_turn_compression")?.content ?? ""];
    expect(detailed?.content).toBe(memberProjections.join(" | "));
    expect(brief?.content).toBe(
      deterministicText(
        "summarizeChunkBrief",
        { memberProjections, memberOutcomes: [[]] },
        memberProjections.join(" | "),
      ),
    );
    expect(detailed?.content).not.toBe(brief?.content);
  });

  it("detailed preserves the tool-run receipts; brief strips them to outcomes only (SV-3.8-001)", async () => {
    const double = createProviderDouble();
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
    // receives the run outcome only — no receipt account text anywhere in its
    // input, so brief structurally cannot preserve more.
    const briefInput = captured.find((entry) => entry.op === "summarizeChunkBrief")?.input;
    expect(captured.some((entry) => entry.op === "summarizeChunkDetailed")).toBe(false);
    expect(briefInput).toEqual({
      memberProjections: [formOf(filePath, "t1", "smooth_turn_compression")?.content],
      memberOutcomes: [["failed"]],
    });
    for (const summary of [callA, resultA, callB, resultB]) {
      expect(JSON.stringify(briefInput)).not.toContain(summary as string);
    }

    // Artifact evidence: the detailed summary carries the run receipt's
    // account and outcome; the brief summary carries the run outcome and none
    // of the receipt content.
    const detailed = formOf(filePath, "c1", "chunk_summary_detailed");
    const brief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(detailed?.state).toBe("ready");
    expect(brief?.state).toBe("ready");
    expect(detailed?.content).toContain(`${account}=>failed`);
    expect(brief?.content).toContain("[outcomes failed]");
    expect(brief?.content).not.toContain("toolcall(");
    expect(brief?.content).not.toContain("toolresult(");
  });

  it("the brief item fails past budget alone: detailed ready, brief failed, brief re-queueable by itself", async () => {
    const double = createProviderDouble();
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
      ["chunk_summary_detailed", "done"],
      ["chunk_summary_brief", "failed_terminal"],
    ]);
    const detailedBefore = formOf(filePath, "c1", "chunk_summary_detailed");
    expect(detailedBefore?.state).toBe("ready");
    const failedBrief = formOf(filePath, "c1", "chunk_summary_brief");
    expect(failedBrief?.state).toBe("failed");
    expect(failedBrief?.reason).toBe("scripted brief failure");

    // Re-queue the brief alone through the queue util (Story 4 owns the
    // public surface); the detailed form must not move.
    requeueDirect(filePath, {
      owner: "turns",
      kind: "chunk_summary_brief",
      sourceRef: { chunkId: "c1" },
      derivations: [{ subjectKind: "chunk", subjectId: "c1", derivationType: "chunk_summary_brief" }],
    });
    const requeued = await drain(sdk, filePath);
    expect(requeued.ran.map((entry) => [entry.kind, entry.disposition])).toEqual([
      ["chunk_summary_brief", "done"],
    ]);
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
      const double = createProviderDouble();
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
