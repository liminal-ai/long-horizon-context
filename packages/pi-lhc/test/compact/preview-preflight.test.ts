import type { Lhc } from "lhc";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleSessionBeforeCompact } from "../../src/index.js";
import { createSessionState } from "../../src/lifecycle/state.js";
import { syntheticCtx } from "../capture/support.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { makeBeforeCompactEvent } from "./fixtures.js";
import { buildAllFitsThread, buildCompactLhcFixture } from "./lhc-thread-fixture.js";

const ALL_FITS_PARAMS = {
  lowerBound: 1_000_000,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

function hasViewSnapshot(sdk: Lhc, filePath: string): Promise<boolean> {
  return sdk.threadView.describe({ filePath }).then((result) => result.ok && result.value !== null);
}

let store: TempStore;
let fixture: Awaited<ReturnType<typeof buildCompactLhcFixture>>;

beforeAll(async () => {
  store = tempStore();
  fixture = await buildCompactLhcFixture(store);
});
afterAll(() => {
  store.cleanup();
});

describe("preview preflight with real thread state", () => {
  it("no-op preflight leaves thread_view unchanged", async () => {
    const localStore = tempStore();
    try {
      const allFits = await buildAllFitsThread(localStore);
      const before = await hasViewSnapshot(allFits.sdk, allFits.filePath);
      const preview = await allFits.sdk.threadView.previewCompact(
        { filePath: allFits.filePath },
        { params: ALL_FITS_PARAMS },
      );
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.kind).toBe("ok");
      if (preview.value.kind !== "ok") return;
      expect(preview.value.preview.wouldProduceBands).toBe(false);

      const after = await hasViewSnapshot(allFits.sdk, allFits.filePath);
      expect(after).toBe(before);
    } finally {
      localStore.cleanup();
    }
  });

  it("map-before-compact: mapping failure leaves thread_view unchanged", async () => {
    const before = await hasViewSnapshot(fixture.sdk, fixture.filePath);
    const preview = await fixture.sdk.threadView.previewCompact(
      { filePath: fixture.filePath },
      { params: TARGET_PARAMS },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.value.kind !== "ok") return;
    expect(preview.value.preview.wouldProduceBands).toBe(true);

    const compactSpy = vi.spyOn(fixture.sdk.threadView, "compact");
    const sessionView = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    const result = await handleSessionBeforeCompact(makeBeforeCompactEvent({ branchEntries: [] }), syntheticCtx(), {
      state: createSessionState({ filePath: fixture.filePath }),
      instance: { sdk: fixture.sdk } as never,
      piSessionId: "wrong_session",
      flushPendingCapture: async () => {},
      getSessionView: async () => sessionView,
      findSeedEntryMap: () => null,
    });

    expect(result).toEqual({ cancel: true });
    expect(compactSpy).not.toHaveBeenCalled();
    const after = await hasViewSnapshot(fixture.sdk, fixture.filePath);
    expect(after).toBe(before);
    compactSpy.mockRestore();
  });
});
