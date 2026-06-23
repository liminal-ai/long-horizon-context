import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventKind, MessageEventInput } from "../../src/index.js";
import { openDatabase } from "../../src/shared-tech/storage.js";

export type EventByKind<K extends EventKind> = Extract<MessageEventInput, { eventKind: K }>;

let keyCounter = 0;

const defaultPayloads: { [K in EventKind]: () => EventByKind<K>["payload"] } = {
  user_prompt: () => ({ text: "please read the file" }),
  assistant_text: () => ({ text: "here is what I found" }),
  assistant_thinking: () => ({ text: "considering the file contents" }),
  runtime_note: () => ({ text: "harness restarted mid-turn" }),
  model_change: () => ({ previousModel: "gpt-5", newModel: "gpt-5.1" }),
  thinking_level_change: () => ({ previousLevel: "medium", newLevel: "high" }),
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
  return eventBatch(["user_prompt", "assistant_text", "tool_call", "tool_result", "turn_end"]);
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
  return openDatabase(path);
}

export {
  corruptTwoOpenTurns,
  poisonMessageBlockJson,
  poisonMessageFormJson,
} from "./corrupt.js";
export {
  type CapturedInput,
  createInferenceCallbacksDouble,
  type InferenceCallbackOpName,
  InferenceCallbacksDouble,
} from "./inference-callbacks-double.js";
export { type IntakeWalkHook, setIntakeClock, setIntakeWalkHook } from "./intake-seam.js";
export {
  createLifecycleSdk,
  DELETE_TARGET,
  DELETED_MESSAGE_TEXT,
  EDIT_TARGET,
  EDITED_MESSAGE_TEXT,
  LIFECYCLE_PROFILE,
  type LifecycleCheckpoint,
  type LifecycleOptions,
  type LifecyclePhases,
  type LifecycleRun,
  runLifecycle,
} from "./lifecycle.js";
export {
  cannedResponses,
  DERIVATION_TYPES,
  type DerivationType,
  FAKE_MODEL_PREFIX,
  FAKE_PROVIDER_PREFIX,
  hangingCall,
  INFERENCE_DERIVATION_TYPES,
  type InferenceDerivationType,
  recordingCall,
  scriptedCall,
  throwingCall,
  validAssignments,
} from "./model-call.js";
export {
  createOpenRouterCall,
  DEFAULT_OPENROUTER_MODEL,
  emitRealSuiteAccounting,
  loadLocalLhcEnv,
  OPENROUTER_ENDPOINT,
  type RealSuiteEnv,
  realSuiteAccountingEmissions,
  resolveRealSuiteEnv,
} from "./openrouter-call.js";
export { assertPiSessionConformance, loadPiSessionFixture } from "./pi-session-format.js";
export {
  expectReadOnly,
  type ObservableState,
  observableState,
} from "./read-only-delta.js";
export {
  assertModelCallContract,
  assertRoutingThroughSdk,
  probeInput,
  type RoutingRunResult,
} from "./seam-conformance.js";
export {
  type ChunkSnapshot,
  damagedSourceThread,
  GAPPED_SMOOTHING_REASON,
  gappedRenderingThread,
  type MultiStateClaim,
  multiStateThread,
  readChunks,
  readDerivedForms,
  setFormState,
  threadWithClosedTurns,
  threadWithToolRun,
} from "./threads.js";
export {
  boundaryTokens,
  boundaryToolRun,
  seedTurnedToolResults,
  type TurnedToolResultsSpec,
  turnedToolResultEvents,
} from "./view-boundary.js";
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
  type DerivedThreadFixture,
  type DerivedThreadOptions,
  derivedThreadFixture,
  type MixedStateFixture,
  type MutationInFlightFixture,
  mixedStateVariantThread,
  mutationInFlightVariant,
  PERMANENT_FAILURE_REASON,
  TRANSIENT_EXHAUST_REASON,
} from "./view-thread.js";
export {
  registerTestWorkHandlers,
  type TestHandlerHooks,
  testWorkHandlers,
} from "./work-handlers.js";
