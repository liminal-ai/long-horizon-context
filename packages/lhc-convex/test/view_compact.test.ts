// Smart compact (TC-2.1–2.4, TC-2.6, TC-2.7, TC-1.3, TC-1.5, the TC-2.5
// view-health completion legs, and the architecture-risk rows:
// restart-serves-snapshot and coverage-edge accounting). Every TC goes through
// the real SDK surface (threadView.compact) against real temp threads.
//
// CALIBRATION NOTE. The band-selection ALGORITHM is proven byte-identical to
// the frozen engine by the committed goldens (view_select_golden.test.ts). But
// the fake model host returns different canned summary text than the frozen
// inference-callbacks double, so summaries carry different token sizes. Under
// budget-pressured param sets that are NOT one of the robust goldens, the
// resulting arrangement (which entries fit which band, and their token counts)
// differs from the frozen fixture. Where a frozen assertion pins such a
// fixture-size-coupled literal, it is recalibrated to the port fixture's
// deterministic value and flagged `[calibrated]`; every structural/behavioral
// invariant (compactPoint, gaps, totalTokens = Σ parts, zero-model,
// record-unchanged, degraded ladder, durability, corruption refusal) is ported
// verbatim.
//
// EXCLUDED: TC-2.4's crash-injection leg (an injected throw between sweep and
// view write) — the frozen SQLite seam `setViewInjectionHook` has no analog;
// Convex mutations are atomic transactions with no mid-transaction fault seam,
// so a failed compact leaves zero partial state by platform guarantee. The
// abort-before-write leg IS ported (the `aborted` signal).
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api.js";
import { initLhc, type Lhc, type LlmRequestContext } from "../src/client/index.js";

type LlmRequestContextMessage = LlmRequestContext["messages"][number];

import {
  type SelectionChunk,
  type SelectionInputs,
  type SelectionMessage,
  type SelectionTurn,
  selectArrangement,
} from "../src/shared/view_select.js";
import { capturedCalls } from "./convex/model.js";
import {
  type DerivedThreadFixture,
  derivedThreadFixture,
  dummyModelCall,
  executor,
  type ServiceFixture,
  serviceFixture,
  validEvent,
} from "./fixtures/index.js";

let fixture: DerivedThreadFixture;

beforeAll(async () => {
  fixture = await derivedThreadFixture();
});

// The story's reference configs (the goldens pin arrangements exactly).
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

// The canonical record plus its derived state — everything compact must never
// touch (AC-2.9). View tables and the boundary are excluded: those are
// compact's own rows.
async function recordSnapshot(f: ServiceFixture): Promise<string> {
  return await f.test.run(async (ctx) => {
    const dump: Record<string, unknown> = {};
    for (const table of [
      "events",
      "messages",
      "messageBlocks",
      "turns",
      "chunks",
      "chunkMembers",
      "derivations",
    ] as const) {
      dump[table] = (await ctx.db.query(table).collect())
        .filter((row) => (row as { instance: string }).instance === f.instance)
        .sort((a, b) => a._id.localeCompare(b._id));
    }
    return JSON.stringify(dump);
  });
}

// Full-file state including the view rows and boundary — for the
// thread-unchanged-after-rejection assertions.
async function fullStateSnapshot(f: ServiceFixture): Promise<string> {
  const record = await recordSnapshot(f);
  return await f.test.run(async (ctx) => {
    const extra: Record<string, unknown> = { record };
    for (const table of ["threadViews", "threadViewBands", "viewBoundaries", "workItems"] as const) {
      extra[table] = (await ctx.db.query(table).collect())
        .filter((row) => (row as { instance: string }).instance === f.instance)
        .sort((a, b) => a._id.localeCompare(b._id));
    }
    return JSON.stringify(extra);
  });
}

async function viewRowCount(f: ServiceFixture): Promise<number> {
  return await f.test.run(async (ctx) => {
    return (await ctx.db.query("threadViews").collect()).filter((row) => row.instance === f.instance).length;
  });
}

async function boundaryPosition(f: ServiceFixture): Promise<number> {
  return await f.test.run(async (ctx) => {
    const row = (await ctx.db.query("viewBoundaries").collect()).find((candidate) => candidate.instance === f.instance);
    return row?.position ?? 0;
  });
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

// A second SDK bound to the SAME component instance and harness — the port's
// analog of a fresh SDK reopening the same file cold.
function sameInstanceSdk(f: ServiceFixture): Lhc {
  return initLhc(api, executor(f.test), {
    componentInstanceId: f.instance,
    mode: "manual",
    inference: {
      call: dummyModelCall,
      assignments: {
        smoothed_prompt: { provider: "test", model: "model-smoothed_prompt", prompt: "smoothing-v1" },
        tool_result_summary: { provider: "test", model: "model-tool_result_summary", prompt: "tool-result-v2" },
        detailed_turn_compression: {
          provider: "test",
          model: "model-detailed_turn_compression",
          prompt: "detailed-turn-compression-v3",
        },
        chunk_summary_brief: { provider: "test", model: "model-chunk_summary_brief", prompt: "chunk-brief-v3" },
      },
    },
  });
}

async function openTailDanglingToolThread(): Promise<ServiceFixture & { filePath: string }> {
  const f = serviceFixture();
  const filePath = (await f.createThread()).filePath;
  for (let turn = 1; turn <= 3; turn += 1) {
    const closed = await f.sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: `closed turn ${turn}` } }),
      validEvent("assistant_text", { payload: { text: `closed answer ${turn}` } }),
      validEvent("turn_end"),
    ]);
    if (!closed.ok) throw new Error(`closed turn intake failed: ${closed.error.reason}`);
  }
  const drained = await f.sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);

  const opened = await f.sdk.intakeStream.messageEvents({ filePath }, [
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
  return Object.assign(f, { filePath });
}

describe("TC-2.1 (AC-2.2, AC-2.3, AC-2.7): profiles, explicit params, and named rejections", () => {
  it("rejects percentages summing to 105 naming the sum, and an unknown profile naming it; thread unchanged", async () => {
    const before = await fullStateSnapshot(fixture);

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

    // Thread unchanged after all rejections: no view row landed, no record or
    // boundary movement (read-back equality).
    expect(await fullStateSnapshot(fixture)).toBe(before);
    expect(await viewRowCount(fixture)).toBe(0);
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
    // At a 120k bound this small thread is all tail: bands empty, compact point
    // at the origin, and the reported total IS the tail.
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
    const capturedBefore = capturedCalls.length;
    const recordBefore = await recordSnapshot(fixture);

    const receipt = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET_PARAMS });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const shares = {
      smooth: (400 * 25) / 100,
      detailed: (400 * 25) / 100,
      brief: (400 * 25) / 100,
    };

    // Whole-entry fills: a budgeted band lands at-or-under its share unless a
    // single indivisible entry had to represent.
    for (const band of ["brief"] as const) {
      const actual = receipt.value.bands[band];
      const attributable = actual.tokens <= shares[band] || actual.entries === 1;
      expect(attributable).toBe(true);
    }
    // [calibrated] The port fixture's arrangement under these params: smaller
    // canned summaries let smooth+detailed absorb the closed chunks before the
    // brief band's turn, so brief is empty and detailed carries three entries.
    // The full bands object is asserted exactly (stronger than the frozen
    // piecewise checks; deterministic).
    expect(receipt.value.bands).toEqual({
      brief: { entries: 0, tokens: 0 },
      detailed: { entries: 3, tokens: 111 },
      smooth: { entries: 1, tokens: 174 },
    });
    expect(receipt.value.bands.smooth.tokens).toBeGreaterThan(shares.smooth);
    expect(receipt.value.gaps).toEqual([]);
    expect(receipt.value.tailTokens).toBeLessThanOrEqual((400 * 25) / 100);
    expect(receipt.value.compactPoint).toBe(48);

    // The explicit total: the assembled view's actual size — band tokens plus
    // tail — reported beside the per-band actuals.
    expect(receipt.value.totalTokens).toBe(
      receipt.value.bands.brief.tokens +
        receipt.value.bands.detailed.tokens +
        receipt.value.bands.smooth.tokens +
        receipt.value.tailTokens,
    );

    // No model call anywhere in the compact path; the record is byte-identical.
    expect(capturedCalls.length).toBe(capturedBefore);
    expect(await recordSnapshot(fixture)).toBe(recordBefore);
  });

  it("keeps a latest open turn with a dangling tool call in the live session tail", async () => {
    const local = await openTailDanglingToolThread();

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
    // [calibrated] The frozen double stamps a `projection(…)` marker into its
    // summaries; the fake host stamps `canned <kind> text …`. Each band still
    // carries the content selected for it — the brief chunk summary, the
    // detailed compression, and the newest turn's live conversation text.
    expect(byBand.get("brief")).toContain("canned chunk_summary_brief text");
    expect(byBand.get("detailed")).toContain("canned detailed_turn_compression text");
    expect(byBand.get("smooth")).toContain("User prompt");
    expect(byBand.get("smooth")).toContain("findings for area 8");
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

    // The compact point lands at t10's close. [calibrated] Since S3's labels
    // (<turns> headers + <tN>/<mN> wraps) grew entry sizes, the brief band
    // admits only one chunk entry — matching the frozen shape, where c1 is
    // pushed out of the window and coveredFrom stops at the window edge (t13)
    // instead of reaching back to t1.
    expect(receipt.value.compactPoint).toBe(56);
    expect(receipt.value.coveredFrom).toBe(13);
    expect(receipt.value.bands.detailed.entries).toBe(1);
    expect(receipt.value.bands.brief.entries).toBe(1);
    expect(receipt.value.gaps).toEqual([]);
  });
});

describe("architecture-risk: restart serves the snapshot (real-file durability)", () => {
  it("a fresh SDK on the same file serves byte-identical band content", async () => {
    const local = await derivedThreadFixture();
    const receipt = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);
    const before = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Not a same-SDK reread: a fresh SDK bound to the same instance opens cold.
    const fresh = sameInstanceSdk(local);
    const after = await fresh.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  });
});

describe("TC-2.4 (AC-2.6): abort before the compact-write point", () => {
  it("abort immediately before snapshot write leaves the prior view unchanged", async () => {
    const local = await derivedThreadFixture();
    const first = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(first.ok).toBe(true);
    const priorContext = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(priorContext.ok).toBe(true);
    if (!priorContext.ok) return;
    const priorCompactPoint = await boundaryPosition(local);

    const stopped = await local.sdk.threadView.compact(
      { filePath: local.filePath },
      { params: EDGE_PARAMS, signal: { aborted: true } },
    );
    expect(stopped.ok).toBe(false);
    if (stopped.ok) return;
    expect(stopped.error).toMatchObject({
      errorClass: "caller_error",
      code: "compact_stopped",
    });

    const afterStop = await local.sdk.threadView.getLlmRequestContext({ filePath: local.filePath });
    expect(afterStop.ok).toBe(true);
    if (!afterStop.ok) return;
    expect(JSON.stringify(afterStop.value)).toBe(JSON.stringify(priorContext.value));
    expect(await viewRowCount(local)).toBe(1);
    expect(await boundaryPosition(local)).toBe(priorCompactPoint);
  });
});

// ── degraded thread (TC-2.3 + the TC-2.5 view-health completion legs) ──

const C1_BRIEF_FAILURE_REASON = "rate_limit: scripted c1 brief failure (test)";

interface DegradedThread extends DerivedThreadFixture {}

// The committed derived corpus with manufactured derived damage: c1's brief
// summary lands failed, then post-build edits (turns 4, 5, 6, 8, NOT drained)
// clear the dependent chains to pending through the real Epic 02 edit cascade —
// a pending turn rendering for the smooth band (t8) and a chunk with no usable
// summary and pending member projections (c2) for the stored-member concat
// rung.
async function buildDegradedThread(): Promise<DegradedThread> {
  const f = await derivedThreadFixture();
  // c1's brief summary → failed (derived-only damage, below the SDK; the
  // owning compact must degrade past it, never fail).
  await f.test.run(async (ctx) => {
    const brief = (await ctx.db.query("derivations").collect()).find(
      (row) =>
        row.instance === f.instance &&
        row.thread === f.threadId &&
        row.scope === "chunk" &&
        row.subject === "c1" &&
        row.deriv === "chunk_summary_brief",
    );
    if (brief === undefined) throw new Error("c1 brief derivation missing");
    await ctx.db.patch("derivations", brief._id, {
      state: "failed",
      content: undefined,
      reason: C1_BRIEF_FAILURE_REASON,
    });
  });
  // Post-build edits, NOT drained: the cascade clears each edited message's
  // dependent chain to pending.
  const listed = await f.sdk.messages.list({ filePath: f.filePath });
  if (!listed.ok) throw new Error(`list failed: ${listed.error.reason}`);
  for (const turn of [4, 5, 6, 8]) {
    const prompt = listed.value.find((m) => m.turnId === `t${turn}` && m.kind === "user_prompt");
    if (prompt === undefined) throw new Error(`no prompt for turn ${turn}`);
    const edited = await f.sdk.messages.edit(
      { filePath: f.filePath },
      { messageId: prompt.messageId, content: `turn ${turn}: edited investigation of area ${turn}` },
    );
    if (!edited.ok) throw new Error(`edit failed: ${edited.error.reason}`);
  }
  return f;
}

describe("TC-2.3 (AC-2.5, AC-2.7) + TC-2.5 view-health legs: degraded material renders fallbacks, never fails the compact", () => {
  let degraded: DegradedThread;

  beforeAll(async () => {
    degraded = await buildDegradedThread();
  });

  it("completes with ladder fallbacks marked, gap entries for unusable spans, and full accounting in the receipt", async () => {
    const capturedBefore = capturedCalls.length;

    const receipt = await degraded.sdk.threadView.compact(
      { filePath: degraded.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 } } },
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    // The pending turn rendering (t8, edited): the smooth entry degrades down
    // its ladder (compression pending too) to the deterministic excerpt.
    const t8 = receipt.value.degraded.find((entry) => entry.subjectId === "t8");
    expect(t8).toBeDefined();
    expect(t8?.band).toBe("smooth");
    expect(t8?.usedDerivation).toBe("message_excerpt");

    // The unusable chunk (c2: summaries pending, zero ready member
    // projections): compact recovery uses stored-member concat, not a gap, so
    // the span remains present.
    expect(receipt.value.gaps).toEqual([]);
    const c2 = receipt.value.degraded.find((entry) => entry.subjectId === "c2");
    expect(c2).toBeDefined();
    expect(c2?.usedDerivation).toBe("stored_member_concat");

    // Per-band counts present; no span silently absent.
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
    expect(capturedCalls.length).toBe(capturedBefore);
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
    const local = await derivedThreadFixture();
    const { filePath, threadId } = { filePath: local.filePath, threadId: local.threadId };

    // A prior view exists before the damage.
    const first = await local.sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 80, percentages: { full: 50, smooth: 30, detailed: 10, brief: 10 } } },
    );
    expect(first.ok).toBe(true);
    const priorContext = await local.sdk.threadView.getLlmRequestContext({ filePath });
    expect(priorContext.ok).toBe(true);
    if (!priorContext.ok) return;
    const priorView = await local.sdk.threadView.describe({ filePath });
    expect(priorView.ok).toBe(true);
    if (!priorView.ok) return;

    // Manufactured canonical corruption below the SDK: a second open turn row,
    // the invariant violation no public operation can produce.
    await local.test.run(async (ctx) => {
      await ctx.db.insert("turns", {
        instance: local.instance,
        thread: threadId,
        turn: "t-corrupt",
        turnOrder: 999,
        status: "open",
        openedAtEventOrder: 999,
      });
    });
    const recordBefore = await recordSnapshot(local);

    const refused = await local.sdk.threadView.compact(
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
    const afterContext = await local.sdk.threadView.getLlmRequestContext({ filePath });
    expect(afterContext.ok).toBe(true);
    if (!afterContext.ok) return;
    expect(JSON.stringify(bandMessages(afterContext.value.messages))).toBe(
      JSON.stringify(bandMessages(priorContext.value.messages)),
    );
    const afterView = await local.sdk.threadView.describe({ filePath });
    expect(afterView.ok).toBe(true);
    if (!afterView.ok) return;
    expect(afterView.value?.viewId).toBe(priorView.value?.viewId);
    expect(await recordSnapshot(local)).toBe(recordBefore);
  });

  it("control: a thread with only derived-material damage compacts successfully", async () => {
    const local = await buildDegradedThread();
    const receipt = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(receipt.ok).toBe(true);
  });
});

describe("TC-1.3 (AC-1.4) and TC-1.5 (AC-1.6): snapshot immutability under record mutation", () => {
  let mut: DerivedThreadFixture;

  beforeAll(async () => {
    mut = await derivedThreadFixture();
    const receipt = await mut.sdk.threadView.compact({ filePath: mut.filePath }, { params: GRADIENT_PARAMS });
    if (!receipt.ok) throw new Error(`setup compact failed: ${receipt.error.reason}`);
  });

  it("TC-1.3: editing a banded subject leaves band bytes unchanged across context reads, before and after the drain", async () => {
    const before = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    const bandHash = JSON.stringify(before);

    // t5 is banded inside c2's detailed entry; edit its prompt.
    const listed = await mut.sdk.messages.list({ filePath: mut.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const t5Prompt = listed.value.find((m) => m.turnId === "t5" && m.kind === "user_prompt");
    expect(t5Prompt).toBeDefined();
    if (t5Prompt === undefined) return;
    // Capture c2's detailed-summary rebuild marker before the edit so the
    // record change can be proven by its advance (the fake host's canned
    // summary text is constant, so a rebuilt summary is byte-identical — the
    // frozen content-inequality proof does not transfer).
    const c2Before = await mut.test.run(async (ctx) => {
      const row = (await ctx.db.query("derivations").collect()).find(
        (r) =>
          r.instance === mut.instance &&
          r.thread === mut.threadId &&
          r.scope === "chunk" &&
          r.subject === "c2" &&
          r.deriv === "chunk_summary_detailed",
      );
      return row === undefined ? undefined : { sourceVersion: row.sourceVersion, derivedAt: row.derivedAt };
    });
    expect(c2Before).toBeDefined();
    const edited = await mut.sdk.messages.edit(
      { filePath: mut.filePath },
      { messageId: t5Prompt.messageId, content: "turn 5: edited after the snapshot" },
    );
    expect(edited.ok).toBe(true);

    const afterEdit = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    expect(JSON.stringify(afterEdit)).toBe(bandHash);

    // Drain the requeued rebuilds: the rebuilt summary lands in the RECORD
    // only; the snapshot still serves the same bytes.
    const drained = await mut.sdk.work.drain({ filePath: mut.filePath });
    expect(drained.ok).toBe(true);
    const afterDrain = bandMessages(await contextMessages(mut.sdk, mut.filePath));
    expect(JSON.stringify(afterDrain)).toBe(bandHash);

    // The record really changed underneath: c2's detailed summary was rebuilt
    // by the edit cascade — its rebuild marker advanced — while the snapshot
    // still serves the pre-edit band bytes above.
    const c2After = await mut.test.run(async (ctx) => {
      const row = (await ctx.db.query("derivations").collect()).find(
        (r) =>
          r.instance === mut.instance &&
          r.thread === mut.threadId &&
          r.scope === "chunk" &&
          r.subject === "c2" &&
          r.deriv === "chunk_summary_detailed",
      );
      return row === undefined
        ? undefined
        : { sourceVersion: row.sourceVersion, derivedAt: row.derivedAt, state: row.state };
    });
    expect(c2After).toBeDefined();
    if (c2After === undefined || c2Before === undefined) return;
    expect(c2After.state).toBe("ready");
    expect(c2After.sourceVersion).toBeGreaterThan(c2Before.sourceVersion);
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
    expect(JSON.stringify(bandMessages(afterBandedDelete))).toBe(JSON.stringify(bandsBefore));

    // Next-compact visibility: the delete's cascade left rebuild work pending.
    const statusFinal = await mut.sdk.threadView.status({ filePath: mut.filePath });
    expect(statusFinal.ok).toBe(true);
    if (!statusFinal.ok) return;
    expect(statusFinal.value.derivation.pending).toBeGreaterThan(0);
  });
});
