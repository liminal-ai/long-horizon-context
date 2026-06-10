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

export { corruptTwoOpenTurns } from "./corrupt.js";
export {
  legacyStory2ThreadFile,
  schemaVersionOf,
  type LegacyRecordedEvent,
} from "./legacy.js";
export { setIntakeClock, setIntakeWalkHook, type IntakeWalkHook } from "./intake-seam.js";
