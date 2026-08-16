import { createDeterministicInferenceCallbacks, initLhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSessionBeforeCompact } from "../../src/index.js";
import { createSessionState } from "../../src/lifecycle/state.js";
import { syntheticCtx } from "../capture/support.js";
import { validEvent } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { makeBeforeCompactEvent, makeBranchEntries, makeSeedEntryMap } from "./fixtures.js";

const EVICTING_PARAMS = {
  lowerBound: 120,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

describe("pi-lhc empty-tail splice after selector eviction", () => {
  let store: TempStore;

  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  async function newThread() {
    const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    return { sdk, filePath };
  }

  it("true empty mappable tail is summary-only; a continuation marker stays mappable", async () => {
    const empty = await newThread();
    const emptyCapture = await empty.sdk.intakeStream.messageEvents({ filePath: empty.filePath }, [
      validEvent("user_prompt", { payload: { text: "small first turn" } }),
      validEvent("assistant_text", { payload: { text: "done" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "large final turn" } }),
      validEvent("assistant_text", { payload: { text: "oversized ".repeat(1_000) } }),
      validEvent("turn_end"),
    ]);
    if (!emptyCapture.ok) throw new Error(emptyCapture.error.reason);

    const emptyPreview = await empty.sdk.threadView.previewCompact(
      { filePath: empty.filePath },
      { params: EVICTING_PARAMS },
    );
    expect(emptyPreview.ok).toBe(true);
    if (!emptyPreview.ok || emptyPreview.value.kind !== "ok") return;
    expect(emptyPreview.value.preview.compactPoint).toBe(6);
    expect(emptyPreview.value.preview.firstKeptMessageId).toBeNull();

    const emptyResult = await handleSessionBeforeCompact(
      makeBeforeCompactEvent({ reason: "threshold" }),
      syntheticCtx(),
      {
        state: createSessionState({ filePath: empty.filePath }),
        instance: { sdk: empty.sdk } as never,
        piSessionId: "th_empty",
        flushPendingCapture: async () => {},
        getSessionView: async () => {
          throw new Error("summary-only splice must not consult session-view mapping");
        },
        findSeedEntryMap: () => null,
        compactParams: EVICTING_PARAMS,
      },
    );
    expect(emptyResult.cancel).toBeUndefined();
    expect(emptyResult.compaction?.firstKeptEntryId).toBe("pi-lhc:summary-only");
    expect(emptyResult.compaction?.summary).toContain("[context ·");

    const marked = await newThread();
    const markedCapture = await marked.sdk.intakeStream.messageEvents({ filePath: marked.filePath }, [
      validEvent("user_prompt", { payload: { text: "small first turn" } }),
      validEvent("assistant_text", { payload: { text: "done" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "large final turn" } }),
      validEvent("assistant_text", { payload: { text: "oversized ".repeat(1_000) } }),
      validEvent("turn_end"),
      validEvent("compact_continuation_marker"),
    ]);
    if (!markedCapture.ok) throw new Error(markedCapture.error.reason);

    const markedPreview = await marked.sdk.threadView.previewCompact(
      { filePath: marked.filePath },
      { params: EVICTING_PARAMS },
    );
    expect(markedPreview.ok).toBe(true);
    if (!markedPreview.ok || markedPreview.value.kind !== "ok") return;
    expect(markedPreview.value.preview.compactPoint).toBe(6);
    expect(markedPreview.value.preview.firstKeptMessageId).not.toBeNull();
    const markerId = markedPreview.value.preview.firstKeptMessageId;
    if (markerId === null) return;

    const sessionView = await marked.sdk.threadView.getSessionThreadView({ filePath: marked.filePath });
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    const markedResult = await handleSessionBeforeCompact(
      makeBeforeCompactEvent({ reason: "threshold", branchEntries: makeBranchEntries(4) }),
      syntheticCtx(),
      {
        state: createSessionState({ filePath: marked.filePath }),
        instance: { sdk: marked.sdk } as never,
        piSessionId: "th_marked",
        flushPendingCapture: async () => {},
        getSessionView: async () => sessionView,
        findSeedEntryMap: () => makeSeedEntryMap([{ lhcMessageId: markerId, piEntryId: "entry_3" }]),
        compactParams: EVICTING_PARAMS,
      },
    );
    expect(markedResult.cancel).toBeUndefined();
    expect(markedResult.compaction?.firstKeptEntryId).toBe("entry_3");
  });
});
