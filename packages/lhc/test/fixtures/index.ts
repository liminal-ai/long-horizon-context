import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventKind, MessageEventInput } from "../../src/index.js";

export type EventByKind<K extends EventKind> = Extract<
  MessageEventInput,
  { eventKind: K }
>;

let keyCounter = 0;

const defaultPayloads: { [K in EventKind]: () => EventByKind<K>["payload"] } = {
  user_prompt: () => ({ text: "please read the file" }),
  assistant_text: () => ({ text: "here is what I found" }),
  assistant_thinking: () => ({ text: "considering the file contents" }),
  runtime_note: () => ({ text: "harness restarted mid-turn" }),
  tool_call: () => ({
    toolCallId: "call-1",
    toolName: "read_file",
    arguments: { path: "notes.txt" },
  }),
  tool_result: () => ({
    toolCallId: "call-1",
    content: "contents of notes.txt",
    isError: false,
  }),
  turn_end: () => ({}),
};

// Returns the discriminated MessageEventInput member for its kind, so a
// kind/payload mismatch in test code is a compile error — building an invalid
// pairing requires an explicit cast at the call site.
export function validEvent<K extends EventKind>(
  kind: K,
  overrides: Partial<Omit<EventByKind<K>, "eventKind">> = {},
): EventByKind<K> {
  keyCounter += 1;
  const base = {
    eventKind: kind,
    idempotencyKey: `fixture-key-${keyCounter}`,
    actor: "fixture-actor",
    harness: "fixture-harness",
    payload: defaultPayloads[kind](),
  };
  // The fields are built per-kind above (payload is typed EventByKind<K>["payload"]),
  // but TS can't reduce a structural spread to the deferred Extract<…, { eventKind: K }>,
  // so the final reconciliation goes through unknown. Call-site safety lives in the
  // parameter types, not this assertion.
  return { ...base, ...overrides } as unknown as EventByKind<K>;
}

export function eventBatch(kinds: readonly EventKind[]): MessageEventInput[] {
  return kinds.map((kind) => validEvent(kind));
}

export function conversationTurn(): MessageEventInput[] {
  return eventBatch([
    "user_prompt",
    "assistant_text",
    "tool_call",
    "tool_result",
    "turn_end",
  ]);
}

export interface TempStore {
  dir: string;
  registryPath: string;
  threadPath: (name?: string) => string;
  cleanup: () => void;
}

export function tempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "lhc-test-"));
  let threadCounter = 0;
  return {
    dir,
    registryPath: join(dir, "registry.sqlite"),
    threadPath: (name) => {
      threadCounter += 1;
      return join(dir, `${name ?? `thread-${threadCounter}`}.sqlite`);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Direct node:sqlite handle for below-SDK assertions. Read-only use by
// convention; fixtures/corrupt.ts is the one sanctioned writer.
export function openRaw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

export {
  corruptTwoOpenTurns,
  poisonMessageBlockJson,
  poisonMessageFormJson,
} from "./corrupt.js";
export { assertSweepReceiptShape } from "./receipt-schema.js";
export { assertPiSessionConformance, loadPiSessionFixture } from "./pi-session-format.js";
// The sweep's classification table, re-exported for the Story 3 unit legs:
// fixtures are the one sanctioned bridge across the no-internal-imports
// boundary (check-boundaries exempts test/fixtures/ by design), and the
// table is exported from sweep.ts for tests by story contract.
export {
  classifyFailureReason,
  REASON_CLASS_TABLE,
  type ReasonClass,
} from "../../src/domains/thread-view/internal/sweep.js";
export {
  legacyEpic01ThreadFile,
  legacyEpic02ThreadFile,
  legacyStory2ThreadFile,
  schemaVersionOf,
  type LegacyRecordedEvent,
} from "./legacy.js";
export { setIntakeClock, setIntakeWalkHook, type IntakeWalkHook } from "./intake-seam.js";
export {
  createProviderDouble,
  ProviderDouble,
  type CapturedInput,
  type ProviderOpName,
} from "./provider-double.js";
export {
  registerTestWorkHandlers,
  testWorkHandlers,
  type TestHandlerHooks,
} from "./work-handlers.js";
export {
  fireViewInjection,
  seedViewBoundary,
  setViewInjectionHook,
  type ViewInjectionHook,
  type ViewInjectionPoint,
} from "./view-seam.js";
export {
  blockedSiblingThread,
  corruptedVariantThread,
  derivedThreadFixture,
  PERMANENT_FAILURE_REASON,
  stragglerVariantThread,
  TRANSIENT_EXHAUST_REASON,
  type DerivedThreadFixture,
  type DerivedThreadOptions,
} from "./view-thread.js";
export {
  damagedSourceThread,
  GAPPED_SMOOTHING_REASON,
  gappedRenderingThread,
  multiStateThread,
  readChunks,
  readDerivedForms,
  setFormState,
  threadWithClosedTurns,
  threadWithToolRun,
  twinThreads,
  type ChunkSnapshot,
  type MultiStateClaim,
} from "./threads.js";
