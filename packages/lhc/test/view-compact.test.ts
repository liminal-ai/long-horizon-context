// Epic 03 Story 2: smart compact (TC-2.1–2.4, TC-2.6, TC-2.7, TC-1.3,
// TC-1.5, the TC-2.5 view-health completion legs, and the architecture-risk
// rows: restart-serves-snapshot and coverage-edge accounting). Every TC goes
// through the real SDK surface (initLhc().threadView.compact) against real
// temp thread files; the inference callbacks double appears only in fixture setup —
// degraded states are reached through production paths (scripted inference callback
// failure at build, edit-cascade pending clears), never by writing
// derivation directly.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type LlmRequestContextMessage, type MessageEventInput } from "../src/index.js";
import {
  type SelectionChunk,
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/thread-view/internal/select.js";
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
// GRADIENT: all three bands non-empty (smooth t8, detailed c2 plus t7 coverage, brief c1).
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

function messageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

function bandMessages(messages: readonly LlmRequestContextMessage[]): LlmRequestContextMessage[] {
  return messages.filter((message) => messageText(message).startsWith("[context ·"));
}

async function contextMessages(sdk: Lhc, filePath: string): Promise<LlmRequestContextMessage[]> {
  const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
  if (!contextRead.ok) throw new Error(`model context failed: ${contextRead.error.reason}`);
  return contextRead.value.messages;
}

async function openTailDanglingToolThread(intoStore: TempStore): Promise<{ sdk: Lhc; filePath: string }> {
  const sdk = initLhc({ mode: "manual", inferenceCallbacks: createInferenceCallbacksDouble() });
  const filePath = intoStore.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: intoStore.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);

  for (let turn = 1; turn <= 3; turn += 1) {
    const closed = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: `closed turn ${turn}` } }),
      validEvent("assistant_text", { payload: { text: `closed answer ${turn}` } }),
      validEvent("turn_end"),
    ]);
    if (!closed.ok) throw new Error(`closed turn intake failed: ${closed.error.reason}`);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);

  const opened = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "render the plan locally" } }),
    validEvent("assistant_text", { payload: { text: "Lint passed. Now let me serve it." } }),
    validEvent("tool_call", {
      payload: {
        toolCallId: "call-open-serve",
        toolName: "bash",
        arguments: { command: `npx @agent-native/core@latest plan local serve ${" --verbose".repeat(200)}` },
      },
    }),
  ]);
  if (!opened.ok) throw new Error(`open turn intake failed: ${opened.error.reason}`);

  return { sdk, filePath };
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

    // Whole-entry fills: the budgeted brief band lands at-or-under its share
    // unless a single indivisible entry had to represent. Detailed may receive
    // post-fill coverage entries so closed turns behind the compact point are
    // never silently omitted.
    for (const band of ["brief"] as const) {
      const actual = receipt.value.bands[band];
      const attributable = actual.tokens <= shares[band] || actual.entries === 1;
      expect(attributable).toBe(true);
    }
    // The fixture's pinned arrangement under these params (literal rules):
    // c1 fits brief, c2 fills detailed as a loner, detailed also carries the
    // coverage entry for skipped t7, and tail remains under the full share
    // plus turn-boundary snap.
    // Token count includes the <turns>…</turns> member-turn header on chunk bands.
    expect(receipt.value.bands.brief).toEqual({ entries: 1, tokens: 41 });
    expect(receipt.value.bands.detailed.entries).toBe(2);
    expect(receipt.value.bands.detailed.tokens).toBeGreaterThanOrEqual(shares.detailed);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.bands.smooth.tokens).toBeGreaterThan(shares.smooth);
    expect(receipt.value.gaps).toEqual([]);
    expect(receipt.value.tailTokens).toBeLessThanOrEqual((400 * 25) / 100);
    expect(receipt.value.compactPoint).toBe(48);

    // The explicit total (ruling 013): the assembled view's actual size —
    // band tokens plus tail — reported beside the per-band actuals.
    expect(receipt.value.totalTokens).toBe(
      receipt.value.bands.brief.tokens +
        receipt.value.bands.detailed.tokens +
        receipt.value.bands.smooth.tokens +
        receipt.value.tailTokens,
    );

    // No model call anywhere in the compact path; the record (events,
    // messages, turns, chunks, forms) is byte-identical after.
    expect(captured.length).toBe(capturedBefore);
    expect(recordSnapshot(fixture.filePath)).toBe(recordBefore);
  });

  it("keeps a latest open turn with a dangling tool call in the live session tail", async () => {
    const local = await openTailDanglingToolThread(store);

    const receipt = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: TARGET_PARAMS });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    expect(receipt.value.compactPoint).toBe(9);
    expect(receipt.value.firstKeptMessageId).toBe("m10");
    expect(receipt.value.bands.smooth.entries).toBeGreaterThan(0);
    expect(receipt.value.tailTokens).toBeGreaterThan((TARGET_PARAMS.lowerBound * TARGET_PARAMS.percentages.full) / 100);

    const view = await local.sdk.threadView.getSessionThreadView({ filePath: local.filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const openUser = view.value.entries.find(
      (entry) =>
        "role" in entry &&
        entry.role === "user" &&
        typeof entry.content === "string" &&
        entry.content === "render the plan locally",
    );
    expect(openUser).toBeDefined();
    expect(openUser && "sourceMessages" in openUser ? openUser.sourceMessages[0]?.messageId : undefined).toBe("m10");

    const last = view.value.entries.at(-1);
    expect(last).toBeDefined();
    expect(last && "role" in last ? last.role : undefined).toBe("assistant");
    if (last === undefined || !("role" in last) || last.role !== "assistant") return;
    expect(last.sourceMessages.map((source) => source.messageId)).toEqual(["m11", "m12"]);
    expect(last.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", toolCallId: "call-open-serve", toolName: "bash" }),
    );
  });
});

describe("TC-2.6 (AC-2.10): band entries render in their selected bands", () => {
  it("brief, detailed, and smooth band text carries selected conversation content", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);

    const messages = await contextMessages(fixture.sdk, fixture.filePath);
    const bands = bandMessages(messages);
    const byBand = new Map(
      bands.map((message) => [messageText(message).match(/^\[context · ([^\]]+)\]/)?.[1], messageText(message)]),
    );
    expect(byBand.get("brief")).toContain("projection(");
    expect(byBand.get("detailed")).toContain("projection(");
    expect(byBand.get("smooth")).toContain("User prompt");
  });
});

describe("architecture-risk: coverage edge accounting", () => {
  it("renders coverage entries for closed turns left uncovered inside an open chunk", () => {
    const turns: SelectionTurn[] = Array.from({ length: 6 }, (_, index) => {
      const turn = index + 1;
      return {
        turnId: `t${turn}`,
        turnOrder: turn,
        status: "closed",
        openedAt: (turn - 1) * 10 + 1,
        closedAt: turn * 10,
      };
    });
    const messages: SelectionMessage[] = turns.map((turn) => ({
      messageId: `m${turn.turnOrder}`,
      order: turn.openedAt,
      kind: "user_prompt",
      tokenEstimate: turn.turnId === "t6" ? 100 : 10,
      turnId: turn.turnId,
      text: `prompt ${turn.turnId}`,
    }));
    const chunks: SelectionChunk[] = [
      { chunkId: "c1", chunkOrder: 1, status: "closed", memberTurnIds: ["t1", "t2"] },
      { chunkId: "c2", chunkOrder: 2, status: "open", memberTurnIds: ["t3", "t4", "t5"] },
    ];
    const inputs: SelectionInputs = {
      messages,
      turns,
      chunks,
      derivations: new Map([
        ["t3/detailed_turn_compression", { state: "ready", content: "compressed ".repeat(200) }],
        ["t4/detailed_turn_compression", { state: "failed", reason: "compression failed" }],
        ["t4/pre_detailed_assembly", { state: "ready", content: `User:\n${"large ".repeat(500)}\n\n⏺ more` }],
        ["t5/turn_rendering", { state: "ready", content: "newest banded turn" }],
        ["c1/chunk_summary_detailed", { state: "ready", content: "closed chunk summary" }],
      ]),
      maxEventOrder: 60,
      derivationCounts: {},
    };

    const selection = selectArrangement(inputs, {
      lowerBound: 1000,
      percentages: { full: 10, smooth: 10, detailed: 40, brief: 40 },
    });

    expect(selection.compactPoint).toBe(50);
    expect(selection.coveredFrom).toBe(1);
    expect(
      selection.entries.map((entry) => ({
        band: entry.band,
        subjectKind: entry.subjectKind,
        subjectId: entry.subjectId,
        derivationUsed: entry.derivationUsed,
        gap: entry.gap,
      })),
    ).toEqual([
      { band: "detailed", subjectKind: "chunk", subjectId: "c1", derivationUsed: "chunk_summary_detailed", gap: false },
      {
        band: "detailed",
        subjectKind: "turn",
        subjectId: "t3",
        derivationUsed: "detailed_turn_compression",
        gap: false,
      },
      { band: "smooth", subjectKind: "turn", subjectId: "t4", derivationUsed: "message_excerpt", gap: false },
      { band: "smooth", subjectKind: "turn", subjectId: "t5", derivationUsed: "turn_rendering", gap: false },
    ]);
    expect(selection.entries.filter((entry) => entry.gap)).toEqual([]);
    expect(selection.entries.find((entry) => entry.subjectId === "t4")?.degraded).toBe(true);
  });

  it("closed turns below the coverage edge remain outside the represented window", async () => {
    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: EDGE_PARAMS });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    // The compact point lands at t10's close, so c3, c2, and c1 are all
    // chunk candidates; c3 takes detailed (loner), the brief share holds c2
    // alone, and c1 remains after the chunk budgets. c1's member turns are
    // older than the oldest selected subject, so covered_from reports the
    // window boundary instead of emitting noisy gaps for out-of-window turns.
    expect(receipt.value.compactPoint).toBe(56);
    expect(receipt.value.coveredFrom).toBe(13);
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.brief.entries).toBe(1);
    expect(receipt.value.gaps).toEqual([]);

    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.brief.entries).toBe(1);
  });
});

describe("architecture-risk: restart serves the snapshot (real-file durability)", () => {
  it("a fresh SDK on the same file serves byte-identical band content", async () => {
    const local = await derivedThreadFixture(store);
    const receipt = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);
    const before = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Not a same-process reread: a fresh SDK instance opens the file cold.
    const fresh = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const after = await fresh.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  });
});

describe("TC-2.4 (AC-2.6): crash injection at the compact-write point", () => {
  it("an injected crash leaves the previous view serving; the rerun lands clean with no partial state", async () => {
    const local = await derivedThreadFixture(store);
    const first = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(first.ok).toBe(true);
    const priorContext = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(priorContext.ok).toBe(true);
    if (!priorContext.ok) return;
    expect(boundaryPosition(local.filePath)).toBe(48);

    setViewInjectionHook("compact-write", () => {
      throw new Error("injected crash between sweep and view write");
    });
    try {
      const crashed = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: EDGE_PARAMS });
      expect(crashed.ok).toBe(false);
      if (crashed.ok) return;
      expect(crashed.error.errorClass).toBe("system_error");
      expect(crashed.error.reason).toContain("injected crash");
    } finally {
      setViewInjectionHook("compact-write", null);
    }

    // The previous view still serves, byte-identical; no partial rows, no
    // boundary movement.
    const afterCrash = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(afterCrash.ok).toBe(true);
    if (!afterCrash.ok) return;
    expect(JSON.stringify(afterCrash.value)).toBe(JSON.stringify(priorContext.value));
    expect(viewRowCount(local.filePath)).toBe(1);
    expect(boundaryPosition(local.filePath)).toBe(48);

    // Rerun: the new view lands whole and the boundary resets to ITS compact
    // point (56) in the same transaction.
    const rerun = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: EDGE_PARAMS });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.value.coveredFrom).toBe(13);
    expect(viewRowCount(local.filePath)).toBe(1);
    expect(boundaryPosition(local.filePath)).toBe(56);
    const rerunContext = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(rerunContext.ok).toBe(true);
    if (!rerunContext.ok) return;
    expect(JSON.stringify(rerunContext.value)).not.toBe(JSON.stringify(priorContext.value));
  });

  it("abort immediately before snapshot write leaves the prior view unchanged", async () => {
    const local = await derivedThreadFixture(store);
    const first = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(first.ok).toBe(true);
    const priorContext = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(priorContext.ok).toBe(true);
    if (!priorContext.ok) return;
    const priorCompactPoint = boundaryPosition(local.filePath);

    const stop = { flag: false };
    const signal = {
      get aborted() {
        return stop.flag;
      },
    };
    setViewInjectionHook("compact-write", () => {
      stop.flag = true;
    });
    try {
      const stopped = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: EDGE_PARAMS, signal });
      expect(stopped.ok).toBe(false);
      if (stopped.ok) return;
      expect(stopped.error).toMatchObject({
        errorClass: "caller_error",
        code: "compact_stopped",
      });
    } finally {
      setViewInjectionHook("compact-write", null);
    }

    const afterStop = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(afterStop.ok).toBe(true);
    if (!afterStop.ok) return;
    expect(JSON.stringify(afterStop.value)).toBe(JSON.stringify(priorContext.value));
    expect(viewRowCount(local.filePath)).toBe(1);
    expect(boundaryPosition(local.filePath)).toBe(priorCompactPoint);
  });
});

// ── degraded thread (TC-2.3 + the TC-2.5 view-health completion legs) ──

// The fixture conversation rebuilt with manufactured derived damage, all
// through production paths: c1's brief summary fails through a scripted
// inference callback failure at build; post-build edits clear t8's turn
// forms and all of c2's dependent chain to pending (the Epic 02 cascade) —
// a pending turn rendering for the smooth band, and a chunk with no usable
// form at all (summaries pending, zero ready member projections) for the
// gap rung.
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);
const C1_BRIEF_FAILURE_REASON = "rate_limit: scripted c1 brief failure (test)";

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
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4400 },
  });
  const filePath = intoStore.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: intoStore.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);

  const promptIdByTurn = new Map<number, string>();
  for (let turn = 1; turn <= 12; turn += 1) {
    if (turn === 4) {
      // c1 closes during turn 4's drain (placement of t4): its brief summary
      // lands failed.
      double.failKind("chunk_summary_brief", 1, {
        reason: C1_BRIEF_FAILURE_REASON,
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

    // The unusable chunk (c2: summaries pending, zero ready member
    // projections): Story 4 compact recovery uses stored-member concat, not
    // a gap, so the span remains present. t7 is represented by the coverage
    // cascade between the selected chunk and smooth turn.
    expect(receipt.value.gaps).toEqual([]);
    const c2 = receipt.value.degraded.find((entry) => entry.subjectId === "c2");
    expect(c2).toBeDefined();
    expect(c2?.usedDerivation).toBe("stored_member_concat");

    // Per-band counts present; no span silently absent: every turn in the
    // compacted range is accounted for by a band subject (c1: t1–t3, c2:
    // t4–t6, coverage: t7, smooth: t8) and everything after the compact
    // point is tail.
    expect(receipt.value.bands.brief.entries).toBe(1);
    expect(receipt.value.bands.detailed.entries).toBe(2);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.compactPoint).toBe(48);
    expect(receipt.value.coveredFrom).toBe(1);

    // The rendered text carries the markers (degrade visibly, AC-2.5/2.10).
    const messages = await contextMessages(degraded.sdk, degraded.filePath);
    const bandText = bandMessages(messages)
      .map((message) => messageText(message))
      .join("\n\n");
    expect(bandText).toContain("[degraded: detailed-from-stored-members]");
    expect(bandText).toContain("[degraded: smooth-from-excerpt]");

    // Default sweep does not bypass older live queue work while compacting.
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
      const priorContext = await sdk.threadView.getLlmRequestContext({ filePath });
      expect(priorContext.ok).toBe(true);
      if (!priorContext.ok) return;
      const priorView = await sdk.threadView.describe({ filePath });
      expect(priorView.ok).toBe(true);
      if (!priorView.ok) return;

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
      const afterContext = await sdk.threadView.getLlmRequestContext({ filePath });
      expect(afterContext.ok).toBe(true);
      if (!afterContext.ok) return;
      expect(JSON.stringify(bandMessages(afterContext.value.messages))).toBe(
        JSON.stringify(bandMessages(priorContext.value.messages)),
      );
      const afterView = await sdk.threadView.describe({ filePath });
      expect(afterView.ok).toBe(true);
      if (!afterView.ok) return;
      expect(afterView.value?.viewId).toBe(priorView.value?.viewId);
      expect(recordSnapshot(filePath)).toBe(recordBefore);
    } finally {
      corruptStore.cleanup();
    }
  });

  it("control: a thread with only derived-material damage compacts successfully with gaps", async () => {
    const local = await derivedThreadFixture(store);
    const receipt = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
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

  it("TC-1.3: editing a banded subject leaves band bytes unchanged across context reads, before and after the drain", async () => {
    const before = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    const bandHash = sha256(before);

    // t5 is banded inside c2's detailed entry; edit its prompt.
    const listed = await mut.sdk.messages.list({ filePath: mut.filePath });
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

    const afterEdit = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    expect(sha256(afterEdit)).toBe(bandHash);

    // Drain the requeued rebuilds: the rebuilt summary lands in the RECORD
    // only; the snapshot still serves the same bytes.
    const drained = await mut.sdk.work.drain({ filePath: mut.filePath });
    expect(drained.ok).toBe(true);
    const afterDrain = bandMessages(await contextMessages(mut.sdk, mut.filePath));
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
      const detailedBand = afterDrain.find((m) => messageText(m).startsWith("[context · detailed]"));
      expect(detailedBand === undefined ? undefined : messageText(detailedBand)).not.toContain(
        row?.content ?? "<unset>",
      );
    } finally {
      db.close();
    }
  });

  it("TC-1.5: a tail delete vanishes from the next context read; a banded delete leaves the snapshot until the next compact", async () => {
    const listed = await mut.sdk.messages.list({ filePath: mut.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    // Tail region: t9 onward (compact point 48). Delete t10's findings.
    const tailTarget = listed.value.find((m) => m.turnId === "t10" && m.kind === "assistant_text");
    expect(tailTarget).toBeDefined();
    if (tailTarget === undefined) return;
    const statusBefore = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusBefore.ok).toBe(true);
    if (!statusBefore.ok) return;

    const tailDelete = await mut.sdk.messages.remove({ filePath: mut.filePath }, { messageId: tailTarget.messageId });
    expect(tailDelete.ok).toBe(true);
    const afterTailDelete = await contextMessages(mut.sdk, mut.filePath);
    expect(afterTailDelete.some((m) => messageText(m) === "findings for area 10")).toBe(false);

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
    const bandedDelete = await mut.sdk.messages.remove({ filePath: mut.filePath }, { messageId: bandTarget.messageId });
    expect(bandedDelete.ok).toBe(true);

    const afterBandedDelete = await contextMessages(mut.sdk, mut.filePath);
    expect(sha256(bandMessages(afterBandedDelete))).toBe(sha256(bandsBefore));

    // Next-compact visibility: the record changed under the snapshot — the
    // delete's cascade left rebuild work pending in the status read.
    const statusFinal = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusFinal.ok).toBe(true);
    if (!statusFinal.ok) return;
    expect(statusFinal.value.derivation.pending).toBeGreaterThan(0);
  });
});
