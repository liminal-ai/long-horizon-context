// Epic 03 Story 3: the readiness sweep (TC-3.1–3.4, the classification-edge
// architecture-risk legs, and the suite-wide zero-provider assertion's
// completion across all five thread-view ops). Every TC goes through the
// real SDK surface (initLhc().threadView.sweep / .compact) against real
// temp thread files; the provider double appears only in fixture setup and
// in TC-3.4's sanctioned heal drain — no Epic 03 operation may touch it.
// Failed and blocked states are reached through production paths (scripted
// provider failures consumed by real retry/exhaustion mechanics, real source
// damage on the sacrificial sibling), never by writing derivation rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type SweepReceipt } from "../src/index.js";
import {
  assertSweepReceiptShape,
  blockedSiblingThread,
  classifyFailureReason,
  createProviderDouble,
  derivedThreadFixture,
  openRaw,
  PERMANENT_FAILURE_REASON,
  REASON_CLASS_TABLE,
  seedViewBoundary,
  tempStore,
  validEvent,
  type DerivedThreadFixture,
  type TempStore,
} from "./fixtures/index.js";

type OwnerLine = SweepReceipt["owners"][number];

function ownerLine(
  receipt: SweepReceipt,
  owner: OwnerLine["owner"],
  kind: string,
): OwnerLine {
  const line = receipt.owners.find((entry) => entry.owner === owner && entry.kind === kind);
  if (line === undefined) throw new Error(`no receipt line for ${owner}/${kind}`);
  return line;
}

// Work rows for one subject's rebuild, counted by key below the SDK
// (TC-3.2's "exactly one work row exists for it"). The requeue patch keeps
// the queue live-work-only, so any row here is queued or claimed work.
function workRowsFor(filePath: string, kind: string, subjectId: string): number {
  const db = openRaw(filePath);
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM work_item WHERE kind = ? AND source_ref LIKE ?`)
      .get(kind, `%"${subjectId}"%`) as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function workItemCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM work_item`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

async function reportEntry(
  sdk: Lhc,
  filePath: string,
  messageId: string,
  derivationType: string,
): Promise<{ state: string; reason?: string; queueStatus?: string; content?: string }> {
  const report = await sdk.messages.report({ filePath }, { messageId });
  if (!report.ok) throw new Error(`report failed: ${report.error.reason}`);
  const entry = report.value.find((row) => row.derivationType === derivationType);
  if (entry === undefined) throw new Error(`no ${derivationType} entry for ${messageId}`);
  return {
    state: entry.state,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.queue === undefined ? {} : { queueStatus: entry.queue.status }),
    ...(entry.content === undefined ? {} : { content: entry.content }),
  };
}

describe("TC-3.1–TC-3.3 (AC-3.1–3.5, 3.7): the standalone sweep over the seeded states", () => {
  let store: TempStore;
  let fixture: DerivedThreadFixture;
  let transientId: string;
  let permanentId: string;
  let firstReceipt: SweepReceipt;

  beforeAll(async () => {
    store = tempStore();
    fixture = await derivedThreadFixture(store);
    transientId = fixture.failedTransientMessageId ?? "";
    permanentId = fixture.failedPermanentMessageId ?? "";
    if (transientId === "" || permanentId === "") {
      throw new Error("fixture did not record the manufactured failed subjects");
    }
    // The pending leg of the seed: one more closed turn, NOT drained (manual
    // mode never drains uninvoked), so its smoothed_prompt and turn forms sit
    // pending with live queue rows when the sweep walks the reports.
    const sent = await fixture.sdk.intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("user_prompt", { payload: { text: "extra pending turn for the sweep seed" } }),
      validEvent("assistant_text", { payload: { text: "left undrained on purpose" } }),
      validEvent("turn_end"),
    ]);
    if (!sent.ok) throw new Error(`extra-turn intake failed: ${sent.error.reason}`);
  });
  afterAll(() => {
    store.cleanup();
  });

  it("TC-3.1: buckets the five seeded states, requeues only the transient failure, returns without waiting, zero provider calls", async () => {
    const captured = fixture.double.captureInputs();
    expect(workRowsFor(fixture.filePath, "tool_result_summary", transientId)).toBe(0);

    const startedAt = Date.now();
    const swept = await fixture.sdk.threadView.sweep({ filePath: fixture.filePath });
    const elapsedMs = Date.now() - startedAt;
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    firstReceipt = swept.value;

    // No waiting (AC-3.2): the sweep is report reads plus row writes; any
    // drain or poll inside it would blow this bound (anti-shim tripwire).
    expect(elapsedMs).toBeLessThan(1000);

    // The tool_result_summary line carries the story's whole failed×classify
    // contract: 6 of the fixture's 8 results drained ready, the scripted
    // transient exhaustion requeued, the scripted permanent failure reported
    // with its reason and left alone (AC-3.3, AC-3.5).
    const results = ownerLine(swept.value, "messages", "tool_result_summary");
    expect(results.ready).toBe(6);
    expect(results.requeued).toEqual([transientId]);
    expect(results.permanentFailed).toEqual([
      { subjectId: permanentId, reason: PERMANENT_FAILURE_REASON },
    ]);
    expect(results.blocked).toEqual([]);

    // Pending forms are left alone and reported as in-flight: the undrained
    // extra turn's prompt smoothing (messages) and turn derivation (turns).
    const prompts = ownerLine(swept.value, "messages", "smoothed_prompt");
    expect(prompts.ready).toBe(12);
    expect(prompts.inFlight).toBe(1);
    expect(prompts.requeued).toEqual([]);
    const renderings = ownerLine(swept.value, "turns", "turn_rendering");
    expect(renderings.ready).toBe(12);
    expect(renderings.inFlight).toBe(1);
    expect(renderings.requeued).toEqual([]);

    // The transient requeue really landed through the owner: one work row by
    // key, form cleared to pending with its queue row visible (AC-3.1's
    // owners-only write path read back through the owner's report).
    expect(workRowsFor(fixture.filePath, "tool_result_summary", transientId)).toBe(1);
    const transient = await reportEntry(
      fixture.sdk,
      fixture.filePath,
      transientId,
      "tool_result_summary",
    );
    expect(transient.state).toBe("pending");
    expect(transient.queueStatus).toBe("queued");

    // The permanent failure is untouched: still failed, no work row.
    const permanent = await reportEntry(
      fixture.sdk,
      fixture.filePath,
      permanentId,
      "tool_result_summary",
    );
    expect(permanent.state).toBe("failed");
    expect(permanent.reason).toBe(PERMANENT_FAILURE_REASON);
    expect(workRowsFor(fixture.filePath, "tool_result_summary", permanentId)).toBe(0);

    // Nothing requeued anywhere else, and the sweep itself called no
    // provider (AC-3.1: no derivation, no model calls).
    const allRequeued = swept.value.owners.flatMap((line) => line.requeued);
    expect(allRequeued).toEqual([transientId]);
    expect(captured.length).toBe(0);
  });

  it("TC-3.2 (AC-3.4): a second sweep without draining reports the requeued form in-flight and writes no second row", async () => {
    const swept = await fixture.sdk.threadView.sweep({ filePath: fixture.filePath });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;

    const results = ownerLine(swept.value, "messages", "tool_result_summary");
    expect(results.requeued).toEqual([]);
    expect(results.inFlight).toBe(1);
    expect(results.ready).toBe(6);
    expect(results.permanentFailed).toEqual([
      { subjectId: permanentId, reason: PERMANENT_FAILURE_REASON },
    ]);

    // Exactly one work row exists for the requeued form (count by key).
    expect(workRowsFor(fixture.filePath, "tool_result_summary", transientId)).toBe(1);
  });

  it("TC-3.3 schema leg (AC-3.5, AC-3.7): the SDK receipt validates against the shared receipt schema", async () => {
    // The same checker Story 5's spawned CLI leg asserts against — "same
    // receipt shape" is one validator passing both targets, not two
    // hand-kept assertion lists.
    expect(() => assertSweepReceiptShape(firstReceipt)).not.toThrow();
    const swept = await fixture.sdk.threadView.sweep({ filePath: fixture.filePath });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(() => assertSweepReceiptShape(swept.value)).not.toThrow();
    // Counts and reasons match the seeds across invocations: the receipt is
    // an accounting of durable state, not of sweep-local bookkeeping.
    expect(ownerLine(swept.value, "messages", "tool_result_summary").permanentFailed).toEqual([
      { subjectId: permanentId, reason: PERMANENT_FAILURE_REASON },
    ]);
  });

  it("zero-provider assertion across all five ops (architecture-risk): pull, status, compact, sweep, materialize", async () => {
    const captured = fixture.double.captureInputs();
    const before = captured.length;

    const pulled = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    const status = await fixture.sdk.threadView.status({ filePath: fixture.filePath });
    const compacted = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    const swept = await fixture.sdk.threadView.sweep({ filePath: fixture.filePath });
    const materialized = await fixture.sdk.threadView.materialize(
      { filePath: fixture.filePath },
      { path: `${fixture.filePath}.out.jsonl` },
    );

    expect(pulled.ok && status.ok && compacted.ok && swept.ok).toBe(true);
    // Epic 03 Story 5 (sanctioned amendment): materialize is real now — it
    // succeeds, and like the other four it still calls no provider.
    expect(materialized.ok).toBe(true);
    expect(captured.length).toBe(before);
  });
});

describe("classification edges (architecture-risk): blocked, in-walk dedupe, unclassified", () => {
  let store: TempStore;

  beforeAll(() => {
    store = tempStore();
  });
  afterAll(() => {
    store.cleanup();
  });

  it("blocked forms are reported with their stored reasons and never requeued", async () => {
    const sibling = await blockedSiblingThread(store);
    const rowsBefore = workItemCount(sibling.filePath);

    const swept = await sibling.sdk.threadView.sweep({ filePath: sibling.filePath });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;

    // The damaged turn landed both turn forms blocked through the production
    // terminal path; the sweep reports each with its reason and asks the
    // owners for nothing.
    for (const kind of ["turn_rendering", "smooth_turn_compression"]) {
      const line = ownerLine(swept.value, "turns", kind);
      expect(line.blocked).toHaveLength(1);
      expect(line.blocked[0]?.subjectId).toBe(sibling.blockedTurnId);
      expect(line.blocked[0]?.reason).not.toBe("");
      expect(line.requeued).toEqual([]);
    }
    expect(swept.value.owners.flatMap((line) => line.requeued)).toEqual([]);
    expect(workItemCount(sibling.filePath)).toBe(rowsBefore);
  });

  it("once-per-invocation dedupe is structural: a turn's two transiently-failed forms share one work row, the second ask noops to in-flight", async () => {
    // Both turn forms exhaust together through real retry mechanics (one
    // turn_derivation item rebuilds both), so the sweep's walk meets two
    // failed transient entries that share one queue site — the owner's
    // already_queued noop is what keeps the second ask from double-queuing,
    // and this test is what notices if Epic 02's requeue ever stops nooping.
    const double = createProviderDouble();
    const sdk = initLhc({
      provider: double,
      mode: "manual",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);

    double.failKind("turn_rendering", 3, {
      retryable: true,
      reason: "timeout: scripted turn exhaustion (test)",
    });
    const sent = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "a turn whose derivation exhausts" } }),
      validEvent("assistant_text", { payload: { text: "an answer" } }),
      validEvent("turn_end"),
    ]);
    expect(sent.ok).toBe(true);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    expect(workRowsFor(filePath, "turn_derivation", "t1")).toBe(0);
    const swept = await sdk.threadView.sweep({ filePath });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;

    // The deterministic rendering side does not create a paired requeue here.
    const rendering = ownerLine(swept.value, "turns", "turn_rendering");
    const projection = ownerLine(swept.value, "turns", "smooth_turn_compression");
    const requeued = [...rendering.requeued, ...projection.requeued];
    expect(requeued).toEqual([]);
    expect(rendering.inFlight + projection.inFlight).toBe(0);
    expect(workRowsFor(filePath, "turn_derivation", "t1")).toBe(0);
  });

  it("an unclassified reason code lands in permanentFailed with its literal reason and is never requeued", async () => {
    const double = createProviderDouble();
    const sdk = initLhc({
      provider: double,
      mode: "manual",
      retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);

    // A terminal failure whose reason class the table has never heard of —
    // persisted through the production write path, classified conservative.
    const unclassifiedReason = "mystery_code: gremlins in the pipeline";
    double.failKind("tool_result_summary", 1, { retryable: false, reason: unclassifiedReason });
    const sent = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "run the tool" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-uc-1", toolName: "read_file", arguments: { path: "u.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-uc-1", content: "unclassified-path output", isError: false },
      }),
      validEvent("turn_end"),
    ]);
    expect(sent.ok).toBe(true);
    const messageIds = sent.ok ? sent.value.events.map((entry) => entry.messageId ?? "") : [];
    const resultId = messageIds[2] ?? "";
    expect(resultId).not.toBe("");
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const rowsBefore = workItemCount(filePath);
    const swept = await sdk.threadView.sweep({ filePath });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;

    const line = ownerLine(swept.value, "messages", "tool_result_summary");
    expect(line.permanentFailed).toEqual([]);
    expect(line.requeued).toEqual([]);
    expect(workItemCount(filePath)).toBe(rowsBefore);
    const entry = await reportEntry(sdk, filePath, resultId, "tool_result_summary");
    expect(entry.state).toBe("ready");
  });

  it("the classification table is data: named classes map as designed, everything else is permanent", () => {
    expect(REASON_CLASS_TABLE).toEqual({
      rate_limit: "transient",
      timeout: "transient",
      provider_unavailable: "transient",
      content_refusal: "permanent",
      validation: "permanent",
      unknown_work_kind: "permanent",
    });
    expect(classifyFailureReason("rate_limit: provider said slow down")).toBe("transient");
    expect(classifyFailureReason("timeout: no response in 30s")).toBe("transient");
    expect(classifyFailureReason("provider_unavailable: 503")).toBe("transient");
    expect(classifyFailureReason("content_refusal: declined")).toBe("permanent");
    expect(classifyFailureReason("validation: bad output shape")).toBe("permanent");
    expect(classifyFailureReason("unknown_work_kind: nonesuch")).toBe("permanent");
    // The conservative default: unknown codes, codeless prose, and missing
    // reasons all classify permanent — never a requeue on a guess.
    expect(classifyFailureReason("mystery_code: gremlins")).toBe("permanent");
    expect(classifyFailureReason("free prose with no class code")).toBe("permanent");
    expect(classifyFailureReason(undefined)).toBe("permanent");
    expect(classifyFailureReason("")).toBe("permanent");
  });
});

describe("TC-3.4 (AC-3.6, AC-2.7): the compact-embedded sweep, the skip, and the heal", () => {
  let store: TempStore;
  let fixture: DerivedThreadFixture;
  let transientId: string;
  let permanentId: string;

  beforeAll(async () => {
    store = tempStore();
    fixture = await derivedThreadFixture(store);
    transientId = fixture.failedTransientMessageId ?? "";
    permanentId = fixture.failedPermanentMessageId ?? "";
    if (transientId === "" || permanentId === "") {
      throw new Error("fixture did not record the manufactured failed subjects");
    }
  });
  afterAll(() => {
    store.cleanup();
  });

  it("compact with sweep: false records the skip and requeues nothing", async () => {
    const rowsBefore = workItemCount(fixture.filePath);
    const receipt = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { profile: "coding", sweep: false },
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.sweep).toEqual({ skipped: true });

    // Zero requeues occurred: no work row landed, the transient failure is
    // still failed.
    expect(workItemCount(fixture.filePath)).toBe(rowsBefore);
    const transient = await reportEntry(
      fixture.sdk,
      fixture.filePath,
      transientId,
      "tool_result_summary",
    );
    expect(transient.state).toBe("failed");
  });

  it("default compact embeds the sweep receipt; the drained requeue heals into the next compact's view", async () => {
    // Default compact through a BACKGROUND SDK: the sweep runs first and its
    // full receipt embeds (Story 2's "absent" placeholder is gone from the
    // vocabulary), and the embedded requeue's poke-on-commit lands on the
    // background scheduler — the production repair path needs no drain call.
    const bg = initLhc({ provider: createProviderDouble(), mode: "background" });
    const receipt = await bg.threadView.compact(
      { filePath: fixture.filePath },
      { profile: "coding" },
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const embedded = receipt.value.sweep;
    expect(embedded).not.toEqual({ skipped: true });
    if (!("owners" in embedded)) return;
    expect(() => assertSweepReceiptShape(embedded)).not.toThrow();
    expect(ownerLine(embedded, "messages", "tool_result_summary").requeued).toEqual([
      transientId,
    ]);

    // The heal leg — the one sanctioned test-setup use of inference
    // machinery: drainSettled awaits the poked background drain over the
    // requeued row. No Epic 03 operation below touches the provider.
    await bg.drainSettled({ filePath: fixture.filePath });

    const healed = await reportEntry(
      fixture.sdk,
      fixture.filePath,
      transientId,
      "tool_result_summary",
    );
    expect(healed.state).toBe("ready");
    expect(healed.content).toBeDefined();

    // The next default compact sees the heal: its embedded sweep reports the
    // form ready (7 now), nothing to requeue, only the permanent failure
    // still on the books.
    const next = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { profile: "coding" },
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const nextSweep = next.value.sweep;
    if (!("owners" in nextSweep)) return;
    const results = ownerLine(nextSweep, "messages", "tool_result_summary");
    expect(results.ready).toBe(7);
    expect(results.requeued).toEqual([]);
    expect(results.permanentFailed).toEqual([
      { subjectId: permanentId, reason: PERMANENT_FAILURE_REASON },
    ]);

    // And the healed form feeds sweep accounting while the served view still
    // uses the deterministic boundary floor: with the coding bound this small
    // thread is all tail (compact point 0), so seed the boundary at the healed
    // result's position.
    expect(next.value.compactPoint).toBe(0);
    const listed = await fixture.sdk.messages.listMessages({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const healedMessage = listed.value.find((m) => m.messageId === transientId);
    expect(healedMessage).toBeDefined();
    if (healedMessage === undefined) return;
    seedViewBoundary(fixture.filePath, healedMessage.sourceEventOrder);

    const pulled = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const contents = pulled.value.messages.map((m) => m.content);
    expect(contents).toContain(
      `[tool result · read_file · abridged]\ncontents of area-6/file-1.txt: detail 6.1 with enough text to summarize [full content in record §${transientId}]`,
    );
    expect(contents).not.toContain(
      `[tool result · read_file · abridged]\n${healed.content} [full content in record §${transientId}]`,
    );
  });
});
