// Turn parts — the mid-turn entry point and mechanism exclusivity (epic
// Flow 7, core side: AC-7.3 / TC-7.3a,b and AC-7.4 / TC-7.4a). Not a third
// algorithm state: midTurnCompact is the ordinary prepare → install compact
// behind two typed refusals. Exclusivity is per thread, both directions, and
// the forced-boundary runtime's compact-point clamp never meets a parts thread.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CompactContinuationHostFacts,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type ViewCompactParams,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  runCompactContinuationForTests,
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

const SETTLED_SEAM = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
};

function sdkFor(): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
}

async function newThread(sdk: Lhc): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return filePath;
}

async function send(sdk: Lhc, filePath: string, events: MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(result.error.reason);
}

function step(stepIndex: number, label: string): MessageEventInput[] {
  const body = `${label} `.repeat(6).trim();
  return [
    validEvent("assistant_text", { payload: { text: `step ${stepIndex}: ${body}`, stepIndex } }),
    validEvent("tool_call", {
      payload: { toolCallId: `c${stepIndex}-${label}`, toolName: "read", arguments: { step: stepIndex }, stepIndex },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: `c${stepIndex}-${label}`, content: `result ${stepIndex}: ${body}`, stepIndex },
    }),
  ];
}

// A thread under mid-turn pressure: one closed turn, then an open stamped
// turn of three complete steps.
async function pressuredThread(sdk: Lhc): Promise<string> {
  const filePath = await newThread(sdk);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "t1 prompt" } }),
    validEvent("assistant_text", { payload: { text: "t1 answer" } }),
    validEvent("turn_end"),
  ]);
  await send(sdk, filePath, [
    validEvent("user_prompt", { payload: { text: "long task" } }),
    ...step(0, "alpha"),
    ...step(1, "bravo"),
    ...step(2, "charlie"),
  ]);
  return filePath;
}

function readActivation(filePath: string): string | null {
  const db = openRaw(filePath);
  try {
    return (
      db.prepare(`SELECT parts_activated_at FROM thread_metadata WHERE id = 1`).get() as {
        parts_activated_at: string | null;
      }
    ).parts_activated_at;
  } finally {
    db.close();
  }
}

function tokensAfterStep(filePath: string, turnId: string, stepIndex: number): number {
  const db = openRaw(filePath);
  try {
    const edge = (
      db
        .prepare(`SELECT MAX(source_event_order) AS e FROM message WHERE turn_id = ? AND step_index = ?`)
        .get(turnId, stepIndex) as { e: number }
    ).e;
    return Number(
      (
        db
          .prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE source_event_order > ?`)
          .get(edge) as { t: number }
      ).t,
    );
  } finally {
    db.close();
  }
}

const params = (lowerBound: number): ViewCompactParams => ({
  lowerBound,
  percentages: { full: 50, smooth: 20, detailed: 15, brief: 15 },
  newestClosedProtection: 0, // the split is the subject; Flow 5 has its own file
});

interface CanonicalSnapshot {
  events: number;
  turns: number;
  viewId: string | null;
  writerClaim: string;
  boundaries: number;
}

function canonical(filePath: string): CanonicalSnapshot {
  const db = openRaw(filePath);
  try {
    const n = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    const view = db.prepare(`SELECT view_id FROM thread_view WHERE singleton = 1`).get() as
      | { view_id: string }
      | undefined;
    const writer = db.prepare(`SELECT claim FROM compact_continuation_writer WHERE singleton = 1`).get() as {
      claim: string;
    };
    return {
      events: n(`SELECT COUNT(*) AS n FROM event`),
      turns: n(`SELECT COUNT(*) AS n FROM turns`),
      viewId: view?.view_id ?? null,
      writerClaim: writer.claim,
      boundaries: n(`SELECT COUNT(*) AS n FROM compact_continuation_boundary`),
    };
  } finally {
    db.close();
  }
}

function continuationFacts(attemptId: string): CompactContinuationHostFacts {
  return {
    attemptId,
    seam: { ...SETTLED_SEAM, insideTransportRetry: false, inputEpochAtDecision: 1, inputEpochAtApply: 1 },
    providerUsage: {
      available: true,
      inputTokens: 90000,
      cacheCreationTokens: 5000,
      cacheReadTokens: 10000,
      total: 105000,
      domain: "provider_reported_input",
    },
    postMeasurementEstimate: { tokens: 2000, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
    policy: {
      upperTriggerTokens: 100000,
      lowerTargetTokens: 400,
      hostCapability: "full_state_machine",
      safeRunwayThresholdTokens: 200000,
      safeRunwayThresholdSource: "host_safe_runway",
    },
    continuation: { kind: "active_non_tool" },
    writerClaim: "none",
    captureComplete: true,
    providerIdentityValid: true,
    actor: "fixture-actor",
    harness: "fixture-harness",
    compact: { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
  };
}

describe("midTurnCompact: seam assertion (AC-7.4 core side)", () => {
  it("refuses typed on an absent or false seam assertion and touches nothing; a settled seam runs the ordinary compact", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const before = canonical(filePath);
    const p = params(tokensAfterStep(filePath, "t2", 0) * 2);

    const inFlight = await sdk.threadView.midTurnCompact(
      { filePath },
      { seam: { ...SETTLED_SEAM, captureFlushed: false }, params: p },
    );
    expect(inFlight.ok).toBe(false);
    if (inFlight.ok) return;
    expect(inFlight.error).toMatchObject({ errorClass: "caller_error", code: "unsettled_capture_seam" });
    const absent = await sdk.threadView.midTurnCompact({ filePath }, { params: p } as never);
    expect(!absent.ok && absent.error.code).toBe("unsettled_capture_seam");
    expect(canonical(filePath)).toEqual(before);

    // Settled: the same receipt the ordinary compact API yields — parts and all.
    const preview = await sdk.threadView.previewCompact({ filePath }, { params: p });
    const served = await sdk.threadView.midTurnCompact({ filePath }, { seam: SETTLED_SEAM, params: p });
    expect(served.ok).toBe(true);
    if (!served.ok || !preview.ok || preview.value.kind !== "ok") return;
    expect(served.value.parts).toEqual([{ turnId: "t2", fromStep: 0, toStep: 0 }]);
    expect(served.value.compactPoint).toBe(preview.value.preview.compactPoint);
    expect(canonical(filePath)).toEqual({ ...before, viewId: served.value.viewId });
  });
});

describe("mechanism exclusivity per thread (AC-7.3)", () => {
  it("TC-7.3b: a forced-boundary attempt on a parts thread is refused typed with thread state unchanged", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const split = await sdk.threadView.midTurnCompact(
      { filePath },
      { seam: SETTLED_SEAM, params: params(tokensAfterStep(filePath, "t2", 0) * 2) },
    );
    expect(split.ok && split.value.parts?.length).toBe(1);
    const before = canonical(filePath);

    const forced = await runCompactContinuationForTests({ filePath }, continuationFacts("attempt-on-parts"));
    expect(forced.ok).toBe(false);
    if (forced.ok) return;
    expect(forced.error).toMatchObject({ errorClass: "caller_error", code: "compact_continuation_parts_thread" });
    expect(canonical(filePath)).toEqual(before);
    expect(before.writerClaim).toBe("none");
    expect(before.boundaries).toBe(0);
  });

  it("the exclusivity fact is durable: once the split turn has closed and settled — no part left in the installed view — a forced-boundary attempt is still refused", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    const split = await sdk.threadView.midTurnCompact(
      { filePath },
      { seam: SETTLED_SEAM, params: params(tokensAfterStep(filePath, "t2", 0) * 2) },
    );
    expect(split.ok && split.value.parts?.length).toBe(1);
    const activated = readActivation(filePath);
    expect(activated).not.toBeNull();

    // t2 closes and t3 opens. Once t3 fills the full share, t2 settles and
    // the new snapshot carries no part at all.
    await send(sdk, filePath, [validEvent("turn_end")]);
    await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "next" } }), ...step(0, "golf")]);
    const db = openRaw(filePath);
    try {
      db.prepare(`UPDATE message SET token_estimate = 25 WHERE turn_id = 't3'`).run();
    } finally {
      db.close();
    }
    const settled = await sdk.threadView.compact({ filePath }, { params: params(200) });
    expect(settled.ok && settled.value.settled?.turnId).toBe("t2");
    expect(settled.ok && settled.value.parts).toBeUndefined();
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok && described.value?.arrangement.every((e) => e.part === undefined)).toBe(true);
    const meta = await sdk.threadView.hostMetadata({ filePath });
    expect(meta.ok && meta.value.unsettledTurn).toBeNull();
    // Settle did not touch the durable fact.
    expect(readActivation(filePath)).toBe(activated);

    const before = canonical(filePath);
    const forced = await runCompactContinuationForTests({ filePath }, continuationFacts("attempt-after-settle"));
    expect(forced.ok).toBe(false);
    if (forced.ok) return;
    expect(forced.error).toMatchObject({ errorClass: "caller_error", code: "compact_continuation_parts_thread" });
    expect(canonical(filePath)).toEqual(before);
    expect(before.writerClaim).toBe("none");
    expect(before.boundaries).toBe(0);
  });

  it("a forced-boundary thread is never served parts: mid-turn compact refuses typed, and the ordinary compact walks without a parts source", async () => {
    const sdk = sdkFor();
    const filePath = await pressuredThread(sdk);
    // Take the forced-boundary path first (real runtime, real boundary row).
    const forced = await runCompactContinuationForTests({ filePath }, continuationFacts("attempt-forced"));
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.value.receipt.continuation.opened).toBe(true);
    expect(canonical(filePath).boundaries).toBe(1);

    // New stamped pressure on the continuation turn (t3), tight budget.
    await send(sdk, filePath, [...step(0, "golf"), ...step(1, "hotel"), ...step(2, "india")]);
    const p = params(tokensAfterStep(filePath, "t3", 0) * 2);
    const before = canonical(filePath);
    const refused = await sdk.threadView.midTurnCompact({ filePath }, { seam: SETTLED_SEAM, params: p });
    expect(!refused.ok && refused.error).toMatchObject({ errorClass: "caller_error", code: "forced_boundary_thread" });
    expect(canonical(filePath)).toEqual(before);

    const ordinary = await sdk.threadView.compact({ filePath }, { params: p });
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) return;
    expect(ordinary.value.parts).toBeUndefined();
    expect(ordinary.value.splitPoint).toBeUndefined();
    const meta = await sdk.threadView.hostMetadata({ filePath });
    expect(meta.ok && meta.value.unsettledTurn).toBeNull();
  });

  it("the forced-boundary clamp never meets a parts thread: compactPointUpperBound on one trips the invariant, and on a clean thread it suppresses splitting", async () => {
    const sdk = sdkFor();
    const clean = await pressuredThread(sdk);
    const p = params(tokensAfterStep(clean, "t2", 0) * 2);
    const bounded = await sdk.threadView.prepareCompact({ filePath: clean }, { params: p, compactPointUpperBound: 2 });
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.value.selection.parts).toBeUndefined();
    expect(bounded.value.selection.compactPoint).toBeLessThanOrEqual(2);

    const parts = await pressuredThread(sdk);
    const split = await sdk.threadView.midTurnCompact({ filePath: parts }, { seam: SETTLED_SEAM, params: p });
    expect(split.ok && split.value.parts?.length).toBe(1);
    const clamped = await sdk.threadView.prepareCompact({ filePath: parts }, { params: p, compactPointUpperBound: 2 });
    expect(clamped.ok).toBe(false);
    if (clamped.ok) return;
    expect(clamped.error.reason).toContain("turn parts invariant violated");
  });
});
