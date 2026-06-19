// Story 3 (Epic 04), default suite: TC-2.1–2.3 — the view-contents report
// plus the describe legs. `threadView.describe` exposes the stored active
// view row verbatim (null when absent, never recomputed); `inspect.view`
// composes describe + a measured pull so loadCost equals what pull serves
// now (AC-2.3, parity by construction) — asserted here against an
// INDEPENDENT pull re-measured with the same estimator, on a compacted
// fixture, a boundary-advanced fixture (short forms costed short, AC-2.2),
// and a never-compacted thread (meta null, tail-only, AC-2.4). Reads are
// pure (AC-1.4 contract): read-only delta assert, zero model calls.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateTokens,
  type InferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type StoredView,
  type ViewContentsReport,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  expectReadOnly,
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
});

function resultValue<T>(result: { ok: boolean }): T {
  if (!result.ok) throw new Error(`expected ok result: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function measured(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

// Independent stored-row read (anti-shim: the report and describe are
// compared against the raw thread_view/thread_view_band rows through this
// separate path, not against each other alone).
function readRawStoredView(filePath: string): StoredView | null {
  const db = new DatabaseSync(filePath);
  try {
    const header = db
      .prepare(
        `SELECT view_id, created_at, compact_point, covered_from, profile_name,
                config_json, arrangement_json, gaps_json, source_state_json
         FROM thread_view WHERE singleton = 1`,
      )
      .get() as
      | {
          view_id: string;
          created_at: string;
          compact_point: number | bigint;
          covered_from: number | bigint;
          profile_name: string | null;
          config_json: string;
          arrangement_json: string;
          gaps_json: string;
          source_state_json: string;
        }
      | undefined;
    if (header === undefined) return null;
    const bandRows = db
      .prepare(`SELECT band, token_count FROM thread_view_band WHERE view_id = ?`)
      .all(header.view_id) as unknown as Array<{ band: string; token_count: number | bigint }>;
    const byBand = new Map(bandRows.map((row) => [row.band, row]));
    return {
      viewId: header.view_id,
      createdAt: header.created_at,
      compactPoint: Number(header.compact_point),
      coveredFrom: Number(header.covered_from),
      profileName: header.profile_name,
      config: JSON.parse(header.config_json) as StoredView["config"],
      arrangement: JSON.parse(header.arrangement_json) as StoredView["arrangement"],
      gaps: JSON.parse(header.gaps_json) as StoredView["gaps"],
      sourceState: JSON.parse(header.source_state_json) as StoredView["sourceState"],
      bands: (["brief", "detailed", "smooth"] as const).flatMap((band) => {
        const row = byBand.get(band);
        return row === undefined ? [] : [{ band, storedTokens: Number(row.token_count) }];
      }),
    };
  } finally {
    db.close();
  }
}

// The report's band sections regrouped from the raw row, independently of
// view-report.ts: arrangement entries per band in served order, stored band
// token counts verbatim.
function bandsFromRaw(raw: StoredView): ViewContentsReport["bands"] {
  return (["brief", "detailed", "smooth"] as const).flatMap((band) => {
    const entries = raw.arrangement
      .filter((entry) => entry.band === band)
      .map((entry) => ({
        subjectKind: entry.subjectKind,
        subjectId: entry.subjectId,
        derivationUsed: entry.derivationUsed,
        degraded: entry.degraded,
      }));
    const stored = raw.bands.find((row) => row.band === band);
    if (entries.length === 0 && stored === undefined) return [];
    return [{ band, entries, storedTokens: stored?.storedTokens ?? 0 }];
  });
}

// The TC-2.1 substrate: the tool-heavy fixture with one degraded entry and
// one gap reached through production paths — post-build edits (not drained)
// clear t8's turn forms (the smooth entry degrades down its ladder) and all
// of c2's chain (summaries pending, zero ready member projections: the gap
// rung). Same recipe Epic 03's degraded compact proved; params force the
// chunk bands so profileName stores null and config carries the resolved
// truth.
const DEGRADED_COMPACT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 },
};

async function degradedCompactedThread(): Promise<DerivedThreadFixture> {
  const fixture = await derivedThreadFixture(store, { failures: false });
  const { sdk, filePath } = fixture;
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
  return fixture;
}

// A small never-compacted thread: two closed turns, fully drained.
async function neverCompactedThread(): Promise<{ filePath: string; sdk: Lhc }> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  const batches: MessageEventInput[][] = [
    [
      validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
      validEvent("assistant_text", { payload: { text: "reading it now" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-iv-1", toolName: "read_file", arguments: { path: "notes.txt" } },
      }),
      validEvent("tool_result", {
        payload: { toolCallId: "call-iv-1", content: "contents of notes.txt", isError: false },
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
  if (!drained.ok || drained.value.remaining !== 0) {
    throw new Error("fixture drain left work behind");
  }
  return { filePath, sdk };
}

function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

describe("TC-2.1 / AC-2.1, AC-2.5: arrangement fidelity from the stored snapshot", () => {
  it("report entries, forms, degraded flags, gap reasons, config, and provenance equal describe output and the stored row", async () => {
    const { filePath, sdk } = await degradedCompactedThread();
    const raw = readRawStoredView(filePath);
    expect(raw).not.toBeNull();
    if (raw === null) return;

    // describe leg: the stored row verbatim through the surface.
    const described = resultValue<StoredView | null>(await sdk.threadView.describe({ filePath }));
    expect(described).toEqual(raw);

    const report = resultValue<ViewContentsReport>(await sdk.inspect.view({ filePath }));
    // Meta: identity, profile (null — explicit params), resolved config,
    // window — the row's fields, never re-resolved.
    expect(report.meta).toEqual({
      viewId: raw.viewId,
      createdAt: raw.createdAt,
      profile: null,
      config: {
        lowerBound: DEGRADED_COMPACT_PARAMS.lowerBound,
        percentages: DEGRADED_COMPACT_PARAMS.percentages,
      },
      compactPoint: raw.compactPoint,
      coveredFrom: raw.coveredFrom,
    });
    expect(report.meta?.config).toEqual(raw.config);

    // Every band entry in served order with form/degraded verbatim; per-band
    // stored token counts; every gap with its reason — all from the row.
    expect(report.bands).toEqual(bandsFromRaw(raw));
    expect(report.gaps).toEqual(raw.gaps);
    expect(report.sourceState).toEqual(raw.sourceState);

    // Fixture sanity: the degraded entries (t8's smooth fallback and c2's
    // compact stored-member concat) are both present and named.
    const entries = report.bands.flatMap((band) => band.entries);
    expect(entries.some((entry) => entry.subjectId === "t8" && entry.degraded)).toBe(true);
    expect(report.gaps).toHaveLength(0);
    expect(entries.some((entry) => entry.subjectId === "c2" && entry.degraded)).toBe(true);

    // Load-cost parity on the compacted shape too (bands + tail): an
    // independent pull re-measured with the same estimator.
    const pulled = resultValue<{ messages: Array<{ content: string; band?: string }> }>(
      await sdk.threadView.pull({ filePath }),
    );
    expect(report.loadCost.total).toBe(measured(pulled.messages));
    expect(report.loadCost.bandTokens).toBe(measured(pulled.messages.filter((message) => message.band !== undefined)));
    expect(report.loadCost.total).toBe(report.loadCost.bandTokens + report.loadCost.tailTokens);
    expect(report.tail.messageCount).toBe(pulled.messages.filter((message) => message.band === undefined).length);
  });

  it("describe returns ok/null on a never-compacted thread and thread_not_found on a missing one", async () => {
    const { filePath, sdk } = await neverCompactedThread();
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok).toBe(true);
    if (described.ok) expect(described.value).toBeNull();
    expect(readRawStoredView(filePath)).toBeNull();

    const missing = await sdk.threadView.describe({ filePath: store.threadPath("missing") });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.errorClass).toBe("caller_error");
      expect(missing.error.code).toBe("thread_not_found");
    }
  });
});

describe("TC-2.2 / AC-2.2, AC-2.3: loadCost parity on a boundary-advanced fixture", () => {
  it("tail costs short forms short and total equals an independent pull re-measured", async () => {
    // Small budgets so a real intake post-commit advance moves the boundary
    // into the tail (Epic 03 Story 4 mechanics — never a hand-set position).
    const sdk = initLhc({
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
      view: { visibility: { maxTokens: 100, targetTokens: 60 } },
    });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);

    // Six plain turns, drained, then a compact small enough to leave bands
    // and a real compact point.
    for (let turn = 1; turn <= 6; turn += 1) {
      const sent = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
        validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }),
        validEvent("turn_end"),
      ]);
      if (!sent.ok) throw new Error(`intake failed: ${sent.error.reason}`);
      const drained = await sdk.work.drain({ filePath });
      if (!drained.ok) throw new Error(`drain failed: ${drained.error.reason}`);
    }
    const compacted = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 60, percentages: { full: 25, smooth: 25, detailed: 10, brief: 40 } } },
    );
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;

    // Two post-compact tool turns (80-token results). The second turn's
    // close crosses max (zone 160 > 100): the advance flips the older turn
    // behind the boundary; the newest closed turn is never evicted and
    // stays full (Epic 05 turn-end semantics).
    for (const run of [1, 2]) {
      const sent = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `post-compact tool run ${run}` } }),
        validEvent("tool_call", {
          payload: { toolCallId: `call-adv-${run}`, toolName: "read_file", arguments: { path: `adv-${run}.txt` } },
        }),
        validEvent("tool_result", {
          payload: { toolCallId: `call-adv-${run}`, content: tokens(80), isError: false },
        }),
        validEvent("turn_end"),
      ]);
      if (!sent.ok) throw new Error(`intake failed: ${sent.error.reason}`);
    }

    const pulled = resultValue<{
      messages: Array<{ content: string; band?: string }>;
      meta: { boundaryPosition: number; compactPoint: number | null };
    }>(await sdk.threadView.pull({ filePath }));
    expect(pulled.meta.boundaryPosition).toBeGreaterThan(pulled.meta.compactPoint ?? 0);
    const tailServed = pulled.messages.filter((message) => message.band === undefined);
    const abridged = tailServed.filter((message) => message.content.includes(" · abridged]"));
    const fullResults = tailServed.filter(
      (message) => message.content.startsWith("[tool result · ") && !message.content.includes(" · abridged]"),
    );
    expect(abridged.length).toBe(1);
    expect(fullResults.length).toBe(1);
    // Short forms cost short: the abridged result is cheaper as served than
    // its full sibling of identical record size.
    expect(estimateTokens(abridged[0]?.content ?? "")).toBeLessThan(estimateTokens(fullResults[0]?.content ?? ""));

    const report = resultValue<ViewContentsReport>(await sdk.inspect.view({ filePath }));
    // Tail as served: count and tokens measured over the served tail —
    // boundary-aware shortening inherited from pull, never re-implemented.
    expect(report.tail.messageCount).toBe(tailServed.length);
    expect(report.tail.tokens).toBe(measured(tailServed));
    expect(report.loadCost.tailTokens).toBe(report.tail.tokens);
    // The governing contract: total equals an independent pull's measured
    // content under the same estimator.
    expect(report.loadCost.total).toBe(measured(pulled.messages));
    expect(report.loadCost.total).toBe(report.loadCost.bandTokens + report.loadCost.tailTokens);
  });
});

describe("TC-2.3 / AC-2.4: never-compacted thread reports tail-only under the same parity contract", () => {
  it("meta null, bands empty, tail spans the record, cost parity holds", async () => {
    const { filePath, sdk } = await neverCompactedThread();
    const report = resultValue<ViewContentsReport>(await sdk.inspect.view({ filePath }));
    expect(report.meta).toBeNull();
    expect(report.bands).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.sourceState).toBeNull();
    expect(report.loadCost.bandTokens).toBe(0);

    const pulled = resultValue<{ messages: Array<{ content: string; band?: string }> }>(
      await sdk.threadView.pull({ filePath }),
    );
    // The whole record serves as tail: every pulled message is band-absent
    // and the report counts all six visible messages.
    expect(pulled.messages.every((message) => message.band === undefined)).toBe(true);
    expect(report.tail.messageCount).toBe(pulled.messages.length);
    expect(report.tail.messageCount).toBe(6);
    expect(report.tail.tokens).toBe(measured(pulled.messages));
    expect(report.loadCost.tailTokens).toBe(report.tail.tokens);
    expect(report.loadCost.total).toBe(measured(pulled.messages));
  });
});

describe("AC-1.4 contract: view and describe are pure reads", () => {
  it("repeated calls are deep-equal, leave no delta, and call no model — including under a throwing inference callback", async () => {
    const fixture = await degradedCompactedThread();
    const { filePath, sdk, double } = fixture;
    const captured = double.captureInputs();

    const first = await expectReadOnly(filePath, () => sdk.inspect.view({ filePath }));
    const second = await expectReadOnly(filePath, () => sdk.inspect.view({ filePath }));
    const describedOnce = await expectReadOnly(filePath, () => sdk.threadView.describe({ filePath }));
    expect(first.ok && second.ok && describedOnce.ok).toBe(true);
    expect(second).toEqual(first);
    expect(captured).toHaveLength(0);

    // Inference callbacks that throw on contact: both reads stay inference-callback-free
    // structurally (the zero-model assert extended to Story 3's ops).
    const refuse = (): never => {
      throw new Error("inference callbacks must never be called by a read operation");
    };
    const throwing: InferenceCallbacks = {
      smoothPrompt: refuse,
      summarizeToolResult: refuse,
      composeTurnRendering: refuse,
      compressSmoothTurn: refuse,
      summarizeChunkDetailed: refuse,
      summarizeChunkBrief: refuse,
    };
    const reader = initLhc({ inferenceCallbacks: throwing, mode: "manual" });
    const viewed = await expectReadOnly(filePath, () => reader.inspect.view({ filePath }));
    const described = await expectReadOnly(filePath, () => reader.threadView.describe({ filePath }));
    expect(viewed.ok && described.ok).toBe(true);
  });

  it("inspect.view on a missing thread is thread_not_found, not a shape error", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const missing = await sdk.inspect.view({ filePath: store.threadPath("missing") });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.errorClass).toBe("caller_error");
    expect(missing.error.code).toBe("thread_not_found");
  });
});
