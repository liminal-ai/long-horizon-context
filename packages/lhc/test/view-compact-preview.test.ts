// Story 0 / TC-5.1c: previewCompact shares computeArrangement with compact;
// compactPoint agrees exactly; preview is read-only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countLiveItems,
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type PreviewCompactResult,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  eventBatch,
  openRaw,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
let fixture: DerivedThreadFixture;

const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};

const ALL_FITS_PARAMS = {
  lowerBound: 1_000_000,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

const NEAR_NO_OP_PARAMS = {
  lowerBound: 50,
  percentages: { full: 10, smooth: 10, detailed: 10, brief: 70 },
};

function viewRowCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM thread_view`).get() as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function liveCount(filePath: string): number {
  const db = openRaw(filePath);
  try {
    return countLiveItems(db);
  } finally {
    db.close();
  }
}

async function previewAndCompact(
  target: Lhc,
  filePath: string,
  params: { lowerBound: number; percentages: Record<string, number> },
) {
  const preview = await target.threadView.previewCompact({ filePath }, { params });
  const compact = await target.threadView.compact({ filePath }, { params });
  return { preview, compact };
}

async function newManualSdk(store: TempStore): Promise<{ sdk: Lhc; filePath: string }> {
  const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return { sdk, filePath };
}

function expectOkPreview(preview: Awaited<ReturnType<Lhc["threadView"]["previewCompact"]>>): PreviewCompactResult {
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error.reason);
  expect(preview.value.kind).toBe("ok");
  if (preview.value.kind !== "ok") throw new Error("expected ok preview");
  return preview.value.preview;
}

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

describe("preview exactness golden cases (fixed expected compactPoint)", () => {
  it("all-fits: three closed turns under full budget → compactPoint 0", async () => {
    const { sdk, filePath } = await newManualSdk(store);
    for (let turn = 0; turn < 3; turn += 1) {
      const captured = await sdk.intakeStream.messageEvents(
        { filePath },
        eventBatch(["user_prompt", "assistant_text", "turn_end"]),
      );
      expect(captured.ok).toBe(true);
    }

    const { preview, compact } = await previewAndCompact(sdk, filePath, ALL_FITS_PARAMS);
    const previewResult = expectOkPreview(preview);
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;

    expect(previewResult.compactPoint).toBe(0);
    expect(previewResult.wouldProduceBands).toBe(false);
    expect(compact.value.compactPoint).toBe(0);
    expect(previewResult.compactPoint).toBe(compact.value.compactPoint);
  });

  it("over-budget derived fixture → compactPoint snaps to turn t8 close (event order 48)", async () => {
    const local = await derivedThreadFixture(store);
    const { preview, compact } = await previewAndCompact(local.sdk, local.filePath, TARGET_PARAMS);
    const previewResult = expectOkPreview(preview);
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;

    expect(previewResult.compactPoint).toBe(48);
    expect(previewResult.wouldProduceBands).toBe(true);
    expect(compact.value.compactPoint).toBe(48);
    expect(previewResult.compactPoint).toBe(compact.value.compactPoint);

    const db = openRaw(local.filePath);
    try {
      const turn = db.prepare(`SELECT closed_at_event_order FROM turns WHERE turn_id = 't8'`).get() as {
        closed_at_event_order: number | bigint;
      };
      expect(previewResult.compactPoint).toBe(Number(turn.closed_at_event_order));
    } finally {
      db.close();
    }
  });

  it("near-no-op: one small brief band → compactPoint 9 at turn t3 close, wouldProduceBands true", async () => {
    const { sdk, filePath } = await newManualSdk(store);
    const batch: MessageEventInput[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      batch.push(
        validEvent("user_prompt", { payload: { text: `brief turn ${turn}` } }),
        validEvent("assistant_text", { payload: { text: `ok ${turn}` } }),
        validEvent("turn_end"),
      );
    }
    const captured = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(captured.ok).toBe(true);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const { preview, compact } = await previewAndCompact(sdk, filePath, NEAR_NO_OP_PARAMS);
    const previewResult = expectOkPreview(preview);
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;

    expect(previewResult.compactPoint).toBe(9);
    expect(previewResult.wouldProduceBands).toBe(true);
    expect(previewResult.firstKeptMessageId).toBe("m10");
    expect(compact.value.compactPoint).toBe(9);
    expect(previewResult.compactPoint).toBe(compact.value.compactPoint);

    const db = openRaw(filePath);
    try {
      const turn = db.prepare(`SELECT closed_at_event_order FROM turns WHERE turn_id = 't3'`).get() as {
        closed_at_event_order: number | bigint;
      };
      expect(previewResult.compactPoint).toBe(Number(turn.closed_at_event_order));
    } finally {
      db.close();
    }
  });
});

describe("previewCompact agreement with compact", () => {
  it("TC-5.1c: preview compactPoint matches compact on the derived fixture", async () => {
    const { preview, compact } = await previewAndCompact(fixture.sdk, fixture.filePath, TARGET_PARAMS);
    expect(preview.ok).toBe(true);
    expect(compact.ok).toBe(true);
    if (!preview.ok || !compact.ok) return;
    expect(preview.value.kind).toBe("ok");
    if (preview.value.kind !== "ok") return;
    expect(preview.value.preview.compactPoint).toBe(compact.value.compactPoint);
    expect(preview.value.preview.wouldProduceBands).toBe(compact.value.compactPoint > 0);
    expect(preview.value.preview.firstKeptMessageId).toBe(compact.value.firstKeptMessageId);
  });

  it("TC-5.6b: permissive re-compact cannot move compact point backward; preview and compact stay coherent", async () => {
    const local = await derivedThreadFixture(store);
    const first = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: TARGET_PARAMS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.compactPoint).toBe(48);
    const viewBefore = viewRowCount(local.filePath);

    const preview = await local.sdk.threadView.previewCompact(
      { filePath: local.filePath },
      { params: ALL_FITS_PARAMS },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.kind).toBe("ok");
    if (preview.value.kind !== "ok") return;
    expect(preview.value.preview.compactPoint).toBe(0);
    expect(preview.value.preview.wouldProduceBands).toBe(false);

    const second = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: ALL_FITS_PARAMS });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("compact_unchanged");
    expect(viewRowCount(local.filePath)).toBe(viewBefore);

    const described = await local.sdk.threadView.describe({ filePath: local.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value?.compactPoint).toBe(48);
  });

  it("exactness golden: corpus sizes agree on compactPoint (no-op, banded, re-compact)", async () => {
    const cases = [
      {
        label: "no-op-small",
        params: { lowerBound: 500_000, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } },
      },
      { label: "banded-target", params: TARGET_PARAMS },
      { label: "banded-gradient", params: GRADIENT_PARAMS },
    ] as const;

    for (const scenario of cases) {
      const local = await derivedThreadFixture(store);
      const { preview, compact } = await previewAndCompact(local.sdk, local.filePath, scenario.params);
      expect(preview.ok, scenario.label).toBe(true);
      expect(compact.ok, scenario.label).toBe(true);
      if (!preview.ok || !compact.ok) continue;
      expect(preview.value.kind, scenario.label).toBe("ok");
      if (preview.value.kind !== "ok") continue;
      expect(preview.value.preview.compactPoint, scenario.label).toBe(compact.value.compactPoint);
      expect(preview.value.preview.wouldProduceBands, scenario.label).toBe(
        compact.ok && compact.value.compactPoint > 0,
      );

      const second = await previewAndCompact(local.sdk, local.filePath, scenario.params);
      expect(second.preview.ok).toBe(true);
      if (!second.preview.ok) continue;
      expect(second.preview.value.kind).toBe("ok");
      if (second.preview.value.kind !== "ok") continue;
      if (second.compact.ok) {
        expect(second.preview.value.preview.compactPoint).toBeGreaterThanOrEqual(compact.value.compactPoint);
      } else {
        expect(second.compact.error.code).toBe("compact_unchanged");
        expect(second.preview.value.preview.wouldProduceBands).toBe(false);
      }
    }
  });

  it("near-no-op with one small brief entry still reports wouldProduceBands true", async () => {
    const { sdk, filePath } = await newManualSdk(store);
    const batch: MessageEventInput[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      batch.push(
        validEvent("user_prompt", { payload: { text: `brief turn ${turn}` } }),
        validEvent("assistant_text", { payload: { text: `ok ${turn}` } }),
        validEvent("turn_end"),
      );
    }
    const captured = await sdk.intakeStream.messageEvents({ filePath }, batch);
    expect(captured.ok).toBe(true);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const preview = await sdk.threadView.previewCompact({ filePath }, { params: NEAR_NO_OP_PARAMS });
    const previewResult = expectOkPreview(preview);
    expect(previewResult.wouldProduceBands).toBe(true);
    expect(previewResult.compactPoint).toBe(9);
  });

  it("preview never writes a thread_view row", async () => {
    const local = await derivedThreadFixture(store);
    const before = viewRowCount(local.filePath);
    const preview = await local.sdk.threadView.previewCompact({ filePath: local.filePath }, { params: TARGET_PARAMS });
    expect(preview.ok).toBe(true);
    expect(viewRowCount(local.filePath)).toBe(before);
  });

  it("open turn with members returns turn_not_ready without writing", async () => {
    const path = store.threadPath();
    const localSdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await localSdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);

    const captured = await localSdk.intakeStream.messageEvents(
      { filePath: path },
      eventBatch(["user_prompt", "assistant_text"]),
    );
    expect(captured.ok).toBe(true);

    const before = viewRowCount(path);
    const preview = await localSdk.threadView.previewCompact({ filePath: path }, { params: TARGET_PARAMS });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value).toEqual({ kind: "turn_not_ready", openTurnHasMembers: true });
    expect(viewRowCount(path)).toBe(before);
  });

  it("empty open turn proceeds to ok preview", async () => {
    const path = store.threadPath();
    const localSdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await localSdk.threads.newThread({ filePath: path, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);

    const preview = await localSdk.threadView.previewCompact({ filePath: path }, { params: TARGET_PARAMS });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.kind).toBe("ok");
    if (preview.value.kind !== "ok") return;
    expect(preview.value.preview.compactPoint).toBe(0);
    expect(preview.value.preview.wouldProduceBands).toBe(false);
  });

  it("compact receipt carries renderedBands and firstKeptMessageId", async () => {
    const local = await derivedThreadFixture(store);
    const compact = await local.sdk.threadView.compact({ filePath: local.filePath }, { params: GRADIENT_PARAMS });
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.value.renderedBands.length).toBeGreaterThan(0);
    expect(compact.value.renderedBands[0]?.text.length).toBeGreaterThan(0);
    expect(compact.value.firstKeptMessageId).toMatch(/^m\d+$/);
    for (const band of compact.value.renderedBands) {
      const stored = compact.value.bands[band.band];
      expect(stored.entries).toBeGreaterThan(0);
      expect(band.text.length).toBeGreaterThan(0);
    }
  });

  it("background mode preview does not schedule drain with pending work", async () => {
    const sdk = initLhc({ mode: "background", inferenceCallbacks: createInferenceCallbacksDouble() });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    const threadId = created.value.threadId;

    const captured = await sdk.intakeStream.messageEvents({ filePath }, eventBatch(["user_prompt"]));
    expect(captured.ok).toBe(true);
    expect(liveCount(filePath)).toBeGreaterThan(0);

    const passesBefore = sdk.scheduler.testPassCount(threadId);
    const preview = await sdk.threadView.previewCompact({ filePath }, { params: ALL_FITS_PARAMS });
    expect(preview.ok).toBe(true);
    expect(sdk.scheduler.testPassCount(threadId)).toBe(passesBefore);
    expect(liveCount(filePath)).toBeGreaterThan(0);
  });
});
