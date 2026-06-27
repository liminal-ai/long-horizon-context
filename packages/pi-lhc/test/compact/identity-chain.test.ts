import { intakeStream, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEventKeySource } from "../../src/capture/idempotency.js";
import { mapFirstKeptToEntryId } from "../../src/compact/result-mapping.js";
import { startCapture } from "../capture/support.js";
import { makeAgentEnd, makeAssistantMessage, makeMessageEnd, makeUserMessage } from "../fixtures/synthetic.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";

const COMPACT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

function threadIdOf(ref: ThreadRef): string {
  return "threadId" in ref ? ref.threadId : ref.filePath;
}

function appendPiMessage(ctx: { sessionManager: { getEntries(): unknown[] } }, id: string, message: unknown): void {
  ctx.sessionManager.getEntries().push({ type: "message", id, parentId: null, message });
}

describe("live identity chain through real capture", () => {
  let store: TempStore;

  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  it("maps captured PI entry id through LHC compact firstKeptMessageId via live tier", async () => {
    const started = await startCapture(store);
    const { connector, ctx, threadRef } = started;
    const piSessionId = threadIdOf(threadRef);
    const capturedEntryIds: string[] = [];

    for (let turn = 1; turn <= 12; turn += 1) {
      const userEntryId = `entry-turn-${turn}-user`;
      const assistantEntryId = `entry-turn-${turn}-assistant`;
      const user = makeUserMessage(`turn ${turn}: please investigate area ${turn}`);
      const assistant = makeAssistantMessage({ text: `findings for area ${turn}` });

      await connector.handlers.message_end(makeMessageEnd(user), ctx);
      appendPiMessage(ctx, userEntryId, user);
      capturedEntryIds.push(userEntryId);

      await connector.handlers.message_end(makeMessageEnd(assistant), ctx);
      appendPiMessage(ctx, assistantEntryId, assistant);
      capturedEntryIds.push(assistantEntryId);

      await connector.handlers.agent_end(makeAgentEnd([]), ctx);
    }

    const instance = connector.getInstance();
    expect(instance).not.toBeNull();
    if (instance === null) return;

    const drained = await instance.sdk.work.drain(threadRef);
    expect(drained.ok).toBe(true);

    const preview = await instance.sdk.threadView.previewCompact(threadRef, { params: COMPACT_PARAMS });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.kind).toBe("ok");
    if (preview.value.kind !== "ok") return;
    expect(preview.value.preview.wouldProduceBands).toBe(true);
    expect(preview.value.preview.firstKeptMessageId).not.toBeNull();

    const compact = await instance.sdk.threadView.compact(threadRef, { params: COMPACT_PARAMS });
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.value.compactPoint).toBeGreaterThan(0);
    expect(compact.value.firstKeptMessageId).toBe(preview.value.preview.firstKeptMessageId);

    const sessionView = await instance.sdk.threadView.getSessionThreadView(threadRef);
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    const firstKeptMessageId = compact.value.firstKeptMessageId;
    expect(firstKeptMessageId).not.toBeNull();
    if (firstKeptMessageId === null) return;

    const branchEntries = ctx.sessionManager.getEntries();
    const mapping = mapFirstKeptToEntryId(firstKeptMessageId, sessionView.value, null, branchEntries, piSessionId);
    expect("mappingFailed" in mapping).toBe(false);
    if ("mappingFailed" in mapping) return;

    expect(mapping.origin).toBe("live");
    expect(capturedEntryIds).toContain(mapping.firstKeptEntryId);

    const source = sessionView.value.entries
      .flatMap((entry) => ("sourceMessages" in entry ? entry.sourceMessages : []))
      .find((row) => row.messageId === firstKeptMessageId);
    expect(source).toBeDefined();
    expect(source?.idempotencyKey).not.toBeNull();

    const parsed = parseEventKeySource(source!.idempotencyKey!);
    expect(parsed?.entryId).toBe(mapping.firstKeptEntryId);

    const events = await intakeStream.listEvents(threadRef);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const keyed = events.value.find((event) => event.idempotencyKey === source?.idempotencyKey);
    expect(keyed).toBeDefined();
    expect(parseEventKeySource(keyed!.idempotencyKey)?.entryId).toBe(mapping.firstKeptEntryId);
  });
});
