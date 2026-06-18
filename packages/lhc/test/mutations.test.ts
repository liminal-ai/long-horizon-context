// Story 5 (Epic 02): messages.edit and the mutation cascade — Flow 5's edit
// half. One synchronous transaction carries the content change, the token
// re-stamp, and the full dependent-chain clear-and-requeue (TC-5.1), with
// induced-failure atomicity proving a failing cascade step rolls back the
// content change too (architecture risk). Cascade reach is proven in both
// directions — exactly the chain cleared, everything outside it byte-stable
// including source versions (TC-5.2, architecture risk). Post-return no
// pre-edit derivation is ready and replacements sit queued at the new source
// version, with superseded queued ids reported and their rows gone (TC-5.3).
// TC-5.4 is the epic's named architecture-risk test: a claimed pre-edit item
// held across the edit by the delayed double completes after the post-edit
// rebuild is queued, discards on the source-version mismatch as
// stale_discarded, and the post-edit artifact stands. Refusals (open turn,
// turnless no-membership target, missing id, deleted target through the
// filtered view) change nothing (TC-5.5). The CLI parity leg of TC-5.6 lives in
// cli-process-mutations.test.ts (process suite).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DrainReport,
  deterministicText,
  estimateTokens,
  type InferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type MutationResult,
  messages,
  type OpResult,
  queueDetail,
  type SdkConfig,
  setSchedulerPoke,
  setThreadTouch,
  threads,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
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
  setSchedulerPoke(null);
  setThreadTouch(null);
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
  overrides: Partial<Pick<SdkConfig, "chunkPolicy" | "clock" | "mode">> = {},
): Lhc {
  const config: SdkConfig = {
    inferenceCallbacks,
    mode: overrides.mode ?? "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 5000 },
  };
  if (overrides.chunkPolicy !== undefined) config.chunkPolicy = overrides.chunkPolicy;
  if (overrides.clock !== undefined) config.clock = overrides.clock;
  return initLhc(config);
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

async function drain(sdk: Lhc, filePath: string): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath });
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
}

function rawDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

function clearKey(entry: { subjectKind: string; subjectId: string; derivationType: string }): string {
  return `${entry.subjectKind}/${entry.subjectId}/${entry.derivationType}`;
}

function unwrap<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.code}`);
  return result.value;
}

// One closed prompt+answer turn (m1 prompt, t1), drained ready. Under the
// default chunk policy t1's chunk stays open, so no chunk summary rows exist.
async function readyTurnThread(sdk: Lhc): Promise<string> {
  const filePath = await newThread();
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "original prompt" } }),
    validEvent("assistant_text", { payload: { text: "the original answer" } }),
    validEvent("turn_end"),
  ]);
  await drain(sdk, filePath);
  return filePath;
}

// The full mutation read-back surface in one snapshot: record, forms, queue.
async function snapshot(filePath: string): Promise<unknown> {
  return {
    messages: unwrap(await messages.listMessages({ filePath })),
    derivations: readDerivedForms(filePath),
    queue: rawDetail(filePath),
  };
}

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("TC-5.1 / AC-5.1: edit updates content, blocks, and estimate synchronously, reporting the cascade", () => {
  it("changes the record in the edit's transaction and names cleared forms and queued items", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await readyTurnThread(sdk);

    const result = await messages.edit({ filePath }, { messageId: "m1", content: "edited prompt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual({ messageIds: ["m1"], turnIds: [] });
    expect(result.value.dropped).toEqual([]);
    // The chain above m1: its own smoothing and t1's two forms. t1's chunk is
    // still open — no summary rows exist, so none are named.
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      ["message/m1/smoothed_prompt", "turn/t1/smooth_turn_compression", "turn/t1/turn_rendering"].sort(),
    );
    expect([...result.value.queued].sort((a, b) => a.workItemId.localeCompare(b.workItemId))).toEqual([
      { workItemId: "w-m1-prompt_smoothing-v2", kind: "prompt_smoothing" },
      { workItemId: "w-t1-turn_derivation-v2", kind: "turn_derivation" },
    ]);
    expect(result.value.superseded).toEqual([]);

    // Synchronous, before any drain: content, blocks, and the re-stamped
    // estimate read back changed.
    const m1 = unwrap(await messages.listMessages({ filePath })).find((record) => record.messageId === "m1");
    expect(m1?.blocks).toEqual([{ blockType: "text", content: { text: "edited prompt" } }]);
    expect(m1?.tokenEstimate).toBe(estimateTokens("edited prompt"));

    // The queued rebuilds run through the normal drain and derive from the
    // edited content.
    await drain(sdk, filePath);
    const smoothing = readDerivedForms(filePath).find(
      (form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt",
    );
    expect(smoothing?.state).toBe("ready");
    expect(smoothing?.content).toBe(deterministicText("smoothPrompt", { text: "edited prompt" }, "edited prompt"));
  });

  it("induced cascade failure rolls back the content change too (atomicity, architecture risk)", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await readyTurnThread(sdk);

    // Plant a claimed row at the exact id the cascade's replacement enqueue
    // will insert. Supersede only deletes queued rows, so the insert hits a
    // primary-key conflict mid-cascade — after the content apply — and the
    // transaction must roll back whole.
    const db = openRaw(filePath);
    db.prepare(
      `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
       VALUES (?, 'messages', 'prompt_smoothing', ?, 'claimed', ?, ?)`,
    ).run(
      "w-m1-prompt_smoothing-v2",
      JSON.stringify({ messageId: "m1" }),
      "2026-06-11T00:00:00.000Z",
      JSON.stringify({ sourceVersion: 2, derivations: [] }),
    );
    db.close();

    const before = await snapshot(filePath);
    const result = await messages.edit({ filePath }, { messageId: "m1", content: "edited prompt" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("storage_failure");
    // Nothing changed: not the message content, not the estimate, not a
    // single form state or source version, not the queue.
    expect(await snapshot(filePath)).toEqual(before);
  });
});

describe("TC-5.2 / AC-5.2 (architecture risk): cascade reach is exact in both directions", () => {
  it("clears exactly the edited message's chain; the second chunk's forms are byte-stable", async () => {
    const double = createInferenceCallbacksDouble();
    // max=1: every turn's compression meets the maximum, so each turn forms
    // its own immediately closed chunk — two chunks, both with summaries.
    const sdk = manualSdk(double, {
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "first prompt" } }),
      validEvent("assistant_text", { payload: { text: "first answer" } }),
      validEvent("turn_end"),
    ]);
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "second prompt" } }),
      validEvent("assistant_text", { payload: { text: "second answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const before = readDerivedForms(filePath);
    // Fixture sanity: both chunks closed with every form ready.
    expect(before.map((form) => clearKey(form)).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "message/m4/smoothed_prompt",
        "turn/t1/smooth_turn_compression",
        "turn/t1/turn_rendering",
        "turn/t2/smooth_turn_compression",
        "turn/t2/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
        "chunk/c2/chunk_summary_brief",
        "chunk/c2/chunk_summary_detailed",
      ].sort(),
    );
    expect(before.every((form) => form.state === "ready")).toBe(true);

    const result = await messages.edit({ filePath }, { messageId: "m1", content: "rewritten first prompt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The cleared set is exactly the chain: m1's forms, t1's two, c1's two.
    expect(result.value.cleared.map(clearKey).sort()).toEqual(
      [
        "message/m1/smoothed_prompt",
        "turn/t1/smooth_turn_compression",
        "turn/t1/turn_rendering",
        "chunk/c1/chunk_summary_brief",
        "chunk/c1/chunk_summary_detailed",
      ].sort(),
    );

    // The untouched-set half: every form outside the chain — chunk 2's
    // summaries, t2's forms, m4's smoothing — deep-equal their pre-edit rows,
    // state and source version included.
    const clearedSet = new Set(result.value.cleared.map(clearKey));
    const after = readDerivedForms(filePath);
    expect(after.filter((form) => !clearedSet.has(clearKey(form)))).toEqual(
      before.filter((form) => !clearedSet.has(clearKey(form))),
    );
    // And the cleared half sits pending at the bumped version.
    for (const form of after.filter((candidate) => clearedSet.has(clearKey(candidate)))) {
      expect(form.state).toBe("pending");
      expect(form.sourceVersion).toBe(2);
      expect(form.content).toBeUndefined();
    }
  });
});

describe("TC-5.3 / AC-5.3: post-return, nothing pre-edit is ready; replacements queued at the new version; superseded reported", () => {
  it("clears to pending with version-scoped replacement ids, and a second edit supersedes the still-queued first wave", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, {
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "original prompt" } }),
      validEvent("assistant_text", { payload: { text: "the answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);

    const firstWaveIds = [
      "w-c1-chunk_summary_brief-v2",
      "w-c1-chunk_summary_detailed-v2",
      "w-m1-prompt_smoothing-v2",
      "w-t1-turn_derivation-v2",
    ];

    // Edit while everything is ready: every dependent form leaves ready in
    // the edit's transaction, replacement items carry the new source version
    // in their ids and payloads, and nothing was queued to supersede.
    const first = await messages.edit({ filePath }, { messageId: "m1", content: "first edit" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.superseded).toEqual([]);
    expect(first.value.queued.map((item) => item.workItemId).sort()).toEqual(firstWaveIds);
    const formsAfterFirst = readDerivedForms(filePath);
    expect(formsAfterFirst.every((form) => form.state === "pending")).toBe(true);
    expect(formsAfterFirst.every((form) => form.sourceVersion === 2)).toBe(true);
    const queueAfterFirst = rawDetail(filePath);
    expect(queueAfterFirst.map((row) => row.workItemId).sort()).toEqual(firstWaveIds);
    expect(queueAfterFirst.every((row) => row.status === "queued" && row.sourceVersion === 2)).toBe(true);

    // Second edit before any drain: the still-queued first wave is
    // supersede-deleted in the cascade transaction and reported; the queue
    // holds only the v3 replacements.
    const second = await messages.edit({ filePath }, { messageId: "m1", content: "second edit" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect([...second.value.superseded].sort()).toEqual(firstWaveIds);
    const queueAfterSecond = rawDetail(filePath);
    expect(queueAfterSecond.map((row) => row.workItemId).sort()).toEqual([
      "w-c1-chunk_summary_brief-v3",
      "w-c1-chunk_summary_detailed-v3",
      "w-m1-prompt_smoothing-v3",
      "w-t1-turn_derivation-v3",
    ]);
    expect(readDerivedForms(filePath).every((form) => form.state === "pending" && form.sourceVersion === 3)).toBe(true);

    // And the drain rebuilds the whole chain from the second edit's content.
    await drain(sdk, filePath);
    const smoothing = readDerivedForms(filePath).find(
      (form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt",
    );
    expect(smoothing?.state).toBe("ready");
    expect(smoothing?.content).toBe(deterministicText("smoothPrompt", { text: "second edit" }, "second edit"));
  });
});

describe("TC-5.4 / AC-5.4 (architecture risk): the version check beats the straggler", () => {
  it("a claimed pre-edit item completing after the edit discards as stale_discarded; the post-edit artifact wins", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "original prompt" } }),
      validEvent("turn_end"),
    ]);

    // Hold the old-content smoothing in flight: the drain claims it, the
    // handler awaits the delayed double, and the edit lands inside that
    // window — a real claimed old-version item held across the edit, not a
    // simulated version poke.
    double.delayKind("prompt_smoothing", 400);
    const captured = double.captureInputs();
    const drainPromise = sdk.work.drain({ filePath });
    await until(
      () => captured.some((call) => call.op === "smoothPrompt"),
      "the old-content smoothing to be claimed and in-handler",
    );

    const edited = await messages.edit({ filePath }, { messageId: "m1", content: "edited prompt" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // The still-queued turn derivation behind the claimed head was
    // superseded; the claimed item was left to the version check.
    expect(edited.value.superseded).toEqual(["w-t1-turn_derivation-v1"]);

    // Old claimed item and post-edit replacement coexist — ids include the
    // source version, so they never collide.
    const mid = rawDetail(filePath);
    expect(mid.map((row) => [row.workItemId, row.status])).toEqual([
      ["w-m1-prompt_smoothing-v1", "claimed"],
      ["w-m1-prompt_smoothing-v2", "queued"],
      ["w-t1-turn_derivation-v2", "queued"],
    ]);

    // Let both complete. The straggler's completion is a normal completion
    // reported stale_discarded — not an error, not a retry — and the drain
    // continues into the replacement work.
    const drained = await drainPromise;
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "stale_discarded"],
      ["w-m1-prompt_smoothing-v2", "done"],
      ["w-t1-turn_derivation-v2", "done"],
    ]);

    // Exactly one ready smoothing row, derived from the post-edit content at
    // the post-edit source version — regardless of completion order.
    const rows = readDerivedForms(filePath).filter(
      (form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "ready", sourceVersion: 2 });
    expect(rows[0]?.content).toBe(deterministicText("smoothPrompt", { text: "edited prompt" }, "edited prompt"));
    expect(rawDetail(filePath)).toEqual([]);
  }, 15000);
});

describe("TC-5.5 / AC-5.5: refusals are stable and change nothing", () => {
  it("refuses open-turn, missing, and deleted targets; read-back identical after each", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    // m1 in closed t1; m3 in open t2.
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "closed prompt" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open prompt" } }),
    ]);
    const before = await snapshot(filePath);

    const openTurn = await messages.edit({ filePath }, { messageId: "m3", content: "nope" });
    expect(openTurn.ok).toBe(false);
    if (openTurn.ok) return;
    expect(openTurn.error.errorClass).toBe("caller_error");
    expect(openTurn.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);

    const missing = await messages.edit({ filePath }, { messageId: "m99", content: "nope" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(before);

    // A deleted target reads as message_not_found through the filtered view
    // — never a distinct error. (deleted_at stamped below the SDK: the
    // delete operation itself is Story 6.)
    const db = openRaw(filePath);
    db.prepare(`UPDATE message SET deleted_at = ? WHERE message_id = 'm1'`).run("2026-06-11T00:00:00.000Z");
    db.close();
    const afterStamp = await snapshot(filePath);
    const deleted = await messages.edit({ filePath }, { messageId: "m1", content: "nope" });
    expect(deleted.ok).toBe(false);
    if (deleted.ok) return;
    expect(deleted.error.code).toBe("message_not_found");
    expect(await snapshot(filePath)).toEqual(afterStamp);
  });

  it("refuses a turnless (no-membership) target under the closed-turn boundary; read-back unchanged", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double);
    const filePath = await newThread();
    // A note before any prompt opens a turn lands in a gap: m1 with no turn
    // membership (turnId null). It exists and isn't deleted, so neither the
    // open-turn nor the message_not_found refusal would catch it — the
    // closed-turn boundary is the only gate that does.
    await send(sdk, filePath, [validEvent("runtime_note", { payload: { text: "a note before any turn" } })]);
    const m1 = unwrap(await messages.listMessages({ filePath })).find((record) => record.messageId === "m1");
    expect(m1?.turnId).toBeUndefined();

    const before = await snapshot(filePath);
    const turnless = await messages.edit({ filePath }, { messageId: "m1", content: "nope" });
    expect(turnless.ok).toBe(false);
    if (turnless.ok) return;
    expect(turnless.error.errorClass).toBe("caller_error");
    expect(turnless.error.code).toBe("turn_open");
    expect(await snapshot(filePath)).toEqual(before);
  });
});

describe("background mode: edit-and-walk-away (production path)", () => {
  it("the cascade's enqueue pokes ride the commit; rebuilds run with no further call", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = manualSdk(double, { mode: "background" });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "original prompt" } }),
      validEvent("assistant_text", { payload: { text: "the answer" } }),
      validEvent("turn_end"),
    ]);
    await sdk.drainSettled({ filePath });
    expect(readDerivedForms(filePath).every((form) => form.state === "ready")).toBe(true);

    const result: OpResult<MutationResult> = await messages.edit(
      { filePath },
      { messageId: "m1", content: "edited prompt" },
    );
    expect(result.ok).toBe(true);
    await sdk.drainSettled({ filePath });

    const smoothing = readDerivedForms(filePath).find(
      (form) => form.subjectId === "m1" && form.derivationType === "smoothed_prompt",
    );
    expect(smoothing).toMatchObject({ state: "ready", sourceVersion: 2 });
    expect(smoothing?.content).toBe(deterministicText("smoothPrompt", { text: "edited prompt" }, "edited prompt"));
    expect(rawDetail(filePath)).toEqual([]);
  });
});
