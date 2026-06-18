// Story 4 (Epic 02): derivation state, report, and repair — Flow 4. The
// four-state lifecycle proven on forms the pipeline landed for real
// (TC-4.1), retrying-vs-first-wait read from the report's queue join without
// any queue API (TC-4.2, architecture risk), exact owner scoping and the
// exact not-ready set (TC-4.3), explicit re-queue through the owning
// surfaces landing ready with the failure cleared (TC-4.4, background mode
// proving the poke), requeue idempotency against live work (TC-4.5), the
// blocked-source path with its refusal carrying the stored damage reason
// (TC-4.6, architecture risk), and degrade-don't-block reads with every
// non-ready state present at once (TC-4.7, architecture risk).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countLiveItems,
  createSdk,
  queueDetail,
  setSchedulerPoke,
  setThreadTouch,
  threads,
  type BatchResult,
  type InferenceCallbacks,
  type DrainReport,
  type DerivationReportEntry,
  type Lhc,
  type MessageEventInput,
  type SdkConfig,
} from "../src/index.js";
import {
  corruptTwoOpenTurns,
  createProviderDouble,
  damagedSourceThread,
  GAPPED_SMOOTHING_REASON,
  gappedRenderingThread,
  openRaw,
  readDerivedForms,
  tempStore,
  validEvent,
  type ProviderDouble,
  type TempStore,
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
  provider: InferenceCallbacks,
  overrides: Partial<Pick<SdkConfig, "retry" | "chunkPolicy" | "clock">> = {},
): Lhc {
  const config: SdkConfig = {
    provider,
    mode: "manual",
    retry: overrides.retry ?? { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  };
  if (overrides.chunkPolicy !== undefined) config.chunkPolicy = overrides.chunkPolicy;
  if (overrides.clock !== undefined) config.clock = overrides.clock;
  return createSdk(config);
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

async function drain(
  sdk: Lhc,
  filePath: string,
  opts?: { maxItems?: number },
): Promise<DrainReport> {
  const result = await sdk.work.drain({ filePath }, opts);
  if (!result.ok) throw new Error(`drain failed: ${result.error.reason}`);
  return result.value;
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

function rawDetail(filePath: string): ReturnType<typeof queueDetail> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db);
  } finally {
    db.close();
  }
}

function entryOf(
  entries: readonly DerivationReportEntry[],
  subjectId: string,
  derivationType: string,
): DerivationReportEntry | undefined {
  return entries.find(
    (entry) => entry.subjectId === subjectId && entry.derivationType === derivationType,
  );
}

async function reportOf(
  sdk: Lhc,
  filePath: string,
  owner: "messages" | "turns",
  opts?: { notReady?: boolean },
): Promise<DerivationReportEntry[]> {
  const result =
    owner === "messages"
      ? await sdk.messages.report({ filePath }, opts)
      : await sdk.turns.report({ filePath }, opts);
  if (!result.ok) throw new Error(`${owner} report failed: ${result.error.reason}`);
  return result.value;
}

// ── the mixed-state thread: every form state landed for real ─────
// Three prompt turns through real intake; the double exhausts the first
// prompt's smoothing (failed), the below-SDK corruption blocks both turn
// derivations, maxItems leaves the third prompt's smoothing untouched
// (pending with a live queued item), and the second prompt smooths clean
// (ready). No below-SDK state writes — the pipeline produced every state.
const MIXED_FAILED_REASON = "provider_failure: scripted exhaustion";

async function mixedStateThread(): Promise<{
  sdk: Lhc;
  double: ProviderDouble;
  filePath: string;
  drainReport: DrainReport;
}> {
  const double = createProviderDouble();
  const sdk = manualSdk(double);
  const filePath = await newThread();
  double.failKind("prompt_smoothing", 3, {
    retryable: true,
    reason: MIXED_FAILED_REASON,
  });
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "first prompt" } }),
    validEvent("turn_end"),
  ]);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "second prompt" } }),
    validEvent("turn_end"),
  ]);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "third prompt, left open" } }),
  ]);
  corruptTwoOpenTurns(filePath);
  const drainReport = await drain(sdk, filePath, { maxItems: 4 });
  return { sdk, double, filePath, drainReport };
}

describe("TC-4.1 / AC-4.1: every landed form reads back in exactly one of the four states", () => {
  it("ready, failed-via-exhaustion, pending-via-unprocessed-queue, and blocked-via-damage land and read back; failed carries the stable reason", async () => {
    const { sdk, filePath, drainReport } = await mixedStateThread();
    expect(drainReport.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "failed_terminal"],
      ["w-t1-turn_derivation-v1", "failed_terminal"],
      ["w-m3-prompt_smoothing-v1", "done"],
      ["w-t2-turn_derivation-v1", "failed_terminal"],
    ]);
    expect(drainReport.stoppedBecause).toBe("max_items");
    expect(drainReport.remaining).toBe(1);

    const messageEntries = await reportOf(sdk, filePath, "messages");
    const turnEntries = await reportOf(sdk, filePath, "turns");

    const failed = entryOf(messageEntries, "m1", "smoothed_prompt");
    expect(failed?.state).toBe("failed");
    // The stable reason code, plus the final attempts/last-error copied onto
    // the form at exhaustion (DD-1: the queue row is gone; this is durable).
    expect(failed?.reason).toBe(MIXED_FAILED_REASON);
    expect(failed?.metadata).toEqual({ attempts: 3, lastError: MIXED_FAILED_REASON });

    expect(entryOf(messageEntries, "m3", "smoothed_prompt")?.state).toBe("ready");
    expect(entryOf(messageEntries, "m5", "smoothed_prompt")?.state).toBe("pending");
    expect(entryOf(turnEntries, "t1", "turn_rendering")?.state).toBe("blocked");
    expect(entryOf(turnEntries, "t1", "turn_rendering")?.reason).toContain("source_damaged");

    // Exactly one of the four states on every row, both owners.
    for (const entry of [...messageEntries, ...turnEntries]) {
      expect(["pending", "ready", "failed", "blocked"]).toContain(entry.state);
    }
  });
});

describe("TC-4.2 / AC-4.2 (architecture risk): retrying reads from pending + queue detail in the report row itself", () => {
  it("a form mid-retry reports pending with attempts=1 and the last error joined in — no queue API, distinguishable from first-wait", async () => {
    const double = createProviderDouble();
    // Frozen clock + non-zero backoff hold the retry window open
    // deterministically: the failed attempt re-queues with eligible_at past
    // the (never-advancing) clock, so the drain stops on "waiting" and the
    // item sits mid-retry for the report to join.
    const frozen = new Date("2026-06-11T10:00:00.000Z");
    const sdk = manualSdk(double, {
      clock: () => frozen,
      retry: { budget: 3, backoffBaseMs: 50, backoffCapMs: 60000 },
    });
    const filePath = await newThread();
    double.failNext(1, { retryable: true, reason: "transient provider blip" });
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "retry me" } }),
      validEvent("turn_end"),
    ]);

    const report = await drain(sdk, filePath);
    expect(report.stoppedBecause).toBe("waiting");
    expect(report.ran).toEqual([]);

    const entries = await reportOf(sdk, filePath, "messages");
    const retrying = entryOf(entries, "m1", "smoothed_prompt");
    expect(retrying?.state).toBe("pending");
    expect(retrying?.queue).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "transient provider blip",
    });
    expect(retrying?.queue?.eligibleAt).toBeDefined();

    // First-wait contrast: the turn derivation behind the backing-off head
    // has never been attempted — pending with attempts 0 and no error. The
    // two situations read apart from the same single artifact state.
    const turnEntries = await reportOf(sdk, filePath, "turns");
    const waiting = entryOf(turnEntries, "t1", "turn_rendering");
    expect(waiting?.state).toBe("pending");
    expect(waiting?.queue).toMatchObject({ status: "queued", attempts: 0 });
    expect(waiting?.queue?.lastError).toBeUndefined();
  });
});

describe("TC-4.3 / AC-4.3: owner scoping is exact and notReady is exact set equality", () => {
  it("each owner reports only its own forms; notReady returns exactly the failed+pending+blocked set", async () => {
    const { sdk, filePath } = await mixedStateThread();

    const messageEntries = await reportOf(sdk, filePath, "messages");
    expect(messageEntries.every((entry) => entry.subjectKind === "message")).toBe(true);
    expect(messageEntries.map((entry) => [entry.subjectId, entry.state])).toEqual([
      ["m1", "failed"],
      ["m3", "ready"],
      ["m5", "pending"],
    ]);

    const turnEntries = await reportOf(sdk, filePath, "turns");
    expect(
      turnEntries.every((entry) => entry.subjectKind === "turn" || entry.subjectKind === "chunk"),
    ).toBe(true);
    expect(turnEntries.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["t1", "smooth_turn_compression", "blocked"],
      ["t1", "turn_rendering", "blocked"],
      ["t2", "smooth_turn_compression", "blocked"],
      ["t2", "turn_rendering", "blocked"],
    ]);

    // notReady: exactly the non-ready set — m2's ready row drops, nothing else.
    const notReadyMessages = await reportOf(sdk, filePath, "messages", { notReady: true });
    expect(notReadyMessages.map((entry) => [entry.subjectId, entry.state])).toEqual([
      ["m1", "failed"],
      ["m5", "pending"],
    ]);
    const notReadyTurns = await reportOf(sdk, filePath, "turns", { notReady: true });
    expect(notReadyTurns).toHaveLength(4);
    expect(notReadyTurns.every((entry) => entry.state === "blocked")).toBe(true);

    // Subject filters scope to exactly the named subject's forms.
    const oneMessage = await sdk.messages.report({ filePath }, { messageId: "m1" });
    expect(oneMessage.ok && oneMessage.value.map((entry) => entry.subjectId)).toEqual(["m1"]);
    const oneTurn = await sdk.turns.report({ filePath }, { turnId: "t2" });
    expect(oneTurn.ok && oneTurn.value.map((entry) => entry.subjectId)).toEqual(["t2", "t2"]);
  });

  it("chunk summaries report under the turns owner, never under messages", async () => {
    const double = createProviderDouble();
    // Policy 1/1: every turn's projection meets max, so each turn closes its
    // own chunk immediately and both summary kinds queue and run.
    const sdk = manualSdk(double, {
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk one prompt" } }),
      validEvent("assistant_text", { payload: { text: "chunk one answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    double.failKind("chunk_summary_brief", 3, {
      retryable: true,
      reason: "provider_failure: scripted brief exhaustion",
    });
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk two prompt" } }),
      validEvent("assistant_text", { payload: { text: "chunk two answer" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const turnEntries = await reportOf(sdk, filePath, "turns");
    const chunkEntries = turnEntries.filter((entry) => entry.subjectKind === "chunk");
    expect(chunkEntries.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["c1", "chunk_summary_brief", "ready"],
      ["c1", "chunk_summary_detailed", "ready"],
      ["c2", "chunk_summary_brief", "failed"],
      ["c2", "chunk_summary_detailed", "ready"],
    ]);

    const notReady = await reportOf(sdk, filePath, "turns", { notReady: true });
    expect(notReady.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["c2", "chunk_summary_brief", "failed"],
    ]);

    // Cross-owner leakage check, both directions.
    const messageEntries = await reportOf(sdk, filePath, "messages");
    expect(messageEntries.every((entry) => entry.subjectKind === "message")).toBe(true);
    expect(turnEntries.some((entry) => entry.subjectKind === "message")).toBe(false);

    // The chunk filter scopes to exactly the named chunk's summary forms.
    const oneChunk = await sdk.turns.report({ filePath }, { chunkId: "c2" });
    expect(oneChunk.ok && oneChunk.value.map((entry) => [entry.subjectId, entry.derivationType])).toEqual([
      ["c2", "chunk_summary_brief"],
      ["c2", "chunk_summary_detailed"],
    ]);
  });
});

describe("TC-4.4 / AC-4.4: re-queue through the owning surface lands the form ready with the failure cleared", () => {
  it("messages.requeue returns a failed smoothing to the pipeline; the commit poke alone drives the repair in background mode", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const { filePath, messageId } = await gappedRenderingThread(store, sdk, double);

    // DD-1 ground truth: the exhausted item's row is gone, which is what
    // lets the deterministic id insert below without collision.
    expect(liveCount(filePath)).toBe(0);
    const before = formOf(filePath, messageId, "smoothed_prompt");
    expect(before?.state).toBe("failed");
    expect(before?.reason).toBe(GAPPED_SMOOTHING_REASON);

    // Background SDK first, so the requeue's poke-on-commit has a scheduler
    // to land on; the repair must then run with no drain call at all.
    const background = createSdk({
      provider: double,
      mode: "background",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
      lease: { durationMs: 200 },
    });
    const requeued = await background.messages.requeue(
      { filePath },
      { messageId, derivationType: "smoothed_prompt" },
    );
    expect(requeued.ok).toBe(true);
    if (!requeued.ok) return;
    expect(requeued.value).toEqual({ workItemId: "w-m1-prompt_smoothing-v2" });

    await background.drainSettled({ filePath });

    const repaired = formOf(filePath, messageId, "smoothed_prompt");
    expect(repaired?.state).toBe("ready");
    expect(repaired?.sourceVersion).toBe(2);
    expect(repaired?.content).toContain("smoothed(");
    // No failure residue: reason and the copied attempts/last-error are gone.
    expect(repaired?.reason).toBeUndefined();
    expect(repaired?.metadata).toBeUndefined();
    expect(liveCount(filePath)).toBe(0);

    const entries = await reportOf(sdk, filePath, "messages");
    expect(entryOf(entries, messageId, "smoothed_prompt")).toMatchObject({
      state: "ready",
      sourceVersion: 2,
    });
  });

  it("turns.requeue rebuilds a fallback-composed rendering at the next source version", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const { filePath, messageId, turnId } = await gappedRenderingThread(store, sdk, double);
    const beforeRepair = formOf(filePath, turnId, "turn_rendering");

    // Repair the dependency first (now healthy), then rebuild the composition.
    const repairSmoothing = await sdk.messages.requeue(
      { filePath },
      { messageId, derivationType: "smoothed_prompt" },
    );
    expect(repairSmoothing.ok).toBe(true);
    await drain(sdk, filePath);
    expect(formOf(filePath, messageId, "smoothed_prompt")?.state).toBe("ready");
    // No auto-cascade: the rendering row is still exactly the fallback-composed row.
    expect(formOf(filePath, turnId, "turn_rendering")).toEqual(beforeRepair);

    const rebuild = await sdk.turns.requeue(
      { filePath },
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
    );
    expect(rebuild.ok).toBe(true);
    if (!rebuild.ok) return;
    expect(rebuild.value).toEqual({ workItemId: "w-t1-turn_derivation-v2" });

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-t1-turn_derivation-v2", "done"],
    ]);
    const rebuilt = formOf(filePath, turnId, "turn_rendering");
    expect(rebuilt?.state).toBe("ready");
    expect(rebuilt?.sourceVersion).toBe(2);
    expect(rebuilt?.gaps).toBeUndefined();
    // Both turn forms ride the one derivation item: the projection rebuilt too.
    expect(formOf(filePath, turnId, "smooth_turn_compression")).toMatchObject({
      state: "ready",
      sourceVersion: 2,
    });
  });
});

describe("TC-4.5 / AC-4.5: re-queue is idempotent against live work", () => {
  it("the second requeue before draining is an explicit no-op; one live item, no duplicates", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const { filePath, messageId } = await gappedRenderingThread(store, sdk, double);

    const first = await sdk.messages.requeue(
      { filePath },
      { messageId, derivationType: "smoothed_prompt" },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toEqual({ workItemId: "w-m1-prompt_smoothing-v2" });

    const second = await sdk.messages.requeue(
      { filePath },
      { messageId, derivationType: "smoothed_prompt" },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual({ noop: "already_queued" });

    // Queue read-back: exactly one live item for the form.
    const detail = rawDetail(filePath);
    expect(detail.map((row) => [row.workItemId, row.status])).toEqual([
      ["w-m1-prompt_smoothing-v2", "queued"],
    ]);

    const report = await drain(sdk, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v2", "done"],
    ]);
    expect(formOf(filePath, messageId, "smoothed_prompt")?.state).toBe("ready");
    // One row per form by key — drain left no duplicate artifacts behind.
    const smoothings = readDerivedForms(filePath).filter(
      (form) => form.subjectId === messageId && form.derivationType === "smoothed_prompt",
    );
    expect(smoothings).toHaveLength(1);
  });
});

describe("TC-4.6 / AC-4.6 (architecture risk): source damage lands blocked, the drain continues, and requeue refuses with the stored reason", () => {
  it("a turn derivation over the two-open-turns corruption blocks naming the damage; blocked is not failed — requeue is refused", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double);
    const { filePath, turnId } = await damagedSourceThread(store);

    const report = await drain(sdk, filePath);
    // Truth-table shape: the blocked item reports failed_terminal and its row
    // is deleted; the drain continued past it to the later smoothing.
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "done"],
      ["w-t1-turn_derivation-v1", "failed_terminal"],
      ["w-m4-prompt_smoothing-v1", "done"],
    ]);
    expect(report.ran[1]?.reason).toContain("source_damaged");
    expect(liveCount(filePath)).toBe(0);

    const rendering = formOf(filePath, turnId, "turn_rendering");
    expect(rendering?.state).toBe("blocked");
    expect(rendering?.reason).toContain("source_damaged");
    expect(rendering?.reason).toContain("open");
    expect(formOf(filePath, turnId, "smooth_turn_compression")?.state).toBe("blocked");

    // The report surfaces the blocked rows with their reasons.
    const notReady = await reportOf(sdk, filePath, "turns", { notReady: true });
    expect(notReady.map((entry) => [entry.subjectId, entry.derivationType, entry.state])).toEqual([
      ["t1", "smooth_turn_compression", "blocked"],
      ["t1", "turn_rendering", "blocked"],
    ]);

    // The refusal carries the form's stored reason — not a generic string.
    const refused = await sdk.turns.requeue(
      { filePath },
      { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("source_damaged");
    expect(refused.error.errorClass).toBe("state_corruption");
    expect(refused.error.reason).toBe(rendering?.reason);

    // Refused means refused: nothing queued, nothing changed.
    expect(liveCount(filePath)).toBe(0);
    expect(formOf(filePath, turnId, "turn_rendering")).toEqual(rendering);
  });
});

describe("TC-4.7 / AC-4.7 (architecture risk): reads degrade, never block", () => {
  it("with every non-ready state present at once, message and turn reads return full records with states attached and zero errors", async () => {
    const { sdk, filePath } = await mixedStateThread();

    const messagesRead = await sdk.messages.listMessages({ filePath });
    expect(messagesRead.ok).toBe(true);
    if (!messagesRead.ok) return;
    expect(messagesRead.value.map((record) => record.messageId)).toEqual(["m1", "m3", "m5"]);
    const formStates = new Map(
      messagesRead.value.map((record) => [
        record.messageId,
        record.derivations?.map((form) => form.state),
      ]),
    );
    expect(formStates.get("m1")).toEqual(["failed"]);
    expect(formStates.get("m3")).toEqual(["ready"]);
    expect(formStates.get("m5")).toEqual(["pending"]);

    const turnsRead = await sdk.turns.listTurns({ filePath });
    expect(turnsRead.ok).toBe(true);
    if (!turnsRead.ok) return;
    // Full records back, including the corrupt extra open turn — the read
    // reports what is stored and never errors over incomplete derivation.
    expect(turnsRead.value.map((record) => record.turnId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(turnsRead.value[0]).toMatchObject({
      turnId: "t1",
      status: "closed",
      memberMessageIds: ["m1"],
    });

    // Turn form states ride the turn read directly (ruling 012): both
    // closed turns carry their blocked forms; the open turns have no rows
    // and no key — mirroring the message read's contract.
    const turnFormStates = new Map(
      turnsRead.value.map((record) => [
        record.turnId,
        record.derivations?.map((form) => [form.derivationType, form.state]),
      ]),
    );
    expect(turnFormStates.get("t1")).toEqual([
      ["smooth_turn_compression", "blocked"],
      ["turn_rendering", "blocked"],
    ]);
    expect(turnFormStates.get("t2")).toEqual([
      ["smooth_turn_compression", "blocked"],
      ["turn_rendering", "blocked"],
    ]);
    expect(turnFormStates.get("t3")).toBeUndefined();
    expect(turnFormStates.get("t4")).toBeUndefined();

    const eventsRead = await sdk.intakeStream.listEvents({ filePath });
    expect(eventsRead.ok).toBe(true);
  });

  it("chunk reads return records with summary-form states attached, including non-ready ones", async () => {
    const double = createProviderDouble();
    const sdk = manualSdk(double, {
      chunkPolicy: { targetProjectedTokens: 1, maxProjectedTokens: 1 },
    });
    const filePath = await newThread();
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk read prompt one" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);
    double.failKind("chunk_summary_brief", 3, {
      retryable: true,
      reason: "provider_failure: scripted brief exhaustion",
    });
    await send(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "chunk read prompt two" } }),
      validEvent("turn_end"),
    ]);
    await drain(sdk, filePath);

    const chunksRead = await sdk.turns.listChunks({ filePath });
    expect(chunksRead.ok).toBe(true);
    if (!chunksRead.ok) return;
    expect(chunksRead.value.map((record) => [record.chunkId, record.status])).toEqual([
      ["c1", "closed"],
      ["c2", "closed"],
    ]);
    expect(chunksRead.value[0]?.memberTurnIds).toEqual(["t1"]);
    const chunkFormStates = chunksRead.value.map((record) =>
      record.derivations?.map((form) => [form.derivationType, form.state]),
    );
    expect(chunkFormStates).toEqual([
      [
        ["chunk_summary_brief", "ready"],
        ["chunk_summary_detailed", "ready"],
      ],
      [
        ["chunk_summary_brief", "failed"],
        ["chunk_summary_detailed", "ready"],
      ],
    ]);
    // The failed summary's read carries its stored reason — degraded, not
    // blocking, and never an error.
    const failedBrief = chunksRead.value[1]?.derivations?.find(
      (form) => form.derivationType === "chunk_summary_brief",
    );
    expect(failedBrief?.reason).toBe("provider_failure: scripted brief exhaustion");
  });
});
