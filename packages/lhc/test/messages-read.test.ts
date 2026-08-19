// Story 1 (Epic 04), default suite: TC-3.1–3.3 — the message read surface.
// Bounded listing in source-event-order coordinates (DD-3), show returning
// the canonical record (full blocks, never view-shortened) composed with the
// owner report's form entries (DD-2), and the deleted-audit contract
// (excluded by default, listable flagged on request, show never not-found).
// Plus the architecture-risk legs: every read leaves observable state
// unchanged (read-only delta, DD-6) and calls no model.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, intakeStream, type Lhc, type MessageEventInput, messages, threadView } from "../src/index.js";
import { listItems, type WorkOwner } from "../src/shared-tech/work-queue/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  poisonMessageBlockJson,
  poisonMessageFormJson,
  readDerivedForms,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

// Long enough that any view-form shortening would be visible: show must
// return this verbatim (AC-3.2's record-not-view contract).
const TOOL_RESULT_CONTENT = [
  "contents of notes.txt — full record content:",
  "line 1: the quick brown fox jumps over the lazy dog",
  "line 2: detailed tool output that a boundary-shortened form would drop",
  "line 3: trailing detail proving the record came back complete",
].join("\n");

interface ReadFixture {
  filePath: string;
  sdk: Lhc;
  double: ReturnType<typeof createInferenceCallbacksDouble>;
}

// Two closed turns through real intake, fully drained against the
// deterministic double so m1's smoothing and m3/m4's tool summaries sit
// ready with mechanically stamped outcome metadata. Messages: m1 prompt,
// m2 text, m3 call, m4 result (turn 1; turn_end is event 5, no message);
// m6 prompt, m7 text (turn 2). Source event orders 1,2,3,4,6,7.
async function readFixture(store: TempStore): Promise<ReadFixture> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({
    filePath,
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  const batches: MessageEventInput[][] = [
    [
      validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
      validEvent("assistant_text", { payload: { text: "reading it now" } }),
      validEvent("tool_call", {
        payload: {
          toolCallId: "call-read-1",
          toolName: "read_file",
          arguments: { path: "notes.txt" },
        },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-read-1", content: TOOL_RESULT_CONTENT, isError: false },
      }),
      validEvent("turn_end"),
    ],
    [
      validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
      validEvent("assistant_text", { payload: { text: "here is the summary" } }),
      validEvent("turn_end"),
    ],
  ];
  for (const batch of batches) {
    const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
    if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`fixture drain failed: ${drained.error.reason}`);
  if (drained.value.remaining !== 0) {
    throw new Error(`fixture drain left ${drained.value.remaining} items behind`);
  }
  return { filePath, sdk, double };
}

function idsOf(result: { ok: boolean }): string[] {
  if (!result.ok) throw new Error("expected an ok list result");
  return (result as { ok: true; value: Array<{ messageId: string }> }).value.map((record) => record.messageId);
}

function queuedFor(filePath: string, owner: WorkOwner) {
  const db = openRaw(filePath);
  try {
    return listItems(db, owner);
  } finally {
    db.close();
  }
}

// The DD-6 observable-state snapshot: queued work through both owners, view
// boundary/zone through status, derived-form rows, and the event log. A read
// that mutates any of these fails the before/after deep-equal.
async function observableState(filePath: string): Promise<Record<string, unknown>> {
  return {
    events: await intakeStream.listEvents({ filePath }),
    messageWork: queuedFor(filePath, "messages"),
    turnWork: queuedFor(filePath, "turns"),
    viewStatus: await threadView.status({ filePath }),
    derivations: readDerivedForms(filePath),
  };
}

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe("TC-3.1 / AC-3.1: listing order, fields, and bounds", () => {
  it("returns messages in record order with kind, token estimate, and turn membership", async () => {
    const { filePath } = await readFixture(store);
    const listed = await messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m6", "m7"]);
    expect(listed.value.map((m) => m.sourceEventOrder)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(listed.value.map((m) => m.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "user_prompt",
      "assistant_text",
    ]);
    expect(listed.value.map((m) => m.turnId)).toEqual(["t1", "t1", "t1", "t1", "t2", "t2"]);
    for (const record of listed.value) {
      expect(record.tokenEstimate).toBeGreaterThan(0);
      expect(record.deleted).toBeUndefined();
    }
  });

  it("honors from/to/limit windows exactly in source-event-order coordinates", async () => {
    const { filePath } = await readFixture(store);
    const windows: Array<[Parameters<typeof messages.list>[1], string[]]> = [
      [{ from: 2, to: 4 }, ["m2", "m3", "m4"]],
      [{ from: 6 }, ["m6", "m7"]],
      [{ to: 2 }, ["m1", "m2"]],
      [{ limit: 3 }, ["m1", "m2", "m3"]],
      [{ from: 2, limit: 2 }, ["m2", "m3"]],
      [{ from: 4, to: 4 }, ["m4"]],
      [{ from: 5, to: 5 }, []], // the turn_end order: an event, never a message
    ];
    for (const [opts, expected] of windows) {
      expect(idsOf(await messages.list({ filePath }, opts))).toEqual(expected);
    }
  });

  it("refuses bad bounds as caller errors and returns no partial window", async () => {
    const { filePath } = await readFixture(store);
    const badBounds = [{ from: 5, to: 2 }, { limit: 0 }, { limit: -1 }, { from: 1.5 }];
    for (const opts of badBounds) {
      const refused = await messages.list({ filePath }, opts);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.errorClass).toBe("caller_error");
      expect(refused.error.code).toBe("invalid_bounds");
    }
  });
});

describe("TC-3.2 / AC-3.2: show returns the full record with owner-reported forms", () => {
  it("a drained tool-result message comes back with full content, form states, and outcome metadata", async () => {
    const { filePath } = await readFixture(store);
    const shown = await messages.show({ filePath }, "m4");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const detail = shown.value;
    expect(detail.messageId).toBe("m4");
    expect(detail.kind).toBe("tool_result");
    expect(detail.turnId).toBe("t1");
    expect(detail.deleted).toBe(false);
    expect(detail.tokenEstimate).toBeGreaterThan(0);
    // The record, not the view: the complete original tool result verbatim.
    expect(detail.blocks).toHaveLength(1);
    expect(detail.blocks[0]?.blockType).toBe("tool_result");
    expect(detail.blocks[0]?.content["content"]).toBe(TOOL_RESULT_CONTENT);
    expect(detail.blocks[0]?.content["toolCallId"]).toBe("call-read-1");
    // Forms with states and tool-outcome metadata, joined from the owner.
    expect(detail.derivations).toHaveLength(1);
    const summary = detail.derivations[0];
    expect(summary?.derivationType).toBe("tool_result_summary");
    expect(summary?.state).toBe("ready");
    expect(summary?.content).toBeDefined();
    expect(summary?.metadata?.outcome).toBe("succeeded");
    // Anti-shim: the forms ARE the owner report's entries for this message,
    // never a synthesized join (DD-2).
    const report = await messages.report({ filePath }, { messageId: "m4" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(detail.derivations).toEqual(report.value);
  });

  it("a drained prompt shows its smoothing form alongside the full record", async () => {
    const { filePath } = await readFixture(store);
    const shown = await messages.show({ filePath }, "m1");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.blocks[0]?.content["text"]).toBe("please read notes.txt");
    expect(shown.value.derivations.map((form) => [form.derivationType, form.state])).toEqual([
      ["smoothed_prompt", "ready"],
    ]);
  });
});

describe("TC-3.3 / AC-3.3: deleted messages are audit-visible, never silently mixed", () => {
  it("default list excludes a deleted message; include-deleted lists it marked; show returns it flagged", async () => {
    const { filePath } = await readFixture(store);
    const deleted = await messages.remove({ filePath }, { messageId: "m2" });
    expect(deleted.ok).toBe(true);

    const defaultList = await messages.list({ filePath });
    expect(idsOf(defaultList)).toEqual(["m1", "m3", "m4", "m6", "m7"]);

    const audited = await messages.list({ filePath }, { includeDeleted: true });
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    expect(audited.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m6", "m7"]);
    for (const record of audited.value) {
      if (record.messageId === "m2") expect(record.deleted).toBe(true);
      else expect(record.deleted).toBeUndefined();
    }

    // Show on the deleted message is the audit read: the record, flagged —
    // never a not-found.
    const shown = await messages.show({ filePath }, "m2");
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.deleted).toBe(true);
    expect(shown.value.blocks[0]?.content["text"]).toBe("reading it now");
  });

  it("show on a missing id is message_not_found", async () => {
    const { filePath } = await readFixture(store);
    const missing = await messages.show({ filePath }, "m99");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("message_not_found");
  });
});

describe("architecture risk: reads are read-only and inference-callback-free (DD-6)", () => {
  it("list and show in every mode leave observable state unchanged and call no model", async () => {
    const { filePath, double } = await readFixture(store);
    const captured = double.captureInputs();
    const before = await observableState(filePath);

    await messages.list({ filePath });
    await messages.list({ filePath }, { from: 2, to: 4, limit: 2 });
    await messages.list({ filePath }, { includeDeleted: true });
    await messages.list({ filePath }, { from: 9, to: 1 }); // refused, must not write either
    await messages.show({ filePath }, "m4");
    await messages.show({ filePath }, "m99"); // not-found, must not write either

    const after = await observableState(filePath);
    expect(after).toEqual(before);
    expect(captured).toHaveLength(0);
  });
});

// A thread with live, undrained work: one tool turn through a manual SDK
// (its no-op seam never drains), leaving three pending forms and their queue
// rows. The background read-only proof needs the pending state the manual
// read-only proof above cannot manufacture.
async function pendingWorkThread(): Promise<string> {
  const seeder = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
  const filePath = store.threadPath();
  const created = await seeder.threads.newThread({
    filePath,
    registryPath: store.registryPath,
  });
  if (!created.ok) throw new Error(`pending fixture thread creation failed: ${created.error.reason}`);
  const sent = await seeder.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "background prompt" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-bg-1", toolName: "read_file", arguments: { path: "bg.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-bg-1", content: "background output", isError: false },
    }),
    validEvent("assistant_text", { payload: { text: "background answer" } }),
    validEvent("turn_end"),
  ]);
  if (!sent.ok) throw new Error(`pending fixture intake failed: ${sent.error.reason}`);
  return filePath;
}

// Below-SDK raw snapshot of everything a wrongly-scheduled catch-up drain
// would move: work-item rows and derived-form states. Read through a raw
// handle (openRaw), never the SDK ops — those would fire their own touch and
// pollute the very state under test.
function rawWorkAndForms(filePath: string): Record<string, unknown> {
  const db = openRaw(filePath);
  try {
    return {
      workItems: db.prepare(`SELECT work_item_id, status FROM work_item ORDER BY work_item_id`).all(),
      derivations: db
        .prepare(
          `SELECT subject_id, derivation_type, state, source_version FROM derivation
           ORDER BY subject_id, derivation_type`,
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

describe("architecture risk: background reads schedule no catch-up drain (DD-6, SV-01-001)", () => {
  it("list and show through a background SDK with pending work call no model and advance no form", async () => {
    const filePath = await pendingWorkThread();

    // A fresh background SDK whose scheduler WOULD hang a first-touch catch-up
    // drain — and the model call that drain makes — off the open
    // announcement (openThreadDatabase → fireThreadTouch → scheduler.touch) if
    // list or show fired it. The touch-suppressed read scope is what stops it;
    // this is the production-path proof a manual-mode no-op seam cannot give.
    const bgDouble = createInferenceCallbacksDouble();
    const bg = initLhc({ inferenceCallbacks: bgDouble, mode: "background" });
    const captured = bgDouble.captureInputs();
    const before = rawWorkAndForms(filePath);

    const listed = await bg.messages.list({ filePath });
    await bg.messages.list({ filePath }, { limit: 1 });
    const shown = await bg.messages.show({ filePath }, "m1");
    expect(listed.ok && shown.ok).toBe(true);
    if (!listed.ok || !shown.ok) return;

    // The reads ran against the live, undrained queue — the records carry
    // their pending forms — so this is no vacuous pass on an empty thread.
    const listedForms = listed.value.flatMap((m) => m.derivations ?? []);
    expect(listedForms.length).toBeGreaterThan(0);
    expect(listedForms.every((form) => form.state === "pending")).toBe(true);
    expect(shown.value.derivations.map((form) => form.state)).toEqual(["pending"]);

    // Give any wrongly-scheduled catch-up drain room to surface, then wait the
    // scheduler out before asserting nothing moved underneath the reads.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await bg.drainSettled({ filePath });

    // Reads only: every work-item and form row is exactly as before, and the
    // background inference callbacks observed zero calls — no first-touch drain fired.
    expect(rawWorkAndForms(filePath)).toEqual(before);
    expect(captured).toHaveLength(0);
  });
});

describe("architecture risk: bounded listing loads only its window (AC-3.1, SV-01-002)", () => {
  it("a bounded list excluding out-of-window rows never loads their blocks or forms", async () => {
    const { filePath } = await readFixture(store);
    // Corrupt content the bounds must exclude: m7's block (an out-of-window
    // message) and m4's tool-result-summary metadata (an out-of-window form).
    // Any read that loads either row throws on JSON.parse, so a bounded list
    // that still succeeds proves it never read outside its window.
    poisonMessageBlockJson(filePath, "m7");
    poisonMessageFormJson(filePath, "m4");

    // In-window reads succeed and return exactly the window — the poisoned
    // rows are sourced neither as blocks nor as forms.
    for (const opts of [{ to: 1 }, { limit: 1 }] as const) {
      const bounded = await messages.list({ filePath }, opts);
      expect(bounded.ok).toBe(true);
      if (!bounded.ok) return;
      expect(bounded.value.map((m) => m.messageId)).toEqual(["m1"]);
      expect(bounded.value[0]?.blocks[0]?.content["text"]).toBe("please read notes.txt");
    }

    // Positive controls: a window that *includes* a poisoned row does load it
    // and fails on parse — proof the pills are real, so the passes above are
    // genuine no-loads, not silently-dropped output.
    const hitsBlock = await messages.list({ filePath }, { from: 7 });
    expect(hitsBlock.ok).toBe(false);
    const hitsForm = await messages.list({ filePath }, { from: 4, to: 4 });
    expect(hitsForm.ok).toBe(false);
  });
});

describe("large unbounded message reads", () => {
  it("lists and previews more messages than SQLite accepts as one bound-parameter list", async () => {
    const { filePath, sdk } = await readFixture(store);
    const db = openRaw(filePath);
    try {
      const insertEvent = db.prepare(
        `INSERT INTO event
           (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, 'assistant_text', ?, 'assistant', 'test', ?, '2026-01-01T00:00:00.000Z')`,
      );
      const insertMessage = db.prepare(
        `INSERT INTO message
           (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
         VALUES (?, ?, 'assistant_text', 1, 'assistant', 'test', 't2')`,
      );
      const insertBlock = db.prepare(
        `INSERT INTO message_block (message_id, block_index, block_type, content)
         VALUES (?, 0, 'text', ?)`,
      );
      for (let index = 0; index < 34_000; index += 1) {
        const id = `large-${index}`;
        const order = 10_000 + index;
        const content = JSON.stringify({ text: `large read ${index}` });
        insertEvent.run(order, id, content);
        insertMessage.run(id, order);
        insertBlock.run(id, content);
      }
    } finally {
      db.close();
    }

    const listed = await sdk.messages.list({ filePath });
    if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.reason}`);
    expect(listed.value).toHaveLength(34_006);
    expect(listed.value.at(-1)?.blocks[0]?.content["text"]).toBe("large read 33999");

    const preview = await sdk.threadView.previewCompact({ filePath }, {});
    if (!preview.ok) throw new Error(`${preview.error.code}: ${preview.error.reason}`);
    expect(preview.value.kind).toBe("ok");
  }, 20_000);
});
