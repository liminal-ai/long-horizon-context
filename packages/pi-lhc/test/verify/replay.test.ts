// Story 3 — capture verification (Flow 6). Capture correctness is proven
// WITHOUT serving anything to a model: each recorded corpus replays through the
// REAL converter + intake path into a temp SQLite thread, and the durable
// read-back is compared to the fixture. These tests assert on recorded thread
// state through `replayCorpus` and the live inspect surfaces — never on a
// mocked intake, and never by writing the fixture's expected events directly
// (story §Anti-Shim Requirements).

import {
  createDeterministicInferenceCallbacks,
  type EventRecord,
  initLhc,
  inspect,
  intakeStream,
  type MessageEventInput,
  type ThreadRef,
  turns,
} from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import type { LhcInstance } from "../../src/shared/instance.js";
import { replayCorpus } from "../../src/verify/replay.js";
import { CORPUS_LOADERS, type CorpusName, loadChattyCorpus, loadToolHeavyCorpus } from "../fixtures/corpus.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const CORPUS_NAMES = Object.keys(CORPUS_LOADERS) as CorpusName[];

/** The logical read-back: server-stamped `eventOrder`/`recordedAt` dropped, the
 *  converter's real (deterministic) idempotency key kept — so two replays are
 *  comparable for ID + order stability (AC-6.2). */
function logicalEvents(records: readonly EventRecord[]): MessageEventInput[] {
  return records.map(
    (record) =>
      ({
        eventKind: record.eventKind,
        idempotencyKey: record.idempotencyKey,
        actor: record.actor,
        harness: record.harness,
        payload: record.payload,
      }) as MessageEventInput,
  );
}

async function readBack(threadRef: ThreadRef): Promise<MessageEventInput[]> {
  const read = await intakeStream.listEvents(threadRef);
  if (!read.ok) throw new Error(`listEvents failed: ${read.error.reason}`);
  return logicalEvents(read.value);
}

/** A real background instance for inducing a Story-2 capture failure (the gap
 *  path does not call the provider, so the deterministic one is fine). */
function liveInstance(threadRef: ThreadRef): LhcInstance {
  const sdk = initLhc({ inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" });
  return {
    sdk,
    threadRef,
    dispose: async () => {
      await sdk.drainSettled(threadRef);
      return { ok: true, value: undefined };
    },
  };
}

// ── TC-6.1: each corpus replays to a read-back matching the fixture ──────────
describe.each(CORPUS_NAMES)("Story 3: corpus replay read-back (TC-6.1) — %s", (name) => {
  it("replays through the real converter to a thread whose events/messages/turns match the fixture", async () => {
    const corpus = CORPUS_LOADERS[name]();
    const thread = await makeTempThread(store);

    const result = await replayCorpus(corpus, thread.threadRef);

    // toEqual surfaces the structured diff on the actual object when it fails.
    expect(result).toEqual({ matches: true });

    // The recorded events are the corpus's expected kinds, in order — proven
    // against the durable thread, not the in-memory return value.
    const recorded = await readBack(thread.threadRef);
    expect(recorded.map((event) => event.eventKind)).toEqual(corpus.expected.map((event) => event.eventKind));
  });
});

// ── TC-6.2: deterministic re-replay (IDs and order stable) ───────────────────
describe("Story 3: deterministic re-replay (TC-6.2)", () => {
  it("replays the same corpus into two fresh threads to byte-identical read-back — real, stable idempotency keys", async () => {
    // tool-heavy carries tool_call/tool_result correlation ids, so this also
    // pins ID stability through the correlation path, not just text events.
    const corpus = loadToolHeavyCorpus();
    const threadA = await makeTempThread(store);
    const threadB = await makeTempThread(store);

    expect(await replayCorpus(corpus, threadA.threadRef)).toEqual({ matches: true });
    expect(await replayCorpus(corpus, threadB.threadRef)).toEqual({ matches: true });

    const readA = await readBack(threadA.threadRef);
    const readB = await readBack(threadB.threadRef);

    // Identical read-back: same events, same order, same idempotency keys.
    expect(readA).toEqual(readB);
    // The keys are the converter's real deterministic keys, not placeholders.
    expect(readA.every((event) => event.idempotencyKey.startsWith("pi:replay:tool-heavy"))).toBe(true);
    expect(new Set(readA.map((event) => event.idempotencyKey)).size).toBe(readA.length);
  });

  it("re-replaying the same corpus into the SAME thread does not perturb the read-back (deterministic keys dedup)", async () => {
    const corpus = loadChattyCorpus();
    const thread = await makeTempThread(store);

    expect(await replayCorpus(corpus, thread.threadRef)).toEqual({ matches: true });
    const first = await readBack(thread.threadRef);

    // A second replay re-delivers identical keys; the SDK dedups them, so the
    // read-back is unchanged — re-replay perturbs neither IDs nor order.
    const second = await replayCorpus(corpus, thread.threadRef);
    expect(second).toEqual({ matches: true });
    expect(await readBack(thread.threadRef)).toEqual(first);
  });
});

// ── TC-6.3: inspect overview/health reflect the captured session ─────────────
describe("Story 3: inspect overview/health reflect the captured session (TC-6.3)", () => {
  it("reports event/message counts, last recorded position, gaps, and ready derivations after healthy cascade", async () => {
    const corpus = loadToolHeavyCorpus(); // 6 events → 5 messages, 1 closed turn
    const thread = await makeTempThread(store);

    expect(await replayCorpus(corpus, thread.threadRef)).toEqual({ matches: true });

    // Counts + last recorded position, cross-checked against the event log.
    const overview1 = await inspect.overview(thread.threadRef);
    expect(overview1.ok).toBe(true);
    if (!overview1.ok) return;
    const recorded = await intakeStream.listEvents(thread.threadRef);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const lastOrder = recorded.value.at(-1)?.eventOrder;

    expect(overview1.value.events.count).toBe(corpus.expected.length); // 6
    expect(overview1.value.events.span?.last).toBe(lastOrder); // last recorded position, surfaced
    expect(overview1.value.messages.visible).toBe(5);
    expect(overview1.value.messages.byKind).toEqual({
      user_prompt: 1,
      assistant_thinking: 1,
      tool_call: 1,
      tool_result: 1,
      assistant_text: 1,
    });
    expect(overview1.value.turns.closed).toBe(1);
    expect(overview1.value.turns.open).toBe(1);

    // Observe-only replay fails inference closed, but turn construction floors
    // non-ready message derivations and compression falls back to rendering.
    expect(overview1.value.derivation.ready).toBeGreaterThan(0);
    expect(overview1.value.derivation.failed).toBe(0);
    const turnList = await turns.listTurns(thread.threadRef);
    expect(turnList.ok).toBe(true);
    if (!turnList.ok) return;
    const compression = turnList.value[0]?.derivations?.find(
      (form) => form.derivationType === "smooth_turn_compression",
    );
    expect(compression).toMatchObject({
      state: "ready",
      metadata: { fallbackFloor: "turn_rendering" },
    });
    const health1 = await inspect.health(thread.threadRef);
    expect(health1.ok).toBe(true);
    if (!health1.ok) return;
    expect(health1.value.failures.length).toBe(0);

    // A capture gap is visible, not hidden — induce one through the Story-2
    // capture path (a turn_end with a non-empty payload is rejected as
    // invalid_event, which records a durable gap note).
    const instance = liveInstance(thread.threadRef);
    const malformed = {
      eventKind: "turn_end",
      idempotencyKey: "replay-induced-gap",
      actor: "system",
      harness: "pi",
      payload: { stowaway: true },
    } as unknown as MessageEventInput;
    const gapResult = await capture([malformed], instance);
    expect(gapResult.ok).toBe(false);
    await instance.dispose();

    const health2 = await inspect.health(thread.threadRef);
    expect(health2.ok).toBe(true);
    if (!health2.ok) return;
    expect(health2.value.owners.some((owner) => owner.kind === "capture_gap" && owner.counts.failed > 0)).toBe(true);
    expect(health2.value.failures.some((failure) => failure.derivationType === "capture_gap")).toBe(true);

    // The gap note is itself a recorded event — the last recorded position
    // advances, proving the surface reflects new capture rather than a snapshot.
    const overview2 = await inspect.overview(thread.threadRef);
    expect(overview2.ok).toBe(true);
    if (!overview2.ok) return;
    expect(overview2.value.events.count).toBe(corpus.expected.length + 1);
    expect(overview2.value.events.span?.last).toBeGreaterThan(overview1.value.events.span?.last ?? 0);
  });
});
