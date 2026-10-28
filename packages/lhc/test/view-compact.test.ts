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
import { o200k } from "./fixtures/tokens.js";

let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};
const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};
const EDGE_PARAMS = {
  lowerBound: 100,
  percentages: { full: 50, smooth: 10, detailed: 10, brief: 30 },
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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

function stripCloseBoundary(filePath: string, turnId: string): void {
  const db = openRaw(filePath);
  try {
    db.prepare(`UPDATE turns SET closed_at_event_order = NULL WHERE turn_id = ?`).run(turnId);
  } finally {
    db.close();
  }
}

function orphanMessagesOfTurn(filePath: string, turnId: string): string[] {
  const db = openRaw(filePath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    const rows = db
      .prepare(`SELECT message_id FROM message WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order`)
      .all(turnId) as unknown as Array<{ message_id: string }>;
    db.prepare(`DELETE FROM turns WHERE turn_id = ?`).run(turnId);
    return rows.map((row) => row.message_id);
  } finally {
    db.close();
  }
}

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
  const sdk = initLhc({ tokenFamily: "o200k", mode: "manual", inferenceCallbacks: createInferenceCallbacksDouble() });
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
      newestClosedProtection: 0.6,
    });
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
    expect(receipt.value.config).toEqual({
      full: 25,
      smooth: 40,
      detailed: 15,
      brief: 20,
      lowerBound: 400,
      newestClosedProtection: 0.6,
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

    for (const band of ["brief"] as const) {
      const actual = receipt.value.bands[band];
      const attributable = actual.tokens <= shares[band] || actual.entries === 1;
      expect(attributable).toBe(true);
    }
    expect(receipt.value.bands.brief).toEqual({ entries: 1, tokens: 41 });
    expect(receipt.value.bands.detailed.entries).toBe(2);
    expect(receipt.value.bands.detailed.tokens).toBeGreaterThanOrEqual(shares.detailed);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.bands.smooth.tokens).toBeGreaterThan(shares.smooth);
    expect(receipt.value.gaps).toEqual([]);
    expect(receipt.value.tailTokens).toBeLessThanOrEqual((400 * 25) / 100);
    expect(receipt.value.compactPoint).toBe(48);

    expect(receipt.value.totalTokens).toBe(
      receipt.value.bands.brief.tokens +
        receipt.value.bands.detailed.tokens +
        receipt.value.bands.smooth.tokens +
        receipt.value.tailTokens,
    );

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
      skippedRecords: [],
    };

    const selection = selectArrangement(inputs, {
      lowerBound: 1000,
      percentages: { full: 10, smooth: 10, detailed: 40, brief: 40 },
      tokenEstimator: o200k,
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

    expect(receipt.value.compactPoint).toBe(56);
    expect(receipt.value.coveredFrom).toBe(13);
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.brief.entries).toBe(2);
    expect(receipt.value.gaps).toHaveLength(1);
    expect(receipt.value.gaps[0]?.band).toBe("brief");
    expect(receipt.value.gaps[0]?.reason).toMatch(/^turns? t1.* not in view; use get-turns$/);
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

    const fresh = initLhc({
      tokenFamily: "o200k",
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
    });
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

    const afterCrash = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(afterCrash.ok).toBe(true);
    if (!afterCrash.ok) return;
    expect(JSON.stringify(afterCrash.value)).toBe(JSON.stringify(priorContext.value));
    expect(viewRowCount(local.filePath)).toBe(1);
    expect(boundaryPosition(local.filePath)).toBe(48);

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
    tokenFamily: "o200k",
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

    const t8 = receipt.value.degraded.find((entry) => entry.subjectId === "t8");
    expect(t8).toBeDefined();
    expect(t8?.band).toBe("smooth");
    expect(t8?.usedDerivation).toBe("message_excerpt");

    expect(receipt.value.gaps).toEqual([]);
    const c2 = receipt.value.degraded.find((entry) => entry.subjectId === "c2");
    expect(c2).toBeDefined();
    expect(c2?.usedDerivation).toBe("stored_member_concat");

    expect(receipt.value.bands.brief.entries).toBe(1);
    expect(receipt.value.bands.detailed.entries).toBe(2);
    expect(receipt.value.bands.smooth.entries).toBe(1);
    expect(receipt.value.compactPoint).toBe(48);
    expect(receipt.value.coveredFrom).toBe(1);

    const messages = await contextMessages(degraded.sdk, degraded.filePath);
    const bandText = bandMessages(messages)
      .map((message) => messageText(message))
      .join("\n\n");
    expect(bandText).toContain("[degraded: detailed-from-stored-members]");
    expect(bandText).toContain("[degraded: smooth-from-excerpt]");

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
    expect(status.value.derivation.pending).toBeGreaterThan(0);
  });
});

describe("TC-2.7 (AC-2.5): irregular turn records compact best-effort; derived-only damage degrades", () => {
  it("compacts through a second open turn, leaves the record untouched, and installs a new view", async () => {
    const corruptStore = tempStore();
    try {
      const double = createInferenceCallbacksDouble();
      const sdk = initLhc({ tokenFamily: "o200k", inferenceCallbacks: double, mode: "manual" });
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

      const first = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(first.ok).toBe(true);
      const priorView = await sdk.threadView.describe({ filePath });
      expect(priorView.ok).toBe(true);
      if (!priorView.ok) return;

      const opened = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: "left open before the damage" } }),
      ]);
      expect(opened.ok).toBe(true);
      corruptTwoOpenTurns(filePath);
      const recordBefore = recordSnapshot(filePath);

      const compacted = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(compacted.ok).toBe(true);
      if (!compacted.ok) return;

      const afterView = await sdk.threadView.describe({ filePath });
      expect(afterView.ok).toBe(true);
      if (!afterView.ok) return;
      expect(afterView.value?.viewId).toBe(compacted.value.viewId);
      expect(afterView.value?.viewId).not.toBe(priorView.value?.viewId);
      expect(recordSnapshot(filePath)).toBe(recordBefore);

      const afterContext = await sdk.threadView.getLlmRequestContext({ filePath });
      expect(afterContext.ok).toBe(true);
      if (!afterContext.ok) return;
      expect(afterContext.value.messages.length).toBeGreaterThan(0);
    } finally {
      corruptStore.cleanup();
    }
  });

  it("compacts a closed turn that carries no close boundary and leaves the record untouched", async () => {
    const corruptStore = tempStore();
    try {
      const double = createInferenceCallbacksDouble();
      const sdk = initLhc({ tokenFamily: "o200k", inferenceCallbacks: double, mode: "manual" });
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

      stripCloseBoundary(filePath, "t2");
      const recordBefore = recordSnapshot(filePath);

      const compacted = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(compacted.ok).toBe(true);
      if (!compacted.ok) return;

      const afterView = await sdk.threadView.describe({ filePath });
      expect(afterView.ok).toBe(true);
      if (!afterView.ok) return;
      expect(afterView.value?.viewId).toBe(compacted.value.viewId);
      expect(recordSnapshot(filePath)).toBe(recordBefore);
    } finally {
      corruptStore.cleanup();
    }
  });

  it("skips a message whose turn is gone, reports the skip, and leaves the message row on disk", async () => {
    const corruptStore = tempStore();
    try {
      const double = createInferenceCallbacksDouble();
      const sdk = initLhc({ tokenFamily: "o200k", inferenceCallbacks: double, mode: "manual" });
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

      const orphaned = orphanMessagesOfTurn(filePath, "t2");
      expect(orphaned.length).toBeGreaterThan(0);
      const recordBefore = recordSnapshot(filePath);

      const compacted = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
      );
      expect(compacted.ok).toBe(true);
      if (!compacted.ok) return;

      const skippedMessageIds = compacted.value.skippedRecords
        .filter((skip) => skip.kind === "orphaned_message")
        .map((skip) => skip.messageId)
        .sort();
      expect(skippedMessageIds).toEqual([...orphaned].sort());
      for (const skip of compacted.value.skippedRecords) {
        expect(skip.turnId).toBe("t2");
        expect(skip.reason.length).toBeGreaterThan(0);
      }

      expect(recordSnapshot(filePath)).toBe(recordBefore);
      for (const messageId of orphaned) {
        const shown = await sdk.messages.show({ filePath }, messageId);
        expect(shown.ok).toBe(true);
      }
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

    const drained = await mut.sdk.work.drain({ filePath: mut.filePath });
    expect(drained.ok).toBe(true);
    const afterDrain = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    expect(sha256(afterDrain)).toBe(bandHash);

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

    const statusAfter = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusAfter.ok).toBe(true);
    if (!statusAfter.ok) return;
    expect(statusAfter.value.tailTokens).toBeLessThan(statusBefore.value.tailTokens);

    const bandsBefore = bandMessages(afterTailDelete);
    const bandTarget = listed.value.find((m) => m.turnId === "t6" && m.kind === "assistant_text");
    expect(bandTarget).toBeDefined();
    if (bandTarget === undefined) return;
    const bandedDelete = await mut.sdk.messages.remove({ filePath: mut.filePath }, { messageId: bandTarget.messageId });
    expect(bandedDelete.ok).toBe(true);

    const afterBandedDelete = await contextMessages(mut.sdk, mut.filePath);
    expect(sha256(bandMessages(afterBandedDelete))).toBe(sha256(bandsBefore));

    const statusFinal = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusFinal.ok).toBe(true);
    if (!statusFinal.ok) return;
    expect(statusFinal.value.derivation.pending).toBeGreaterThan(0);
  });
});

describe("install-time drift recomputes against fresh state", () => {
  async function driftStore(): Promise<{ store: TempStore; sdk: Lhc; filePath: string }> {
    const localStore = tempStore();
    const sdk = initLhc({ tokenFamily: "o200k", inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = localStore.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: localStore.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    for (let turn = 1; turn <= 4; turn += 1) {
      const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
      if (!sent.ok) throw new Error(sent.error.reason);
    }
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
    return { store: localStore, sdk, filePath };
  }

  const DRIFT_PARAMS = { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } };

  function storedSourceState(filePath: string): { maxEventOrder: number } {
    const db = openRaw(filePath);
    try {
      const row = db.prepare(`SELECT source_state_json FROM thread_view WHERE singleton = 1`).get() as {
        source_state_json: string;
      };
      return JSON.parse(row.source_state_json) as { maxEventOrder: number };
    } finally {
      db.close();
    }
  }

  function maxEventOrder(filePath: string): number {
    const db = openRaw(filePath);
    try {
      const row = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as { m: number | bigint };
      return Number(row.m);
    } finally {
      db.close();
    }
  }

  it("installs fresh output, not the stale snapshot, when the serving view and the record both moved on", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;

      for (let turn = 5; turn <= 7; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }
      const drained = await sdk.work.drain({ filePath });
      expect(drained.ok).toBe(true);
      const interim = await sdk.threadView.compact({ filePath }, { params: DRIFT_PARAMS });
      expect(interim.ok).toBe(true);
      if (!interim.ok) return;

      const fresh = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.value.viewId).not.toBe(stale.value.viewId);
      expect(fresh.value.selection.compactPoint).not.toBe(stale.value.selection.compactPoint);

      const installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      expect(installed.value.viewId).toBe(fresh.value.viewId);
      expect(installed.value.compactPoint).toBe(fresh.value.selection.compactPoint);
      expect(installed.value.compactPoint).not.toBe(stale.value.selection.compactPoint);
      const described = await sdk.threadView.describe({ filePath });
      expect(described.ok).toBe(true);
      if (!described.ok) return;
      expect(described.value?.viewId).toBe(fresh.value.viewId);
      expect(described.value?.compactPoint).toBe(fresh.value.selection.compactPoint);
      expect(storedSourceState(filePath).maxEventOrder).toBe(maxEventOrder(filePath));
    } finally {
      local.cleanup();
    }
  });

  it("installs fresh output when only the serving view moved on", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;

      const interim = await sdk.threadView.compact(
        { filePath },
        { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
      );
      expect(interim.ok).toBe(true);
      if (!interim.ok) return;

      const installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      const described = await sdk.threadView.describe({ filePath });
      expect(described.ok).toBe(true);
      if (!described.ok) return;
      expect(described.value?.viewId).toBe(installed.value.viewId);
      expect(storedSourceState(filePath).maxEventOrder).toBe(maxEventOrder(filePath));
    } finally {
      local.cleanup();
    }
  });

  it("installs fresh output when structure and derivations moved on after prepare", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      const staleArrangement = JSON.stringify(
        stale.value.selection.entries.map((entry) => [entry.band, entry.subjectId, entry.derivationUsed]),
      );

      for (let turn = 5; turn <= 8; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }
      const drained = await sdk.work.drain({ filePath });
      expect(drained.ok).toBe(true);

      const installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      const fresh = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      const installedArrangement = JSON.stringify(
        fresh.value.selection.entries.map((entry) => [entry.band, entry.subjectId, entry.derivationUsed]),
      );
      expect(installedArrangement).not.toBe(staleArrangement);
      expect(installed.value.viewId).toBe(fresh.value.viewId);
      expect(storedSourceState(filePath).maxEventOrder).toBe(maxEventOrder(filePath));
    } finally {
      local.cleanup();
    }
  });

  it("installs the derivations that finished after prepare, without new events", async () => {
    const localStore = tempStore();
    try {
      const sdk = initLhc({
        tokenFamily: "o200k",
        inferenceCallbacks: createInferenceCallbacksDouble(),
        mode: "manual",
      });
      const filePath = localStore.threadPath();
      const created = await sdk.threads.newThread({ filePath, registryPath: localStore.registryPath });
      expect(created.ok).toBe(true);
      for (let turn = 1; turn <= 6; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }

      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      expect(
        stale.value.selection.entries.some(
          (entry) => entry.degraded || entry.gap || entry.derivationUsed === "composed_in_walk",
        ),
      ).toBe(true);
      const eventsBefore = maxEventOrder(filePath);

      const drained = await sdk.work.drain({ filePath });
      expect(drained.ok).toBe(true);
      expect(maxEventOrder(filePath)).toBe(eventsBefore);

      const installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;

      const fresh = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      const usedByInstall = installed.value.renderedBands.map((band) => band.text).join("\n");
      const usedByFresh = fresh.value.bands.map((band) => band.renderedText).join("\n");
      const usedByStale = stale.value.bands.map((band) => band.renderedText).join("\n");
      expect(usedByInstall).toBe(usedByFresh);
      expect(usedByInstall).not.toBe(usedByStale);
    } finally {
      localStore.cleanup();
    }
  });

  it("installs fresh output when only the tail gained an event after prepare", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      const staleTail = stale.value.sourceState.maxEventOrder;

      const noted = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("runtime_note", { payload: { text: "note landed between prepare and install" } }),
      ]);
      expect(noted.ok).toBe(true);
      expect(maxEventOrder(filePath)).toBe(staleTail + 1);

      const installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      expect(storedSourceState(filePath).maxEventOrder).toBe(staleTail + 1);
      expect(storedSourceState(filePath).maxEventOrder).not.toBe(staleTail);
    } finally {
      local.cleanup();
    }
  });

  it("observes, reassembles, and writes in one transaction — no rollback-and-retry pass", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      for (let turn = 5; turn <= 6; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }
      const drained = await sdk.work.drain({ filePath });
      expect(drained.ok).toBe(true);

      let transactionEntries = 0;
      let nestedBeginError: string | null = null;
      setViewInjectionHook("compact-install-before-validate", (ctx) => {
        transactionEntries += 1;
        try {
          ctx?.db.exec("BEGIN IMMEDIATE");
          nestedBeginError = "nested_begin_succeeded";
        } catch (cause) {
          nestedBeginError = cause instanceof Error ? cause.message : String(cause);
        }
      });
      let installed: Awaited<ReturnType<typeof sdk.threadView.installPreparedCompact>>;
      try {
        installed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value);
      } finally {
        setViewInjectionHook("compact-install-before-validate", null);
      }
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      expect(installed.value.viewId).not.toBe(stale.value.viewId);
      expect(transactionEntries).toBe(1);
      expect(nestedBeginError).toMatch(/transaction within a transaction/i);
    } finally {
      local.cleanup();
    }
  });

  it("leaves the prior view serving when the fresh recompute cannot produce one", async () => {
    const { store: local, sdk, filePath } = await driftStore();
    try {
      const first = await sdk.threadView.compact({ filePath }, { params: DRIFT_PARAMS });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const priorView = await sdk.threadView.describe({ filePath });
      expect(priorView.ok).toBe(true);
      if (!priorView.ok) return;
      const priorContext = await contextMessages(sdk, filePath);

      const stale = await sdk.threadView.prepareCompact({ filePath }, { params: DRIFT_PARAMS });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      for (let turn = 5; turn <= 6; turn += 1) {
        const sent = await sdk.intakeStream.messageEvents({ filePath }, degradedTurnEvents(turn));
        expect(sent.ok).toBe(true);
      }

      const signal = { aborted: false };
      setViewInjectionHook("compact-install-before-validate", () => {
        signal.aborted = true;
      });
      let failed: Awaited<ReturnType<typeof sdk.threadView.installPreparedCompact>>;
      try {
        failed = await sdk.threadView.installPreparedCompact({ filePath }, stale.value, { signal });
      } finally {
        setViewInjectionHook("compact-install-before-validate", null);
      }
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error.code).toBe("compact_stopped");

      const afterView = await sdk.threadView.describe({ filePath });
      expect(afterView.ok).toBe(true);
      if (!afterView.ok) return;
      expect(afterView.value?.viewId).toBe(priorView.value?.viewId);
      expect(sha256(bandMessages(await contextMessages(sdk, filePath)))).toBe(sha256(bandMessages(priorContext)));
    } finally {
      local.cleanup();
    }
  });
});
