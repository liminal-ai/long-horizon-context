export * as inspect from "./inspect/index.js";
export * as intakeStream from "./intake-stream/index.js";
export * as messages from "./messages/index.js";
export * as retrieval from "./retrieval/index.js";
export * as logging from "./shared-tech/logging/index.js";
export * as threadView from "./thread-view/index.js";
export * as threads from "./threads/index.js";
export * as turns from "./turns/index.js";

import * as inspectDomain from "./inspect/index.js";
import * as intakeStreamDomain from "./intake-stream/index.js";
import * as messagesDomain from "./messages/index.js";
import { dispatchMessageDeriveWork } from "./messages/internal/derive.js";
import { messageWorkHandlers } from "./messages/internal/handlers.js";
import * as retrievalDomain from "./retrieval/index.js";
import type {
  CompactReceipt,
  ErrorResult,
  LlmRequestContext,
  OpResult,
  PreviewCompactOutcome,
  PruneReceipt,
  SessionThreadView,
  StoredView,
  ViewCompactParams,
  ViewStatus,
} from "./shared-tech/index.js";
import {
  createDbReadTransaction,
  createDbWriteTransaction,
  createInferenceCallbacks,
  createScheduler,
  type DrainDeps,
  type DrainReport,
  type DurableWorkDispatcher,
  type DurableWorkDispatcherMap,
  type DurableWorkOperation,
  INFERENCE_CALLBACK_OPERATIONS,
  type InferenceCallbacks,
  type InferenceConfig,
  type InstanceSeam,
  setSchedulerPoke as installSchedulerPoke,
  type ModelAssignment,
  peekThreadId,
  type ResolvedSdkConfig,
  resolveGuards,
  runDrain,
  runWithInstanceSeam,
  type Scheduler,
  type SdkConfig,
  setThreadTouch,
  storageFailure,
  type WorkHandler,
} from "./shared-tech/index.js";
import * as loggingDomain from "./shared-tech/logging/index.js";
import { DEFAULT_PROMPT_NAMES, PROMPT_REGISTRY } from "./shared-tech/prompts/index.js";
import { mapWorkQHandlers, type WorkHandlerMap, type WorkKind } from "./shared-tech/work-queue/index.js";
import * as threadViewDomain from "./thread-view/index.js";
import { resolveViewConfig } from "./thread-view/index.js";
import * as threadsDomain from "./threads/index.js";
import * as turnsDomain from "./turns/index.js";
import { dispatchTurnOwnedWork, turnWorkHandlers } from "./turns/internal/derive.js";

export type {
  BatchResult,
  EventKind,
  EventRecord,
  MessageEventInput,
} from "./intake-stream/index.js";
export type {
  Block,
  BlockType,
  MessageDetail,
  MessageListOptions,
  MessageRecord,
  MutationResult,
} from "./messages/index.js";
// Compact-continuation contract (LIM-60): pure state machine + parity helpers.
// Runtime evaluation against live threads is LIM-61.
export {
  asCompactContinuationInput,
  assertDecisionParity,
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_INVARIANTS,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_TRANSITION_ORDER,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationEffect,
  type CompactContinuationHostCapability,
  type CompactContinuationInput,
  type CompactContinuationOutcomeKind,
  type CompactContinuationReceipt,
  type CompactContinuationRefuseCode,
  type CompactContinuationState,
  decideCompactContinuation,
  type ValidationIssue,
  type ValidationResult,
  validateCompactContinuationDecision,
  validateCompactContinuationInput,
  validateCompactContinuationReceipt,
} from "./shared-tech/compact-continuation/index.js";
// Inference vocabulary: the host-supplied ModelCall boundary and per-kind
// assignment config. The adapter and registry are construction internals behind
// initLhc.
// Inspect vocabulary: the report shapes the inspect surface serves.
export type {
  Band,
  CompactReceipt,
  CompletionTx,
  DependencyGap,
  Derivation,
  DerivationMetadata,
  DerivationReportEntry,
  DerivationState,
  DrainReport,
  DurableWorkDispatcher,
  DurableWorkDispatcherMap,
  DurableWorkDispatchResult,
  DurableWorkOperation,
  ErrorClass,
  ErrorCode,
  ErrorResult,
  HandlerDerivationWrite,
  HandlerOutcome,
  HandlerRunContext,
  HealthReport,
  InferenceCallbacks,
  InferenceConfig,
  InferenceResult,
  InspectOverview,
  LlmRequestContext,
  LlmRequestContextMessage,
  LlmRequestContextPart,
  ModelAssignment,
  ModelCall,
  ModelCallFailureKind,
  ModelCallInput,
  ModelCallResult,
  OpResult,
  PreviewCompactOutcome,
  PreviewCompactResult,
  PruneReceipt,
  RenderingPart,
  ResolvedSdkConfig,
  ResolvedViewConfig,
  Scheduler,
  SchedulerMode,
  SdkConfig,
  SdkViewConfig,
  SessionAssistantMessage,
  SessionAssistantPart,
  SessionModelChangeEntry,
  SessionThinkingLevelChangeEntry,
  SessionThreadView,
  SessionThreadViewEntry,
  SessionThreadViewEntrySource,
  SessionThreadViewMessage,
  SessionToolResultMessage,
  SessionUserMessage,
  StoredView,
  SubjectKind,
  ToolOutcome,
  ToolResultClassification,
  ToolResultFacts,
  ToolResultOperationClass,
  ToolResultPromptMode,
  ToolResultResponseShape,
  ViewCompactParams,
  ViewContentsReport,
  ViewProfile,
  ViewProfileOverride,
  ViewStatus,
  VisibilityBudgets,
  WorkHandler,
} from "./shared-tech/index.js";
export {
  applyDerivationSuccess,
  createDbReadTransaction,
  createDbWriteTransaction,
  createDeterministicInferenceCallbacks,
  type DbReadTransaction,
  type DbWriteTransaction,
  type DeterministicOpName,
  deterministicOutcomesSuffix,
  deterministicText,
  type PostCommitHook,
  type ProviderProvenance,
  setSchedulerPoke,
  setThreadTouch,
} from "./shared-tech/index.js";
export {
  type LogEntry,
  type LogLevel,
  type LogQuery,
  queryLog,
  type StoredLogEntry,
  writeLog,
} from "./shared-tech/logging/index.js";
// The config-selectable prompt-name catalog (E05-NB-2): the full set of names
// a per-kind assignment may select, and the default name per kind. Exposed so
// operators discover valid prompt names from the SDK surface without reading
// source. The registry itself stays a construction internal behind initLhc.
export {
  DEFAULT_PROMPT_NAMES,
  PROMPT_NAMES,
} from "./shared-tech/prompts/index.js";
export {
  estimateTokens,
  TOKEN_ESTIMATOR_ID,
} from "./shared-tech/token-counting/index.js";
export {
  type ClaimedWorkItem,
  countLiveItems,
  type EnqueueDerivationTarget,
  type EnqueueInput,
  enqueue,
  mapWorkQHandlers,
  type QueueDetailRow,
  queueDetail,
  supersedeQueued,
  WORK_KIND_REGISTRY,
  type WorkHandlerMap,
  type WorkItemRecord,
  type WorkKind,
  type WorkOwner,
  type WorkSourceRef,
} from "./shared-tech/work-queue/index.js";
// Thread-view vocabulary: config shapes live on SdkConfig and operation shapes
// live on the thread-view surface below.
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
} from "./thread-view/index.js";
export type { ThreadFileInfo, ThreadRef } from "./threads/index.js";
export type { ChunkRecord, TurnRecord } from "./turns/index.js";

// ── LHC initialization ────────────────────────────────────────────

function unknownWorkKind(kind: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: {
      errorClass: "state_corruption",
      code: "unknown_work_kind",
      reason: `no handler registered for work kind "${kind}"`,
    },
  };
}

// Dispatch-time lookup: an unregistered kind is reported explicitly — never
// a throw, never a silent undefined.
export function lookupWorkHandler(map: WorkHandlerMap, kind: string): OpResult<WorkHandler> {
  const handler = map[kind as WorkKind];
  if (handler === undefined) return unknownWorkKind(kind);
  return { ok: true, value: handler };
}

export function lookupWorkDispatcher(
  map: DurableWorkDispatcherMap,
  operation: DurableWorkOperation | undefined,
  kind: string,
): OpResult<DurableWorkDispatcher> {
  if (operation === undefined) return unknownWorkKind(kind);
  const dispatcher = map[operation.operation];
  if (dispatcher === undefined) return unknownWorkKind(kind);
  return { ok: true, value: dispatcher };
}

// The work surface used by CLI work operations.
export interface WorkSurface {
  drain(ref: threadsDomain.ThreadRef, opts?: { maxItems?: number }): Promise<OpResult<DrainReport>>;
}

// The thread-view surface as the SDK exposes it: operations only. Config
// substrate is construction machinery, not an operation. `describe` is the
// stored-snapshot read the inspect domain composes.
export interface ThreadViewSurface {
  getLlmRequestContext(ref: threadsDomain.ThreadRef): Promise<OpResult<LlmRequestContext>>;
  getSessionThreadView(ref: threadsDomain.ThreadRef): Promise<OpResult<SessionThreadView>>;
  status(ref: threadsDomain.ThreadRef): Promise<OpResult<ViewStatus>>;
  prune(ref: threadsDomain.ThreadRef, params?: { targetTokens?: number }): Promise<OpResult<PruneReceipt>>;
  describe(ref: threadsDomain.ThreadRef): Promise<OpResult<StoredView | null>>;
  previewCompact(
    ref: threadsDomain.ThreadRef,
    opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
  ): Promise<OpResult<PreviewCompactOutcome>>;
  compact(
    ref: threadsDomain.ThreadRef,
    opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
  ): Promise<OpResult<CompactReceipt>>;
  materialize(
    ref: threadsDomain.ThreadRef,
    opts: { path: string; format?: "pi-session" },
  ): Promise<OpResult<{ writtenPath: string }>>;
}

export interface LoggingSurface {
  write(ref: threadsDomain.ThreadRef, entry: loggingDomain.LogEntry): Promise<OpResult<void>>;
  query(ref: threadsDomain.ThreadRef, q: loggingDomain.LogQuery): Promise<OpResult<loggingDomain.StoredLogEntry[]>>;
  queryDerivationLog(
    ref: threadsDomain.ThreadRef,
    q: loggingDomain.DerivationLogQuery,
  ): Promise<OpResult<loggingDomain.StoredDerivationLogEntry[]>>;
}

export type IntakeStreamSurface = typeof intakeStreamDomain & {
  initLhc(config: SdkConfig): Lhc;
};

export interface Lhc {
  threads: typeof threadsDomain;
  intakeStream: IntakeStreamSurface;
  messages: typeof messagesDomain;
  retrieval: typeof retrievalDomain;
  turns: typeof turnsDomain;
  threadView: ThreadViewSurface;
  // Read-only report surface. Scoped through the instance seam like every other
  // namespace so composed status reads resolve this SDK's view config.
  inspect: typeof inspectDomain;
  logging: LoggingSurface;
  config: ResolvedSdkConfig;
  scheduler: Scheduler;
  work: WorkSurface;
  // Resolves when the scheduler has no running or pending drain for the
  // thread (issue 3) — the awaitable for background mode, and a no-op
  // resolve in manual mode.
  drainSettled(ref: threadsDomain.ThreadRef): Promise<void>;
}

interface WorkRegistration {
  workHandlers: WorkHandlerMap;
  workDispatchers: DurableWorkDispatcherMap;
}

const workRegistrationBySdk = new WeakMap<Lhc, WorkRegistration>();

export function registerTestingWork(
  sdk: Lhc,
  registration: { handlers?: WorkHandlerMap; dispatchers?: DurableWorkDispatcherMap },
): void {
  const target = workRegistrationBySdk.get(sdk);
  if (target === undefined) {
    throw new TypeError("registerTestingWork called with an SDK not created by initLhc");
  }
  if (registration.handlers !== undefined) Object.assign(target.workHandlers, registration.handlers);
  if (registration.dispatchers !== undefined) Object.assign(target.workDispatchers, registration.dispatchers);
}

const INIT_CONFIG_PREFIX = "initLhc config";

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: ${name} must be a positive number, got ${value}`);
  }
}

// Bind a domain surface to one SDK instance's delivery seam (epic-fix-001):
// every operation invoked through sdk.* runs inside runWithInstanceSeam, so
// the poke/touch it triggers deep inside reaches THIS SDK's scheduler
// (background) or a no-op (manual) — never another SDK's. Non-function exports
// pass through unchanged. The wrapped object is the same shape as the
// namespace, so the public surface type holds.
function scopeSurface<T extends object>(surface: T, seam: InstanceSeam): T {
  const scoped: Record<string, unknown> = {};
  for (const key of Object.keys(surface)) {
    const value = (surface as Record<string, unknown>)[key];
    scoped[key] =
      typeof value === "function"
        ? (...args: unknown[]): unknown =>
            runWithInstanceSeam(seam, () => (value as (...a: unknown[]) => unknown)(...args))
        : value;
  }
  return scoped as T;
}

// The default provider lane and model for inference derivation types, used
// when the host omits an inference type from inference.assignments. The
// provider key is a host routing key; LHC never resolves it.
const DEFAULT_INFERENCE_LANE = { provider: "codex", model: "gpt-5.4-mini" } as const;

// Default assignment per inference derivation type: documented default lane and
// model, registry default prompt template, and tested target ratios for
// compression/brief types. Deterministic derivations are not inference
// assignments. Construction-internal: defaults are observable through routed
// calls, not part of the public export surface.
const DEFAULT_INFERENCE_THINKING = "none" as const;

const DEFAULT_INFERENCE_ASSIGNMENTS: Readonly<Record<string, ModelAssignment>> = {
  smoothed_prompt: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1",
    thinking: DEFAULT_INFERENCE_THINKING,
  },
  tool_result_summary: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v2",
    thinking: DEFAULT_INFERENCE_THINKING,
  },
  detailed_turn_compression: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    // Stated prompt target (v3) is lower than these ratios — see detailed-turn-compression-v3.ts.
    prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression ?? "detailed-turn-compression-v3",
    // These ratios (and the targets stated in prompts) are steering, not decided
    // specs or tolerances. Ballparks that get the model in the zone; adjust freely.
    targetMinRatio: 0.35,
    targetMaxRatio: 0.65,
    targetAimRatio: 0.5,
    thinking: DEFAULT_INFERENCE_THINKING,
  },
  chunk_summary_brief: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    // Stated prompt target (v3) is lower than these ratios — see chunk-brief-v3.ts.
    prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v3",
    // Steering, not specs — see the comment on detailed_turn_compression above.
    targetMinRatio: 0.08,
    targetMaxRatio: 0.2,
    targetAimRatio: 0.12,
    thinking: DEFAULT_INFERENCE_THINKING,
  },
};

function resolveTargetRatios(
  kind: "detailed_turn_compression" | "chunk_summary_brief",
  assignment?: ModelAssignment,
): ResolvedSdkConfig["compressionTargets"] {
  const defaults = DEFAULT_INFERENCE_ASSIGNMENTS[kind]!;
  return {
    minRatio: assignment?.targetMinRatio ?? defaults.targetMinRatio!,
    aimRatio: assignment?.targetAimRatio ?? defaults.targetAimRatio!,
    maxRatio: assignment?.targetMaxRatio ?? defaults.targetMaxRatio!,
  };
}

// Resolve the `inference` construction path: validate the host function and
// assignment map, then fill defaults. Provided inference assignments must carry
// non-empty provider/model and a registry-known prompt. Inference types the host
// omits are filled from DEFAULT_INFERENCE_ASSIGNMENTS. Unknown keys are
// rejected, never silently ignored. Then the adapter is built into the same
// InferenceCallbacks slot direct injection uses. No partial construction: every
// mistake throws before anything is assembled.
function resolveInferenceCallbacks(
  inference: InferenceConfig,
  guards: ResolvedSdkConfig["guards"],
): InferenceCallbacks {
  if (typeof inference.call !== "function") {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.call must be a function`);
  }
  const provided = inference.assignments ?? {};
  if (provided === null || typeof provided !== "object") {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments must be an object`);
  }

  const inferenceKeys = new Set<string>(Object.keys(DEFAULT_INFERENCE_ASSIGNMENTS));

  // Unknown keys are rejected (anti-shim: never silently ignore) — TC-0.3a.
  for (const key of Object.keys(provided)) {
    if (!inferenceKeys.has(key)) {
      throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments has unknown derivation type "${key}"`);
    }
  }

  // Validate every effective inference assignment after merging defaults: non-empty
  // provider/model/prompt, and prompt must name a registry template.
  const merged: Record<string, ModelAssignment> = {};
  for (const kind of inferenceKeys) {
    const override = provided[kind];
    const assignment: ModelAssignment =
      override === undefined
        ? { ...DEFAULT_INFERENCE_ASSIGNMENTS[kind]! }
        : { ...DEFAULT_INFERENCE_ASSIGNMENTS[kind]!, ...override };
    if (assignment === null || typeof assignment !== "object") {
      throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments.${kind} must be an object`);
    }
    for (const field of ["provider", "model", "prompt"] as const) {
      const value = assignment[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments.${kind}.${field} must be a non-empty string`);
      }
    }
    for (const field of ["targetMinRatio", "targetAimRatio", "targetMaxRatio"] as const) {
      const value = assignment[field];
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments.${kind}.${field} must be a positive number`);
      }
    }
    if (PROMPT_REGISTRY[assignment.prompt] === undefined) {
      throw new TypeError(
        `${INIT_CONFIG_PREFIX}: inference.assignments.${kind}.prompt names unknown template "${assignment.prompt}"`,
      );
    }
    merged[kind] = assignment;
  }

  const timeoutMs = inference.timeoutMs ?? 60_000;
  const maxInputChars = inference.maxInputChars ?? 200_000;
  requirePositive(timeoutMs, "inference.timeoutMs");
  requirePositive(maxInputChars, "inference.maxInputChars");
  return createInferenceCallbacks({
    call: inference.call,
    assignments: merged,
    guards,
    timeoutMs,
    maxInputChars,
  });
}

// The only initialization path: inference callbacks, mode, clock, and policy enter here.
// Config mistakes are programmer errors at construction and throw; operating
// failures after construction return OpResults per the error contract.
export function initLhc(config: SdkConfig): Lhc {
  // Inference callbacks arrive by direct injection or by the inference config
  // There is no named inference-callback registry and no env/flag resolution
  // path to fall back on. The XOR rule is validated before anything downstream
  // so the error names the caller's mistake, not a symptom.
  if (config.inferenceCallbacks !== undefined && config.inference !== undefined) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference`);
  }
  if (config.inferenceCallbacks === undefined && config.inference === undefined) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference`);
  }
  if (config.mode !== "background" && config.mode !== "manual") {
    throw new TypeError(
      `${INIT_CONFIG_PREFIX}: mode must be "background" or "manual", got ${JSON.stringify(config.mode)}`,
    );
  }
  const guards = resolveGuards(config.guards);
  const compressionTargets = resolveTargetRatios(
    "detailed_turn_compression",
    config.inference?.assignments?.detailed_turn_compression,
  );
  const briefTargets = resolveTargetRatios("chunk_summary_brief", config.inference?.assignments?.chunk_summary_brief);

  let inferenceCallbacks: InferenceCallbacks;
  if (config.inference !== undefined) {
    inferenceCallbacks = resolveInferenceCallbacks(config.inference, guards);
  } else {
    const directCallbacks = config.inferenceCallbacks;
    if (directCallbacks === null || typeof directCallbacks !== "object") {
      throw new TypeError(`${INIT_CONFIG_PREFIX}: inferenceCallbacks must implement InferenceCallbacks`);
    }
    for (const operation of INFERENCE_CALLBACK_OPERATIONS) {
      if (typeof directCallbacks[operation] !== "function") {
        throw new TypeError(`${INIT_CONFIG_PREFIX}: inferenceCallbacks is missing operation ${operation}`);
      }
    }
    inferenceCallbacks = directCallbacks;
  }

  const resolved: ResolvedSdkConfig = {
    inferenceCallbacks,
    mode: config.mode,
    clock: config.clock ?? (() => new Date()),
    guards,
    compressionTargets,
    briefTargets,
    toolResult: config.toolResult ?? {
      smallTierTokens: 1000,
      smallTargetRatio: 0.15,
      midTargetRatio: 0.04,
    },
    lease: config.lease ?? { durationMs: 120000 },
    chunkPolicy: config.chunkPolicy ?? { targetProjectedTokens: 2200, maxProjectedTokens: 4400 },
    // Built-ins merged with user profiles by name; band sums and visibility
    // budgets validated, throwing with the violated setting named.
    view: resolveViewConfig(config.view),
  };
  requirePositive(resolved.guards.smoothedPrompt.maxInferenceTokens, "guards.smoothedPrompt.maxInferenceTokens");
  requirePositive(resolved.guards.smoothedPrompt.suspiciousOutputRatio, "guards.smoothedPrompt.suspiciousOutputRatio");
  requirePositive(resolved.guards.toolResultSummary.timeoutMs, "guards.toolResultSummary.timeoutMs");
  requirePositive(
    resolved.guards.detailedTurnCompression.tinyTurnTokens,
    "guards.detailedTurnCompression.tinyTurnTokens",
  );
  requirePositive(resolved.compressionTargets.minRatio, "compressionTargets.minRatio");
  requirePositive(resolved.compressionTargets.aimRatio, "compressionTargets.aimRatio");
  requirePositive(resolved.compressionTargets.maxRatio, "compressionTargets.maxRatio");
  if (resolved.compressionTargets.maxRatio < resolved.compressionTargets.minRatio) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: compressionTargets.maxRatio must be >= minRatio`);
  }
  if (
    resolved.compressionTargets.aimRatio < resolved.compressionTargets.minRatio ||
    resolved.compressionTargets.aimRatio > resolved.compressionTargets.maxRatio
  ) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: compressionTargets.aimRatio must be between minRatio and maxRatio`);
  }
  requirePositive(resolved.briefTargets.minRatio, "briefTargets.minRatio");
  requirePositive(resolved.briefTargets.aimRatio, "briefTargets.aimRatio");
  requirePositive(resolved.briefTargets.maxRatio, "briefTargets.maxRatio");
  if (resolved.briefTargets.maxRatio < resolved.briefTargets.minRatio) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: briefTargets.maxRatio must be >= minRatio`);
  }
  if (
    resolved.briefTargets.aimRatio < resolved.briefTargets.minRatio ||
    resolved.briefTargets.aimRatio > resolved.briefTargets.maxRatio
  ) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: briefTargets.aimRatio must be between minRatio and maxRatio`);
  }
  requirePositive(resolved.toolResult.smallTierTokens, "toolResult.smallTierTokens");
  requirePositive(resolved.toolResult.smallTargetRatio, "toolResult.smallTargetRatio");
  requirePositive(resolved.toolResult.midTargetRatio, "toolResult.midTargetRatio");
  requirePositive(resolved.lease.durationMs, "lease.durationMs");
  requirePositive(resolved.chunkPolicy.targetProjectedTokens, "chunkPolicy.targetProjectedTokens");
  if (resolved.chunkPolicy.maxProjectedTokens < resolved.chunkPolicy.targetProjectedTokens) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens`);
  }

  // Handler maps merge from per-domain contributions at construction.
  const workHandlers = mapWorkQHandlers([messageWorkHandlers, turnWorkHandlers]);
  const workDispatchers: DurableWorkDispatcherMap = {
    "messages.derive": (run, item) => dispatchMessageDeriveWork(run, item),
    "turns.deriveTurn": (run, item) => dispatchTurnOwnedWork(run, { ...item, kind: "turn_derivation" }),
    "turns.deriveDetailedTurnCompression": (run, item) =>
      dispatchTurnOwnedWork(run, { ...item, kind: "detailed_turn_compression" }),
    "turns.deriveDetailedChunk": (run, item) => dispatchTurnOwnedWork(run, { ...item, kind: "chunk_summary_detailed" }),
    "turns.deriveBriefChunk": (run, item) => dispatchTurnOwnedWork(run, { ...item, kind: "chunk_summary_brief" }),
  };

  const drainDeps: DrainDeps = {
    lookupDispatcher: (operation, kind) => lookupWorkDispatcher(workDispatchers, operation, kind),
    hasAnyHandler: () => Object.keys(workDispatchers).length > 0,
    config: resolved,
    openThreadDatabase: threadsDomain.openThreadDatabase,
  };
  const scheduler = createScheduler(resolved.mode, drainDeps);

  // This SDK's per-instance delivery seam. Every operation
  // invoked through the scoped surfaces below runs inside it, so enqueue pokes
  // and thread-file touches reach this instance's scheduler in background mode,
  // or a no-op in manual mode, isolated from any other SDK alive in the process.
  // A manual SDK therefore never auto-drains, whatever the construction order.
  // The seam also carries this instance's resolved view config: thread-view
  // operations invoked through sdk.* read this SDK's profiles/budgets/threshold;
  // below-SDK direct domain calls fall back to built-in defaults inside the
  // thread-view surface.
  const seam: InstanceSeam =
    resolved.mode === "background"
      ? {
          poke: (threadId) => scheduler.poke(threadId),
          touch: (filePath, db) => scheduler.touch(filePath, db),
          view: resolved.view,
          config: resolved,
        }
      : { poke: () => {}, touch: () => {}, view: resolved.view, config: resolved };

  // Background mode also installs the below-SDK default seam so a direct
  // domain call made with no SDK scope — a top-level mutation in the
  // single-background default path — still reaches the one installed
  // scheduler. The per-instance scoping above overrides this for every sdk.*
  // call, so the default can never auto-drain a manual SDK's work. Manual mode
  // leaves the default alone (pokes stay no-ops by contract).
  if (resolved.mode === "background") {
    installSchedulerPoke((threadId) => scheduler.poke(threadId));
    setThreadTouch((filePath, db) => scheduler.touch(filePath, db));
  }

  const work: WorkSurface = {
    drain: (ref, opts) =>
      runWithInstanceSeam(seam, async () => {
        const resolvedRef = await threadsDomain.resolveThreadRef(ref);
        if (!resolvedRef.ok) return resolvedRef;
        return runDrain(resolvedRef.value.filePath, drainDeps, opts);
      }),
  };

  const logging: LoggingSurface = {
    write: (ref, entry) =>
      runWithInstanceSeam(seam, async () => {
        try {
          const written = await createDbWriteTransaction(
            ref,
            (transaction) => {
              loggingDomain.writeLog(transaction, entry);
            },
            resolved.clock,
          );
          return written.ok ? { ok: true as const, value: undefined } : written;
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return storageFailure(`log write failed: ${reason}`);
        }
      }),
    query: (ref, q) =>
      runWithInstanceSeam(seam, async () => {
        try {
          return await createDbReadTransaction(ref, (transaction) => loggingDomain.queryLog(transaction.db, q));
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return storageFailure(`log query failed: ${reason}`);
        }
      }),
    queryDerivationLog: (ref, q) =>
      runWithInstanceSeam(seam, async () => {
        try {
          return await createDbReadTransaction(ref, (transaction) =>
            loggingDomain.queryDerivationLog(transaction.db, q),
          );
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          return storageFailure(`derivation log query failed: ${reason}`);
        }
      }),
  };

  const intakeStreamSurface: IntakeStreamSurface = {
    ...intakeStreamDomain,
    initLhc,
  };

  const sdk: Lhc = {
    threads: threadsDomain,
    intakeStream: scopeSurface(intakeStreamSurface, seam),
    messages: scopeSurface(messagesDomain, seam),
    retrieval: scopeSurface(retrievalDomain, seam),
    turns: scopeSurface(turnsDomain, seam),
    threadView: scopeSurface<ThreadViewSurface>(
      {
        getLlmRequestContext: threadViewDomain.getLlmRequestContext,
        getSessionThreadView: threadViewDomain.getSessionThreadView,
        status: threadViewDomain.status,
        prune: threadViewDomain.prune,
        describe: threadViewDomain.describe,
        previewCompact: threadViewDomain.previewCompact,
        compact: threadViewDomain.compact,
        materialize: threadViewDomain.materialize,
      },
      seam,
    ),
    inspect: scopeSurface(inspectDomain, seam),
    logging,
    config: resolved,
    scheduler,
    work,
    drainSettled: async (ref) => {
      const resolvedRef = await threadsDomain.resolveThreadRef(ref);
      if (!resolvedRef.ok) return; // nothing can be scheduled for an unresolvable ref
      const threadId = peekThreadId(resolvedRef.value.filePath);
      if (threadId === null) return;
      return scheduler.drainSettled(threadId);
    },
  };
  workRegistrationBySdk.set(sdk, { workHandlers, workDispatchers });
  return sdk;
}
