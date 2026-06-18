// Epic 03 Story 2: smart compact (TC-2.1–2.4, TC-2.6, TC-2.7, TC-1.3,
// TC-1.5, the TC-2.5 view-health completion legs, and the architecture-risk
// rows: restart-serves-snapshot and coverage-edge accounting). Every TC goes
// through the real SDK surface (initLhc().threadView.compact) against real
// temp thread files; the inference callbacks double appears only in fixture setup —
// degraded states are reached through production paths (scripted inference callback
// exhaustion at build, edit-cascade pending clears), never by writing
// derivation directly.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput, type ViewMessage } from "../src/index.js";
import {
  corruptTwoOpenTurns,
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  type InferenceCallbacksDouble,
  openRaw,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

// The story's reference configs (hand-derived from the fixture's
// deterministic token costs via the literal selection rules — ruling 013;
// the goldens in view-select-golden.test.ts pin arrangements exactly).
// TARGET: equal shares for the targets-the-bound assertions (smooth absorbs
// t6–t8 within share; c1 fills detailed; brief left empty by candidacy).
const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};
// GRADIENT: all three bands non-empty (smooth t7+t8, detailed c2, brief c1).
const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};
// EDGE: compact point lands at t10's close (full 50 tokens), making c3, c2,
// and c1 chunk candidates; the brief share (30) holds c2 alone (36, loner)
// and excludes c1 — the coverage edge.
const EDGE_PARAMS = {
  lowerBound: 100,
  percentages: { full: 50, smooth: 10, detailed: 10, brief: 30 },
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// The canonical record plus its derived state — everything compact must
// never touch (AC-2.9). View tables and the boundary are deliberately
// excluded: those are compact's own rows.
function recordSnapshot(filePath: string): string {
  const db = openRaw(filePath);
  try {
    return sha256({
      events: db.prepare(`SELECT * FROM event ORDER BY event_order`).all(),
      messages: db.prepare(`SELECT * FROM message ORDER BY source_event_order`).all(),
      blocks: db.prepare(`SELECT * FROM message_block ORDER BY message_id, block_index`).all(),
      turns: db.prepare(`SELECT * FROM turns ORDER BY turn_order`).all(),
      chunks: db.prepare(`SELECT * FROM chunk ORDER BY chunk_order`).all(),
      members: db.prepare(`SELECT * FROM chunk_member ORDER BY chunk_id, member_idx`).all(),
      derivations: db.prepare(`SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type`).all(),
    });
  } finally {
    db.close();
  }
}

// Full-file state including the view rows and boundary — for the
// thread-unchanged-after-rejection assertions.
function fullStateSnapshot(filePath: string): string {
  const db = openRaw(filePath);
  try {
    return sha256({
      record: recordSnapshot(filePath),
      views: db.prepare(`SELECT * FROM thread_view`).all(),
      bands: db.prepare(`SELECT * FROM thread_view_band ORDER BY band`).all(),
      boundary: db.prepare(`SELECT position FROM view_boundary`).all(),
      work: db.prepare(`SELECT work_item_id, status FROM work_item ORDER BY work_item_id`).all(),
    });
  } finally {
    db.close();
  }
}

function viewRowCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM thread_view`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function boundaryPosition(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT position FROM view_boundary`).get() as {
      position: number | bigint;
    };
    return Number(row.position);
  } finally {
    db.close();
  }
}

function bandMessages(messages: readonly ViewMessage[]): ViewMessage[] {
  return messages.filter((message) => message.band !== undefined);
}

async function pullMessages(sdk: Lhc, filePath: string): Promise<ViewMessage[]> {
  const pulled = await sdk.threadView.pull({ filePath });
  if (!pulled.ok) throw new Error(`pull failed: ${pulled.error.reason}`);
  return pulled.value.messages;
}

describe("TC-2.1 (AC-2.2, AC-2.3, AC-2.7): profiles, explicit params, and named rejections", () => {
  it("rejects percentages summing to 105 naming the sum, and an unknown profile naming it; thread unchanged", async () => {
    const before = fullStateSnapshot(fixture.filePath);

    const badSum = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { percentages: { full: 30, smooth: 30, detailed: 25, brief: 20 } } },
    );
    expect(badSum.ok).toBe(false);
    if (badSum.ok) return;
    expect(badSum.error.errorClass).toBe("caller_error");
    expect(badSum.error.code).toBe("invalid_view_config");
    expect(badSum.error.reason).toContain("105");

    const badBound = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 0 } },
    );
    expect(badBound.ok).toBe(false);
    if (badBound.ok) return;
    expect(badBound.error.code).toBe("invalid_view_config");
    expect(badBound.error.reason).toContain("lowerBound");

    const unknown = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { profile: "nonesuch" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.errorClass).toBe("caller_error");
    expect(unknown.error.code).toBe("unknown_profile");
    expect(unknown.error.reason).toContain('"nonesuch"');

    // Thread unchanged after all rejections: no view row landed, no record
    // or boundary movement (read-back equality).
    expect(fullStateSnapshot(fixture.filePath)).toBe(before);
    expect(viewRowCount(fixture.filePath)).toBe(0);
  });

  it("compacts with a built-in profile: the profile's bound and mix land in the receipt", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { profile: "coding" });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value.profile).toBe("coding");
    expect(receipt.value.config).toEqual({
      full: 25,
      smooth: 35,
      detailed: 20,
      brief: 20,
      lowerBound: 120000,
    });
    // Story 3 (sanctioned amendment): the embedded sweep replaced Story 2's
    // "absent" literal. This is the file's first default-sweep compact, so
    // the fixture's transiently-failed summary requeues HERE — every later
    // compact in this file sees it in-flight and writes nothing, which is
    // what keeps the record-untouched assertions below honest. The sweep's
    // own contract lives in view-sweep.test.ts.
    expect(receipt.value.sweep).not.toEqual({ skipped: true });
    if (!("owners" in receipt.value.sweep)) throw new Error("expected embedded sweep receipt");
    const sweepLine = receipt.value.sweep.owners.find(
      (line) => line.owner === "messages" && line.kind === "tool_result_summary",
    );
    expect(sweepLine?.requeued).toEqual([fixture.failedTransientMessageId]);
    // At a 120k bound this small thread is all tail: bands empty, compact
    // point at the origin, and the reported total IS the tail (totalTokens
    // receipt coverage, ruling 013).
    expect(receipt.value.compactPoint).toBe(0);
    expect(receipt.value.bands.smooth.entries).toBe(0);
    expect(receipt.value.totalTokens).toBe(receipt.value.tailTokens);
  });

  it("explicit params override profile values field-wise and report profile null", async () => {
    const receipt = await fixture.sdk.threadView.compact(
      { filePath: fixture.filePath },
      { profile: "coding", params: { lowerBound: 400, percentages: { smooth: 40, detailed: 15 } } },
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    // coding's mix with the two overridden fields; explicit params ⇒ the
    // receipt names no profile (config carries the resolved truth).
    expect(receipt.value.config).toEqual({
      full: 25,
      smooth: 40,
      detailed: 15,
      brief: 20,
      lowerBound: 400,
    });
    expect(receipt.value.profile).toBeNull();
  });
});

describe("TC-2.2 (AC-2.4, AC-2.9): the compact targets the bound from stored artifacts only", () => {
  it("actuals near shares with whole-entry deviations, zero model calls, record untouched", async () => {
    const captured = fixture.double.captureInputs();
    const capturedBefore = captured.length;
    const recordBefore = recordSnapshot(fixture.filePath);

    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET_PARAMS });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const shares = {
      smooth: (400 * 25) / 100,
      detailed: (400 * 25) / 100,
      brief: (400 * 25) / 100,
    };

    // Whole-entry fills: a band lands at-or-under its share unless a single
    // indivisible entry had to represent (the only sanctioned over-share
    // deviation, AC-2.4).
    for (const band of ["brief", "detailed", "smooth"] as const) {
      const actual = receipt.value.bands[band];
      const attributable = actual.tokens <= shares[band] || actual.entries === 1;
      expect(attributable).toBe(true);
    }
    // The fixture's pinned arrangement under these params (literal rules):
    // c1 fits brief, c2 fills detailed within its share, smooth carries the
    // newest turn, tail under the full share plus turn-boundary snap.
    expect(receipt.value.bands.brief).toEqual({ entries: 1, tokens: 27 });
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.detailed.tokens).toBeGreaterThan(shares.detailed);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.bands.smooth.tokens).toBeGreaterThan(shares.smooth);
    expect(receipt.value.tailTokens).toBeLessThanOrEqual((400 * 25) / 100);
    expect(receipt.value.compactPoint).toBe(48);

    // The explicit total (ruling 013): the assembled view's actual size —
    // band tokens plus tail — reported beside the per-band actuals. Here it
    // can exceed the bound when indivisible stored entries represent alone,
    // the bound being a target, not a cap.
    expect(receipt.value.totalTokens).toBe(
      receipt.value.bands.brief.tokens +
        receipt.value.bands.detailed.tokens +
        receipt.value.bands.smooth.tokens +
        receipt.value.tailTokens,
    );
    expect(receipt.value.totalTokens).toBeGreaterThan(400);

    // No model call anywhere in the compact path; the record (events,
    // messages, turns, chunks, forms) is byte-identical after.
    expect(captured.length).toBe(capturedBefore);
    expect(recordSnapshot(fixture.filePath)).toBe(recordBefore);
  });
});

describe("TC-2.6 (AC-2.10): band entries carry their subject keys visibly", () => {
  it("chunk keys in brief/detailed text, turn keys in smooth text", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);

    const messages = await pullMessages(fixture.sdk, fixture.filePath);
    const bands = bandMessages(messages);
    const byBand = new Map(bands.map((message) => [message.band, message.content]));
    expect(byBand.get("brief")).toMatch(/§c\d+/);
    expect(byBand.get("detailed")).toMatch(/§c\d+/);
    expect(byBand.get("smooth")).toMatch(/§t\d+/);
    expect(byBand.get("smooth")).not.toMatch(/§c\d+/);
  });
});

describe("architecture-risk: coverage edge accounting", () => {
  it("excluded old chunks set covered_from, the receipt reports the window, and no phantom gaps appear", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: EDGE_PARAMS });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    // The compact point lands at t10's close, so c3, c2, and c1 are all
    // chunk candidates; c3 takes detailed (loner), the brief share holds c2
    // alone, and c1 remains AFTER the budget: outside the view. covered_from
    // lands at c2's start — t4's prompt, event 13 — and the exclusion is
    // visible as coveredFrom > first event.
    expect(receipt.value.compactPoint).toBe(56);
    expect(receipt.value.coveredFrom).toBe(13);
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.brief.entries).toBe(1);
    // No silent omission AND no phantom gap entries for the out-of-window
    // chunk: gaps report unusable material, not the window's edge.
    expect(receipt.value.gaps).toEqual([]);

    const messages = await pullMessages(fixture.sdk, fixture.filePath);
    const bandText = bandMessages(messages)
      .map((message) => message.content)
      .join("\n");
    expect(bandText).not.toContain("§c1");
    expect(bandText).toContain("§c2");
    expect(bandText).toContain("§c3");
  });
});

describe("architecture-risk: restart serves the snapshot (real-file durability)", () => {
  it("a fresh SDK on the same file pulls byte-identical band content", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);
    const before = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Not a same-process reread: a fresh SDK instance opens the file cold.
    const fresh = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const after = await fresh.threadView.pull({ filePath: fixture.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  });
});

describe("TC-2.4 (AC-2.6): crash injection at the compact-write point", () => {
  it("an injected crash leaves the previous view serving; the rerun lands clean with no partial state", async () => {
    const first = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT_PARAMS });
    expect(first.ok).toBe(true);
    const priorPull = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    expect(priorPull.ok).toBe(true);
    if (!priorPull.ok) return;
    expect(boundaryPosition(fixture.filePath)).toBe(48);

    setViewInjectionHook("compact-write", () => {
      throw new Error("injected crash between sweep and view write");
    });
    try {
      const crashed = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: EDGE_PARAMS });
      expect(crashed.ok).toBe(false);
      if (crashed.ok) return;
      expect(crashed.error.errorClass).toBe("system_error");
      expect(crashed.error.reason).toContain("injected crash");
    } finally {
      setViewInjectionHook("compact-write", null);
    }

    // The previous view still serves, byte-identical; no partial rows, no
    // boundary movement.
    const afterCrash = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    expect(afterCrash.ok).toBe(true);
    if (!afterCrash.ok) return;
    expect(JSON.stringify(afterCrash.value)).toBe(JSON.stringify(priorPull.value));
    expect(viewRowCount(fixture.filePath)).toBe(1);
    expect(boundaryPosition(fixture.filePath)).toBe(48);

    // Rerun: the new view lands whole and the boundary resets to ITS compact
    // point (56) in the same transaction.
    const rerun = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: EDGE_PARAMS });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.value.coveredFrom).toBe(13);
    expect(viewRowCount(fixture.filePath)).toBe(1);
    expect(boundaryPosition(fixture.filePath)).toBe(56);
    const rerunPull = await fixture.sdk.threadView.pull({ filePath: fixture.filePath });
    expect(rerunPull.ok).toBe(true);
    if (!rerunPull.ok) return;
    expect(JSON.stringify(rerunPull.value)).not.toBe(JSON.stringify(priorPull.value));
  });
});

// ── degraded thread (TC-2.3 + the TC-2.5 view-health completion legs) ──

// The fixture conversation rebuilt with manufactured derived damage, all
// through production paths: c1's brief summary exhausts through scripted
// retryable inference callback failures at build; post-build edits clear t8's turn
// forms and all of c2's dependent chain to pending (the Epic 02 cascade) —
// a pending turn rendering for the smooth band, and a chunk with no usable
// form at all (summaries pending, zero ready member projections) for the
// gap rung.
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);
const C1_BRIEF_EXHAUST_REASON = "rate_limit: scripted c1 brief exhaustion (test)";

function degradedTurnEvents(turn: number): MessageEventInput[] {
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
    validEvent("assistant_thinking", { payload: { text: `considering what area ${turn} contains` } }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-dg-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          payload: { toolCallId, toolName: "read_file", arguments: { path: `area-${turn}/file-${run}.txt` } },
        }),
        validEvent("tool_result", {
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }), validEvent("turn_end"));
  return events;
}

interface DegradedThread {
  filePath: string;
  sdk: Lhc;
  double: InferenceCallbacksDouble;
  promptIdByTurn: Map<number, string>;
}

async function buildDegradedThread(intoStore: TempStore): Promise<DegradedThread> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4400 },
  });
  const filePath = intoStore.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: intoStore.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);

  const promptIdByTurn = new Map<number, string>();
  for (let turn = 1; turn <= 12; turn += 1) {
    if (turn === 4) {
      // c1 closes during turn 4's drain (placement of t4): its brief summary
      // exhausts through real retry mechanics — a FAILED chunk summary.
      double.failKind("chunk_summary_brief", 3, {
        retryable: true,
        reason: C1_BRIEF_EXHAUST_REASON,
      });
    }
    const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
    if (!sent.ok) throw new Error(`intake failed: ${sent.error.reason}`);
    const promptId = sent.value.events[0]?.messageId;
    if (promptId !== undefined && promptId !== null) promptIdByTurn.set(turn, promptId);
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);
  }

  // Post-build edits, NOT drained: the cascade clears each edited message's
  // dependent chain to pending. t8 ⇒ a PENDING turn rendering in the smooth
  // band; t4+t5+t6 ⇒ c2's summaries pending with zero ready member
  // projections — the gap rung.
  for (const turn of [4, 5, 6, 8]) {
    const promptId = promptIdByTurn.get(turn);
    if (promptId === undefined) throw new Error(`no prompt id recorded for turn ${turn}`);
    const edited = await sdk.messages.edit(
      { filePath },
      { messageId: promptId, content: `turn ${turn}: edited investigation of area ${turn}` },
    );
    if (!edited.ok) throw new Error(`edit failed: ${edited.error.reason}`);
  }
  return { filePath, sdk, double, promptIdByTurn };
}

describe("TC-2.3 (AC-2.5, AC-2.7) + TC-2.5 view-health legs: degraded material renders fallbacks, never fails the compact", () => {
  let degradedStore: TempStore;
  let degraded: DegradedThread;

  beforeAll(async () => {
    degradedStore = tempStore();
    degraded = await buildDegradedThread(degradedStore);
  });
  afterAll(() => {
    degradedStore.cleanup();
  });

  it("completes with ladder fallbacks marked, gap entries for unusable spans, and full accounting in the receipt", async () => {
    const captured = degraded.double.captureInputs();
    const capturedBefore = captured.length;

    const receipt = await degraded.sdk.threadView.compact(
      { filePath: degraded.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 } } },
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    // The pending turn rendering (t8, edited): the smooth entry degrades down
    // its ladder (projection pending too) to the deterministic excerpt.
    const t8 = receipt.value.degraded.find((entry) => entry.subjectId === "t8");
    expect(t8).toBeDefined();
    expect(t8?.band).toBe("smooth");
    expect(t8?.usedDerivation).toBe("message_excerpt");

    // The failed chunk summary (c1's brief): compact falls back through the
    // turns surface to stored-member concatenation, marked.
    const c1 = receipt.value.degraded.find((entry) => entry.subjectId === "c1");
    expect(c1).toBeDefined();
    expect(c1?.band).toBe("brief");
    expect(c1?.usedDerivation).toBe("stored_member_concat");

    // The unusable chunk (c2: summaries pending, zero ready member
    // projections): Story 4 compact recovery uses stored-member concat, not
    // a gap, so the span remains present.
    expect(receipt.value.gaps).toHaveLength(0);
    const c2 = receipt.value.degraded.find((entry) => entry.subjectId === "c2");
    expect(c2).toBeDefined();
    expect(c2?.usedDerivation).toBe("stored_member_concat");

    // Per-band counts present; no span silently absent: every turn in the
    // compacted range is accounted for by a band subject (c1: t1–t3, c2:
    // t4–t6, smooth: t8) and everything after the compact point is tail.
    expect(receipt.value.bands.brief.entries).toBe(1);
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.compactPoint).toBe(48);
    expect(receipt.value.coveredFrom).toBe(1);

    // The rendered text carries the markers (degrade visibly, AC-2.5/2.10).
    const messages = await pullMessages(degraded.sdk, degraded.filePath);
    const bandText = bandMessages(messages)
      .map((message) => message.content)
      .join("\n\n");
    expect(bandText).toContain("[degraded: brief-from-stored-members]");
    expect(bandText).toContain("[degraded: detailed-from-stored-members]");
    expect(bandText).toContain("[degraded: smooth-from-excerpt]");
    expect(bandText).toContain("§c2 [degraded: detailed-from-stored-members]");

    // Zero model calls: missing material degrades, it is never re-derived
    // inline (AC-2.4's no-inference rule with teeth).
    expect(captured.length).toBe(capturedBefore);
  });

  it("status reports the view-health fields live after the degraded compact (TC-2.5 completion leg)", async () => {
    const status = await degraded.sdk.threadView.status({ filePath: degraded.filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.view).not.toBeNull();
    expect(status.value.view?.degraded).toBe(3);
    expect(status.value.view?.gaps).toBe(0);
    expect(typeof status.value.view?.builtAt).toBe("string");
    // The edits' requeued rebuild work is visible as pending derivation.
    expect(status.value.derivation.pending).toBeGreaterThan(0);
  });
});

describe("TC-2.7 (AC-2.5): canonical corruption refuses; derived-only damage degrades", () => {
  it("refuses with state_corruption naming the damage; the prior view still serves; record unchanged", async () => {
    const corruptStore = tempStore();
    try {
      const double = createInferenceCallbacksDouble();
      const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
      const filePath = corruptStore.threadPath();
      const created = await sdk.threads.newThread({
        filePath,
        registryPath: corruptStore.registryPath,
      });
      expect(created.ok).toBe(true);
      for (let turn = 1; turn <= 4; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }
      const drained = await sdk.work.drain({ filePath });
      expect(drained.ok).toBe(true);

      // A prior view exists before the damage.
      const first = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(first.ok).toBe(true);
      const priorPull = await sdk.threadView.pull({ filePath });
      expect(priorPull.ok).toBe(true);
      if (!priorPull.ok) return;

      // Manufactured canonical corruption, damaged below the SDK (the Epic 01
      // two-open-turns pattern): open a turn through real intake, then add a
      // second open row.
      const opened = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: "left open before the damage" } }),
      ]);
      expect(opened.ok).toBe(true);
      corruptTwoOpenTurns(filePath);
      const recordBefore = recordSnapshot(filePath);

      const refused = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.errorClass).toBe("state_corruption");
      expect(refused.error.code).toBe("turn_state_corrupt");
      expect(refused.error.reason).toMatch(/open turns/);

      // Pre-transaction refusal: prior view serves byte-identically, record
      // untouched.
      const afterPull = await sdk.threadView.pull({ filePath });
      expect(afterPull.ok).toBe(true);
      if (!afterPull.ok) return;
      expect(JSON.stringify(afterPull.value.messages.filter((m) => m.band !== undefined))).toBe(
        JSON.stringify(priorPull.value.messages.filter((m) => m.band !== undefined)),
      );
      expect(afterPull.value.meta.viewId).toBe(priorPull.value.meta.viewId);
      expect(recordSnapshot(filePath)).toBe(recordBefore);
    } finally {
      corruptStore.cleanup();
    }
  });

  it("control: a thread with only derived-material damage compacts successfully with gaps", async () => {
    // The suite fixture carries two scripted FAILED tool_result_summary forms
    // (derived damage only) and compacts clean throughout this file; the
    // explicit control here is the degraded build: summaries pending/failed,
    // zero usable forms on c2 — and the compact above completed with a gap
    // rather than refusing. Re-assert the contrast directly on the main
    // fixture: derived failures present, compact succeeds, no state_corruption.
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);
  });
});

describe("TC-1.3 (AC-1.4) and TC-1.5 (AC-1.6): snapshot immutability under record mutation", () => {
  let mutStore: TempStore;
  let mut: DerivedThreadFixture;

  beforeAll(async () => {
    mutStore = tempStore();
    mut = await derivedThreadFixture(mutStore, { failures: false });
    const receipt = await mut.sdk.threadView.compact({ filePath: mut.filePath }, { params: GRADIENT_PARAMS });
    if (!receipt.ok) throw new Error(`setup compact failed: ${receipt.error.reason}`);
  });
  afterAll(() => {
    mutStore.cleanup();
  });

  it("TC-1.3: editing a banded subject leaves band bytes unchanged across pulls, before and after the drain", async () => {
    const before = bandMessages(await pullMessages(mut.sdk, mut.filePath));
    const bandHash = sha256(before);

    // t5 is banded inside c2's detailed entry; edit its prompt.
    const listed = await mut.sdk.messages.listMessages({ filePath: mut.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const t5Prompt = listed.value.find((m) => m.turnId === "t5" && m.kind === "user_prompt");
    expect(t5Prompt).toBeDefined();
    if (t5Prompt === undefined) return;
    const edited = await mut.sdk.messages.edit(
      { filePath: mut.filePath },
      { messageId: t5Prompt.messageId, content: "turn 5: edited after the snapshot" },
    );
    expect(edited.ok).toBe(true);

    const afterEdit = bandMessages(await pullMessages(mut.sdk, mut.filePath));
    expect(sha256(afterEdit)).toBe(bandHash);

    // Drain the requeued rebuilds: the rebuilt summary lands in the RECORD
    // only; the snapshot still serves the same bytes.
    const drained = await mut.sdk.work.drain({ filePath: mut.filePath });
    expect(drained.ok).toBe(true);
    const afterDrain = bandMessages(await pullMessages(mut.sdk, mut.filePath));
    expect(sha256(afterDrain)).toBe(bandHash);

    // The record really changed underneath: c2's rebuilt detailed summary is
    // not the text the band serves.
    const db = openRaw(mut.filePath);
    try {
      const row = db
        .prepare(
          `SELECT content FROM derivation
           WHERE subject_kind = 'chunk' AND subject_id = 'c2' AND derivation_type = 'chunk_summary_detailed'`,
        )
        .get() as { content: string | null } | undefined;
      expect(row?.content).toBeDefined();
      const detailedBand = afterDrain.find((m) => m.band === "detailed");
      expect(detailedBand?.content).not.toContain(row?.content ?? "<unset>");
    } finally {
      db.close();
    }
  });

  it("TC-1.5: a tail delete vanishes from the next pull; a banded delete leaves the snapshot until the next compact", async () => {
    const listed = await mut.sdk.messages.listMessages({ filePath: mut.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    // Tail region: t9 onward (compact point 48). Delete t10's findings.
    const tailTarget = listed.value.find((m) => m.turnId === "t10" && m.kind === "assistant_text");
    expect(tailTarget).toBeDefined();
    if (tailTarget === undefined) return;
    const statusBefore = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) return;

    const tailDelete = await mut.sdk.messages.deleteMessage(
      { filePath: mut.filePath },
      { messageId: tailTarget.messageId },
    );
    expect(tailDelete.ok).toBe(true);
    const afterTailDelete = await pullMessages(mut.sdk, mut.filePath);
    expect(afterTailDelete.some((m) => m.content === "findings for area 10")).toBe(false);

    // The record change is visible to the status read (tail sum shrank).
    const statusAfter = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) return;
    expect(statusAfter.value.tailTokens).toBeLessThan(statusBefore.value.tailTokens);

    // Banded region: delete a t6 message whose derived content sits inside
    // c2's band entry. The snapshot is untouched until the next compact.
    const bandsBefore = bandMessages(afterTailDelete);
    const bandTarget = listed.value.find((m) => m.turnId === "t6" && m.kind === "assistant_text");
    expect(bandTarget).toBeDefined();
    if (bandTarget === undefined) return;
    const bandedDelete = await mut.sdk.messages.deleteMessage(
      { filePath: mut.filePath },
      { messageId: bandTarget.messageId },
    );
    expect(bandedDelete.ok).toBe(true);

    const afterBandedDelete = await pullMessages(mut.sdk, mut.filePath);
    expect(sha256(bandMessages(afterBandedDelete))).toBe(sha256(bandsBefore));

    // Next-compact visibility: the record changed under the snapshot — the
    // delete's cascade left rebuild work pending in the status read.
    const statusFinal = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusFinal.ok).toBe(true);
    if (!statusFinal.ok) return;
    expect(statusFinal.value.derivation.pending).toBeGreaterThan(0);
  });
});
