// Story 3 (Epic 04): TC-2.1-2.3 — the view-contents report plus the describe
// legs. threadView.describe exposes the stored active view row verbatim (null
// when absent, never recomputed); inspect.view composes describe + a measured
// context read so loadCost equals what model context serves now (AC-2.3,
// parity by construction) — asserted here against an INDEPENDENT context read
// re-measured with the same estimator, on a compacted and a never-compacted
// thread (meta null, tail-only, AC-2.4). Reads are pure (AC-1.4): repeated
// deep-equal, zero model calls. The frozen "throwing inference callback"
// structural proof is replaced by the shared host's captured-call log —
// inspect.view is a Convex query that cannot reach the model-call action.
import { describe, expect, test } from "vitest";
import {
  estimateTokens,
  type Lhc,
  type LlmRequestContext,
  type MessageEventInput,
  type StoredView,
  type ViewContentsReport,
} from "../src/client/index.js";
import { capturedCalls, resetCapturedCalls } from "./convex/model.js";
import { derivedThreadFixture, type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

function resultValue<T>(result: { ok: boolean }): T {
  if (!result.ok) throw new Error(`expected ok result: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function servedText(message: { content: string | readonly { text: string }[] }): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("");
}

function isBandMessage(message: { content: string | readonly { text: string }[] }): boolean {
  return servedText(message).startsWith("[context ·");
}

function measured(messages: ReadonlyArray<{ content: string | readonly { text: string }[] }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(servedText(message)), 0);
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
}

// Independent stored-row read (anti-shim: the report and describe are compared
// against the raw threadViews / threadViewBands rows through this separate
// path, not against each other alone).
async function readRawStoredView(fixture: ServiceFixture, thread: string): Promise<StoredView | null> {
  return await fixture.test.run(async (ctx) => {
    const views = await ctx.db.query("threadViews").collect();
    const header = views.find((row) => row.instance === fixture.instance && row.thread === thread);
    if (header === undefined) return null;
    const bandRows = await ctx.db.query("threadViewBands").collect();
    const byBand = new Map(
      bandRows
        .filter((row) => row.instance === fixture.instance && row.thread === thread && row.view === header.view)
        .map((row) => [row.band, row]),
    );
    return {
      viewId: header.view,
      createdAt: header.createdAt,
      compactPoint: header.compactPoint,
      coveredFrom: header.coveredFrom,
      profileName: header.profileName ?? null,
      config: header.config as StoredView["config"],
      arrangement: header.arrangement as StoredView["arrangement"],
      gaps: header.gaps as StoredView["gaps"],
      sourceState: header.sourceState as StoredView["sourceState"],
      bands: (["brief", "detailed", "smooth"] as const).flatMap((band) => {
        const row = byBand.get(band);
        return row === undefined ? [] : [{ band, storedTokens: row.tokenCount }];
      }),
    } as StoredView;
  });
}

// The report's band sections regrouped from the raw row, independently of the
// report handler: arrangement entries per band in served order, stored band
// token counts verbatim.
function bandsFromRaw(raw: StoredView): ViewContentsReport["bands"] {
  return (["brief", "detailed", "smooth"] as const).flatMap((band) => {
    const entries = raw.arrangement
      .filter((entry) => (entry as Record<string, unknown>)["band"] === band)
      .map((entry) => {
        const e = entry as Record<string, unknown>;
        return {
          subjectKind: e["subjectKind"],
          subjectId: e["subjectId"],
          derivationUsed: e["derivationUsed"],
          degraded: e["degraded"],
        };
      });
    const stored = raw.bands.find((row) => row.band === band);
    if (entries.length === 0 && stored === undefined) return [];
    return [{ band, entries, storedTokens: stored?.storedTokens ?? 0 }] as ViewContentsReport["bands"];
  });
}

interface CompactedFixture extends ServiceFixture {
  filePath: string;
  threadId: string;
}

// The tool-heavy fixture with one degraded entry and one gap reached through
// production paths — post-build prompt edits (not drained) clear t8's turn
// derivations (the smooth entry degrades down its ladder) and c2's chain (its
// detailed summary degrades to the stored-member concat). Params force the
// chunk bands so profileName stores null and config carries the resolved truth.
const DEGRADED_COMPACT_PARAMS = { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 } };

async function degradedCompactedThread(): Promise<CompactedFixture> {
  const fixture = await derivedThreadFixture();
  const { sdk, filePath, threadId } = fixture;
  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`fixture list failed: ${listed.error.reason}`);
  for (const turn of ["t4", "t5", "t6", "t8"]) {
    const target = listed.value.find((record) => record.kind === "user_prompt" && record.turnId === turn);
    if (target === undefined) throw new Error(`fixture invariant: no prompt in ${turn}`);
    const edited = await sdk.messages.edit(
      { filePath },
      { messageId: target.messageId, content: `${turn} revised: investigate the area again` },
    );
    if (!edited.ok) throw new Error(`fixture edit failed: ${edited.error.reason}`);
  }
  const compacted = await sdk.threadView.compact({ filePath }, { params: DEGRADED_COMPACT_PARAMS });
  if (!compacted.ok) throw new Error(`fixture compact failed: ${compacted.error.reason}`);
  return { ...fixture, filePath, threadId };
}

// A small never-compacted thread: two closed turns, fully drained.
async function neverCompactedThread(): Promise<CompactedFixture> {
  const fixture = serviceFixture();
  const { filePath, threadId } = await fixture.createThread();
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
    validEvent("assistant_text", { payload: { text: "reading it now" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-iv-1", toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-iv-1", content: "contents of notes.txt", isError: false },
    }),
    validEvent("turn_end"),
  ]);
  await send(fixture.sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
    validEvent("assistant_text", { payload: { text: "here is the summary" } }),
    validEvent("turn_end"),
  ]);
  const drained = await fixture.sdk.work.drain({ filePath });
  if (!drained.ok || drained.value.remaining !== 0) throw new Error("fixture drain left work behind");
  return { ...fixture, filePath, threadId };
}

describe("TC-2.1 / AC-2.1, AC-2.5: arrangement fidelity from the stored snapshot", () => {
  test("report entries, derivations, degraded flags, config, and provenance equal describe output and the stored row", async () => {
    const fixture = await degradedCompactedThread();
    const { filePath, sdk } = fixture;
    const raw = await readRawStoredView(fixture, fixture.threadId);
    expect(raw).not.toBeNull();
    if (raw === null) return;

    // describe leg: the stored row verbatim through the surface.
    const described = resultValue<StoredView | null>(await sdk.threadView.describe({ filePath }));
    expect(described).toEqual(raw);

    const report = resultValue<ViewContentsReport>(await sdk.inspect.view({ filePath }));
    // Meta: identity, profile (null — explicit params), resolved config, window
    // — the row's fields, never re-resolved.
    expect(report.meta).toEqual({
      viewId: raw.viewId,
      createdAt: raw.createdAt,
      profile: null,
      config: { lowerBound: DEGRADED_COMPACT_PARAMS.lowerBound, percentages: DEGRADED_COMPACT_PARAMS.percentages },
      compactPoint: raw.compactPoint,
      coveredFrom: raw.coveredFrom,
    });
    expect(report.meta?.config).toEqual(raw.config);

    // Every band entry in served order with derivation/degraded verbatim;
    // per-band stored token counts; every gap with its reason — all from the row.
    expect(report.bands).toEqual(bandsFromRaw(raw));
    expect(report.gaps).toEqual(raw.gaps);
    expect(report.sourceState).toEqual(raw.sourceState);

    // Fixture sanity: the degraded entries (t8's smooth fallback and c2's
    // compact stored-member concat) are both present and named.
    const entries = report.bands.flatMap((band) => band.entries);
    expect(entries.some((entry) => entry.subjectId === "t8" && entry.degraded)).toBe(true);
    expect(entries.some((entry) => entry.subjectId === "c2" && entry.degraded)).toBe(true);
    expect(report.gaps).toHaveLength(0);

    // Load-cost parity on the compacted shape (bands + tail): an independent
    // context read re-measured with the same estimator.
    const contextRead = resultValue<LlmRequestContext>(await sdk.threadView.getLlmRequestContext({ filePath }));
    expect(report.loadCost.total).toBe(measured(contextRead.messages));
    expect(report.loadCost.bandTokens).toBe(measured(contextRead.messages.filter(isBandMessage)));
    expect(report.loadCost.total).toBe(report.loadCost.bandTokens + report.loadCost.tailTokens);
    expect(report.tail.messageCount).toBe(contextRead.messages.filter((message) => !isBandMessage(message)).length);
  });

  test("describe returns ok/null on a never-compacted thread and thread_not_found on a missing one", async () => {
    const fixture = await neverCompactedThread();
    const described = await fixture.sdk.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (described.ok) expect(described.value).toBeNull();
    expect(await readRawStoredView(fixture, fixture.threadId)).toBeNull();

    const missing = await fixture.sdk.threadView.describe({ filePath: "iv-missing" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.errorClass).toBe("caller_error");
      expect(missing.error.code).toBe("thread_not_found");
    }
  });
});

describe("TC-2.3 / AC-2.4: never-compacted thread reports tail-only under the same parity contract", () => {
  test("meta null, bands empty, tail spans the record, cost parity holds", async () => {
    const fixture = await neverCompactedThread();
    const { filePath, sdk } = fixture;
    const report = resultValue<ViewContentsReport>(await sdk.inspect.view({ filePath }));
    expect(report.meta).toBeNull();
    expect(report.bands).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.sourceState).toBeNull();
    expect(report.loadCost.bandTokens).toBe(0);

    const contextRead = resultValue<LlmRequestContext>(await sdk.threadView.getLlmRequestContext({ filePath }));
    // The whole record serves as tail: every contextRead message is band-absent
    // and the report counts all six visible messages.
    expect(contextRead.messages.every((message) => !isBandMessage(message))).toBe(true);
    expect(report.tail.messageCount).toBe(contextRead.messages.length);
    expect(report.tail.messageCount).toBe(6);
    expect(report.tail.tokens).toBe(measured(contextRead.messages));
    expect(report.loadCost.tailTokens).toBe(report.tail.tokens);
    expect(report.loadCost.total).toBe(measured(contextRead.messages));
  });
});

function tokenFill(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

describe("TC-2.2 / AC-2.2, AC-2.3: loadCost parity with a seeded boundary in the tail", () => {
  test("tail costs short forms short and total equals an independent context read re-measured", async () => {
    const fixture = serviceFixture({ view: { visibility: { maxTokens: 100, targetTokens: 60 } } });
    const { filePath, threadId } = await fixture.createThread();

    // Six plain turns, drained, then a compact small enough to leave bands and
    // a real compact point.
    for (let turn = 1; turn <= 6; turn += 1) {
      await send(fixture.sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
        validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }),
        validEvent("turn_end"),
      ]);
      const drained = await fixture.sdk.work.drain({ filePath });
      if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);
    }
    const compacted = await fixture.sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 60, percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 } } },
    );
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;

    // Two post-compact tool turns (150-token results, over the abbreviation
    // floor). Seed the boundary behind the older turn; the newer closed turn
    // stays full.
    for (const run of [1, 2]) {
      await send(fixture.sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `post-compact tool run ${run}` } }),
        validEvent("tool_call", {
          payload: { toolCallId: `call-adv-${run}`, toolName: "read_file", arguments: { path: `adv-${run}.txt` } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-adv-${run}`, content: tokenFill(150), isError: false },
        }),
        validEvent("turn_end"),
      ]);
    }
    const listed = await fixture.sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const tailResults = listed.value
      .filter((message) => message.kind === "tool_result" && message.sourceEventOrder > compacted.value.compactPoint)
      .sort((left, right) => left.sourceEventOrder - right.sourceEventOrder);
    expect(tailResults).toHaveLength(2);
    await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("viewBoundaries").collect();
      const row = rows.find((candidate) => candidate.instance === fixture.instance && candidate.thread === threadId);
      if (row === undefined) throw new Error("view boundary missing");
      await ctx.db.patch("viewBoundaries", row._id, { position: tailResults[0]!.sourceEventOrder });
    });

    const contextRead = resultValue<LlmRequestContext>(await fixture.sdk.threadView.getLlmRequestContext({ filePath }));
    const boundaryPosition = await fixture.test.run(async (ctx) => {
      const rows = await ctx.db.query("viewBoundaries").collect();
      return rows.find((candidate) => candidate.instance === fixture.instance && candidate.thread === threadId)!
        .position;
    });
    expect(boundaryPosition).toBeGreaterThan(compacted.value.compactPoint);
    const tailServed = contextRead.messages.filter((message) => !isBandMessage(message));
    const abridged = tailServed.filter((message) => servedText(message).includes(" · abridged]"));
    const fullResults = tailServed.filter(
      (message) => servedText(message).startsWith("[tool result · ") && !servedText(message).includes(" · abridged]"),
    );
    expect(abridged.length).toBe(1);
    expect(fullResults.length).toBe(1);
    // Short forms cost short: the abridged result is cheaper as served than its
    // full sibling of identical record size.
    expect(estimateTokens(abridged[0] === undefined ? "" : servedText(abridged[0]))).toBeLessThan(
      estimateTokens(fullResults[0] === undefined ? "" : servedText(fullResults[0])),
    );

    const report = resultValue<ViewContentsReport>(await fixture.sdk.inspect.view({ filePath }));
    // Tail as served: count and tokens measured over the served tail —
    // boundary-aware shortening inherited from the serving assembly.
    expect(report.tail.messageCount).toBe(tailServed.length);
    expect(report.tail.tokens).toBe(measured(tailServed));
    expect(report.loadCost.tailTokens).toBe(report.tail.tokens);
    // The governing contract: total equals an independent context read's
    // measured content under the same estimator.
    expect(report.loadCost.total).toBe(measured(contextRead.messages));
    expect(report.loadCost.total).toBe(report.loadCost.bandTokens + report.loadCost.tailTokens);
  });
});

describe("AC-1.4 contract: view and describe are pure reads", () => {
  test("repeated calls are deep-equal and call no model", async () => {
    const fixture = await degradedCompactedThread();
    const { filePath, sdk } = fixture;
    resetCapturedCalls();

    const rawBefore = await readRawStoredView(fixture, fixture.threadId);
    const first = await sdk.inspect.view({ filePath });
    const second = await sdk.inspect.view({ filePath });
    const describedOnce = await sdk.threadView.describe({ filePath });
    expect(first.ok && second.ok && describedOnce.ok).toBe(true);
    expect(second).toEqual(first);
    // No delta: the stored row is byte-identical after the reads.
    expect(await readRawStoredView(fixture, fixture.threadId)).toEqual(rawBefore);
    expect(capturedCalls).toHaveLength(0);
  });

  test("inspect.view on a missing thread is thread_not_found, not a shape error", async () => {
    const fixture = serviceFixture();
    const missing = await fixture.sdk.inspect.view({ filePath: "iv-missing" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("thread_not_found");
  });
});
