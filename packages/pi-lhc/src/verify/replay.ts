import {
  initLhc,
  inspect,
  intakeStream,
  messages,
  turns,
  type EventRecord,
  type InferenceCallbacks,
  type InferenceResult,
  type InspectOverview,
  type MessageEventInput,
  type MessageRecord,
  type OpResult,
  type ThreadRef,
  type TurnRecord,
} from "lhc";
import type { AgentMessage } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import { capture, captureGap } from "../capture/converter.js";
import { mapMessage, type MapCtx } from "../capture/map-message.js";
import { TurnAccumulator } from "../capture/turn-accumulator.js";

// AC-6.1, AC-6.2 (Flow 6, Story 3). Capture correctness is proven WITHOUT
// serving anything to a model: a recorded PI corpus replays through the REAL
// converter and intake path into a temp thread, and the thread's read-back —
// events, messages, and turns — is compared to the fixture's expectation. The
// same corpus replayed twice yields identical read-back because the converter's
// mapping and the SDK's deterministic ids make replay reproducible.
//
// Anti-shim (story §Anti-Shim Requirements): this drives Story 2's converter
// (`mapMessage` → `TurnAccumulator` → `capture`) exactly as live capture does —
// it never writes the fixture's expected events to the thread, and it compares
// events/messages/turns/order, never just counts. inspect's overview/health are
// the live read-back surfaces a Story-3 test asserts on for AC-6.3.

export type RecordedPiHookEvent =
  | { recordType: "pi_hook"; hook: "message_end"; entryId: string; position?: number; message: AgentMessage }
  | { recordType: "pi_lifecycle"; hook: "agent_end"; entryId?: string; position?: number };

/** A loaded corpus: recorded PI hook/lifecycle events paired with the expected
 *  LHC intake events. Both `verify/replay` and the corpus fixtures consume this
 *  shape. */
export interface Corpus {
  name: string;
  source: RecordedPiHookEvent[];
  expected: MessageEventInput[];
}

/** A structured compare result with a readable diff (tech design §Technical
 *  Notes). `matches` is true only when events, messages, AND turns all line up
 *  with the fixture; `diff` names every divergence when they do not. */
export interface ReplayResult {
  matches: boolean;
  diff?: string;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Construction-valid, fail-closed inference callbacks — the same observe-only
 *  shape the live Epic-1 session runs on (index.ts). Replay never serves context
 *  to a model, so every derivation operation fails closed (non-retryable) rather
 *  than fabricating derived text; the resulting failed derivations are exactly
 *  what inspect health must surface (AC-6.3), so the harness mirrors production
 *  rather than hiding them behind a succeeding fake. */
function observeOnlyInferenceCallbacks(): InferenceCallbacks {
  const notConfigured = (): Promise<InferenceResult> =>
    Promise.resolve({
      ok: false,
      retryable: false,
      reason: "pi-lhc replay is observe-only (no inference served)",
    });
  return {
    smoothPrompt: notConfigured,
    summarizeToolResult: notConfigured,
    composeTurnRendering: notConfigured,
    compressSmoothTurn: notConfigured,
    summarizeChunkDetailed: notConfigured,
    summarizeChunkBrief: notConfigured,
  };
}

/** Build a real background LHC instance against the temp thread. The converter
 *  writes through `instance.sdk.intakeStream`, and `dispose` drains settled so
 *  background derivations reach a terminal state before read-back — the same
 *  flush-on-dispose contract the lifecycle instance uses, rebuilt here because
 *  `verify` may not import `lifecycle` (boundary rule 3). */
function buildReplayInstance(threadRef: ThreadRef): LhcInstance {
  const sdk = initLhc({ inferenceCallbacks: observeOnlyInferenceCallbacks(), mode: "background" });
  return {
    sdk,
    threadRef,
    dispose: async (): Promise<OpResult<void>> => {
      try {
        await sdk.drainSettled(threadRef);
      } catch {
        // Best-effort flush; replay's verdict comes from durable read-back, not
        // from the drain, and a drain failure must not throw out of verify.
      }
      return { ok: true, value: undefined };
    },
  };
}

/** A deterministic per-replay session id derived from the CORPUS, not the
 *  thread: it scopes every idempotency key, so the same corpus replayed into two
 *  different temp threads produces byte-identical keys (AC-6.2), while different
 *  corpora never collide. */
function replaySessionId(corpus: Corpus): string {
  return `replay:${corpus.name}`;
}

/** Drive one recorded PI hook/lifecycle corpus through the real converter into
 *  the thread. `message_end` records map through Story 2's mapper; `agent_end`
 *  records close turns through the same accumulator operation used live. */
async function driveCorpus(corpus: Corpus, instance: LhcInstance): Promise<void> {
  const piSessionId = replaySessionId(corpus);
  const accumulator = new TurnAccumulator({ piSessionId });

  for (const [index, record] of corpus.source.entries()) {
    if (record.hook === "agent_end") {
      await flush(accumulator.onAgentEnd(), instance);
      continue;
    }

    const mapCtx: MapCtx = { piSessionId, entryId: record.entryId };
    let events: MessageEventInput[];
    try {
      events = mapMessage(record.message, mapCtx);
    } catch (cause) {
      await captureGap(record.entryId || `${piSessionId}:entry:${index}`, `replay map failed: ${detail(cause)}`, instance);
      continue;
    }
    accumulator.onMessage(events);
    await flush(events, instance);
  }
}

async function flush(events: MessageEventInput[], instance: LhcInstance): Promise<void> {
  if (events.length === 0) return;
  await capture(events, instance);
}

/** Strip the server-stamped order/timestamp so the comparison is over the
 *  logical intake shape the converter produced — including the real, stable
 *  idempotency keys (kept so AC-6.2's determinism is checkable on the read-back),
 *  excluding `recordedAt` (a wall-clock value that legitimately differs run to
 *  run). */
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

/** Order-independent canonical JSON for value comparison: object keys sorted
 *  recursively so two structurally-equal payloads built in different key orders
 *  compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

interface MessageProjection {
  visible: number;
  byKind: Record<string, number>;
}

type ComparableMessageRecord = Pick<
  MessageRecord,
  "messageId" | "sourceEventOrder" | "kind" | "blocks" | "harness" | "turnId"
>;

type ComparableTurnRecord = Pick<
  TurnRecord,
  "turnId" | "status" | "memberMessageIds" | "openedAtEventOrder" | "closedAtEventOrder"
>;

/** The message read-back the fixture implies: each non-`turn_end` event projects
 *  to exactly one message of its kind (LHC's projection, verified 1:1), so the
 *  expected `messages.visible` and `messages.byKind` fall straight out of the
 *  expected event list. */
function expectedMessages(expected: readonly MessageEventInput[]): MessageProjection {
  const byKind: Record<string, number> = {};
  let visible = 0;
  for (const event of expected) {
    if (event.eventKind === "turn_end") continue;
    byKind[event.eventKind] = (byKind[event.eventKind] ?? 0) + 1;
    visible += 1;
  }
  return { visible, byKind };
}

function expectedMessageRecords(expected: readonly MessageEventInput[]): ComparableMessageRecord[] {
  const records: ComparableMessageRecord[] = [];
  let openTurnId: string | undefined;
  let nextTurnOrder = 1;

  for (const [index, event] of expected.entries()) {
    const sourceEventOrder = index + 1;
    if (event.eventKind === "user_prompt") {
      openTurnId = `t${nextTurnOrder}`;
      nextTurnOrder += 1;
    } else if (event.eventKind === "turn_end") {
      openTurnId = undefined;
      continue;
    }

    records.push({
      messageId: `m${sourceEventOrder}`,
      sourceEventOrder,
      kind: event.eventKind,
      harness: event.harness,
      ...(openTurnId === undefined ? {} : { turnId: openTurnId }),
      blocks: expectedBlocks(event),
    });
  }

  return records;
}

function expectedBlocks(event: MessageEventInput): MessageRecord["blocks"] {
  switch (event.eventKind) {
    case "user_prompt":
    case "assistant_text":
    case "assistant_thinking":
    case "runtime_note":
      return [{ blockType: "text", content: { text: event.payload.text } }];
    case "model_change":
      return [{ blockType: "model_change", content: event.payload }];
    case "thinking_level_change":
      return [{ blockType: "thinking_level_change", content: event.payload }];
    case "tool_call":
      return [
        {
          blockType: "tool_call",
          content: {
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            arguments: event.payload.arguments,
          },
        },
      ];
    case "tool_result":
      return [
        {
          blockType: "tool_result",
          content: {
            toolCallId: event.payload.toolCallId,
            content: event.payload.content,
            isError: event.payload.isError ?? false,
          },
        },
      ];
    case "turn_end":
      return [];
  }
}

function comparableMessageRecords(records: readonly MessageRecord[]): ComparableMessageRecord[] {
  return records.map((record) => ({
    messageId: record.messageId,
    sourceEventOrder: record.sourceEventOrder,
    kind: record.kind,
    blocks: record.blocks,
    harness: record.harness,
    ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
  }));
}

function expectedTurnRecords(expected: readonly MessageEventInput[]): ComparableTurnRecord[] {
  const records: ComparableTurnRecord[] = [];
  let openTurn: ComparableTurnRecord | undefined;

  for (const [index, event] of expected.entries()) {
    const eventOrder = index + 1;
    if (event.eventKind === "user_prompt") {
      if (openTurn !== undefined) {
        openTurn.status = "closed";
        openTurn.closedAtEventOrder = eventOrder;
      }
      openTurn = {
        turnId: `t${records.length + 1}`,
        status: "open",
        memberMessageIds: [],
        openedAtEventOrder: eventOrder,
      };
      records.push(openTurn);
    } else if (event.eventKind === "turn_end") {
      if (openTurn !== undefined) {
        openTurn.status = "closed";
        openTurn.closedAtEventOrder = eventOrder;
        openTurn = undefined;
      }
      continue;
    }

    if (openTurn !== undefined) {
      openTurn.memberMessageIds.push(`m${eventOrder}`);
    }
  }

  return records;
}

function comparableTurnRecords(records: readonly TurnRecord[]): ComparableTurnRecord[] {
  return records.map((record) => ({
    turnId: record.turnId,
    status: record.status,
    memberMessageIds: record.memberMessageIds,
    openedAtEventOrder: record.openedAtEventOrder,
    ...(record.closedAtEventOrder === undefined ? {} : { closedAtEventOrder: record.closedAtEventOrder }),
  }));
}

/** Compare the actual read-back (events, plus messages/turns from inspect
 *  overview) to the fixture's expectation, accumulating a readable diff. Returns
 *  `null` on a full match. */
function compareReadback(
  corpus: Corpus,
  actual: readonly MessageEventInput[],
  overview: InspectOverview,
  actualMessages: readonly MessageRecord[],
  actualTurns: readonly TurnRecord[],
): string[] {
  const problems: string[] = [];
  const expected = corpus.expected;

  // Events — kind + payload, in source-event order (never counts alone).
  if (actual.length !== expected.length) {
    problems.push(`events.count: expected ${expected.length}, got ${actual.length}`);
  }
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined) {
      problems.push(`events[${i}]: unexpected extra ${got?.eventKind} ${canonical(got?.payload)}`);
      continue;
    }
    if (got === undefined) {
      problems.push(`events[${i}]: missing expected ${want.eventKind} ${canonical(want.payload)}`);
      continue;
    }
    if (got.eventKind !== want.eventKind) {
      problems.push(`events[${i}].kind: expected ${want.eventKind}, got ${got.eventKind}`);
    } else if (canonical(got.payload) !== canonical(want.payload)) {
      problems.push(
        `events[${i}].payload (${want.eventKind}): expected ${canonical(want.payload)}, got ${canonical(got.payload)}`,
      );
    }
  }

  // Messages — projected counts by kind.
  const expectedMsgs = expectedMessages(expected);
  if (overview.messages.visible !== expectedMsgs.visible) {
    problems.push(`messages.visible: expected ${expectedMsgs.visible}, got ${overview.messages.visible}`);
  }
  if (canonical(overview.messages.byKind) !== canonical(expectedMsgs.byKind)) {
    problems.push(
      `messages.byKind: expected ${canonical(expectedMsgs.byKind)}, got ${canonical(overview.messages.byKind)}`,
    );
  }

  // Turns — one closed turn per expected `turn_end`, none left open.
  const expectedClosed = expected.filter((event) => event.eventKind === "turn_end").length;
  if (overview.turns.closed !== expectedClosed) {
    problems.push(`turns.closed: expected ${expectedClosed}, got ${overview.turns.closed}`);
  }
  if (overview.turns.open !== 0) {
    problems.push(`turns.open: expected 0, got ${overview.turns.open}`);
  }

  // Messages — full read-back records implied by the fixture, in source order.
  const expectedMessageRows = expectedMessageRecords(expected);
  const actualMessageRows = comparableMessageRecords(actualMessages);
  if (canonical(actualMessageRows) !== canonical(expectedMessageRows)) {
    problems.push(
      `messages.records: expected ${canonical(expectedMessageRows)}, got ${canonical(actualMessageRows)}`,
    );
  }

  // Turns — full read-back records implied by fixture event boundaries.
  const expectedTurnRows = expectedTurnRecords(expected);
  const actualTurnRows = comparableTurnRecords(actualTurns);
  if (canonical(actualTurnRows) !== canonical(expectedTurnRows)) {
    problems.push(`turns.records: expected ${canonical(expectedTurnRows)}, got ${canonical(actualTurnRows)}`);
  }

  return problems;
}

/** Replay a recorded corpus through the converter into the temp thread, then
 *  compare the durable read-back (events, messages, turns) to the fixture's
 *  expectation. The thread is left populated so a caller can read inspect's
 *  overview/health off it (AC-6.3). Deterministic: the same corpus yields the
 *  same recorded read-back every time (AC-6.2). */
export async function replayCorpus(corpus: Corpus, threadRef: ThreadRef): Promise<ReplayResult> {
  const instance = buildReplayInstance(threadRef);
  const problems: string[] = [];
  try {
    await driveCorpus(corpus, instance);
  } catch (cause) {
    problems.push(`replay threw before completion: ${detail(cause)}`);
  } finally {
    await instance.dispose();
  }

  const read = await intakeStream.listEvents(threadRef);
  if (!read.ok) {
    return { matches: false, diff: [...problems, `listEvents failed: ${read.error.reason}`].join("\n") };
  }
  const overview = await inspect.overview(threadRef);
  if (!overview.ok) {
    return { matches: false, diff: [...problems, `inspect.overview failed: ${overview.error.reason}`].join("\n") };
  }
  const messageReadback = await messages.listMessages(threadRef);
  if (!messageReadback.ok) {
    return {
      matches: false,
      diff: [...problems, `messages.listMessages failed: ${messageReadback.error.reason}`].join("\n"),
    };
  }
  const turnReadback = await turns.listTurns(threadRef);
  if (!turnReadback.ok) {
    return {
      matches: false,
      diff: [...problems, `turns.listTurns failed: ${turnReadback.error.reason}`].join("\n"),
    };
  }

  problems.push(
    ...compareReadback(corpus, logicalEvents(read.value), overview.value, messageReadback.value, turnReadback.value),
  );
  if (problems.length === 0) return { matches: true };
  return { matches: false, diff: problems.join("\n") };
}
