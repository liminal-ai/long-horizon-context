export * as compactContinuation from "./compact-continuation/index.js";
export * as inspect from "./inspect/index.js";
export * as intakeStream from "./intake-stream/index.js";
export * as messages from "./messages/index.js";
export * as retrieval from "./retrieval/index.js";
export * from "./shared-tech/inference-claude-cli.js";
export * as logging from "./shared-tech/logging/index.js";
export * from "./shared-tech/summary-worker.js";
export * as threadView from "./thread-view/index.js";
export * as threads from "./threads/index.js";
export * as turns from "./turns/index.js";

import * as compactContinuationDomain from "./compact-continuation/index.js";
import * as inspectDomain from "./inspect/index.js";
import * as intakeStreamDomain from "./intake-stream/index.js";
import * as messagesDomain from "./messages/index.js";
import { dispatchMessageDeriveWork } from "./messages/internal/derive.js";
import { messageWorkHandlers } from "./messages/internal/handlers.js";
import * as retrievalDomain from "./retrieval/index.js";
import type {
  CompactReceipt,
  ErrorResult,
  HostMetadata,
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
import { TokenEstimator } from "./shared-tech/token-counting/index.js";
import { mapWorkQHandlers, type WorkHandlerMap, type WorkKind } from "./shared-tech/work-queue/index.js";
import * as threadViewDomain from "./thread-view/index.js";
import { resolveViewConfig } from "./thread-view/index.js";
import * as threadsDomain from "./threads/index.js";
import * as turnsDomain from "./turns/index.js";
import { dispatchTurnOwnedWork, turnWorkHandlers } from "./turns/internal/derive.js";

export type {
  BoundaryRow,
  BoundaryStatus,
  CompactContinuationHostFacts,
  CompactContinuationRunResult,
  StageName,
  StoredCompactContinuationReceipt,
  ToolPairProof,
  WriterClaimRow,
} from "./compact-continuation/index.js";
export { provePendingToolPair, validateHostFacts } from "./compact-continuation/index.js";
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
export {
  asCompactContinuationInput,
  assertDecisionParity,
  COMPACT_CONTINUATION_CONTRACT_VERSION,
  COMPACT_CONTINUATION_HOST_CAPABILITIES,
  COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE,
  COMPACT_CONTINUATION_INVARIANTS,
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
  COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX,
  COMPACT_CONTINUATION_MARKER_KIND,
  COMPACT_CONTINUATION_OUTCOME_KINDS,
  COMPACT_CONTINUATION_REFUSE_CODES,
  COMPACT_CONTINUATION_SKIP_CODES,
  COMPACT_CONTINUATION_STATES,
  COMPACT_CONTINUATION_TRANSITION_ORDER,
  COMPACT_CONTINUATION_WRITER_CLAIMS,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactContinuationDecision,
  type CompactContinuationEffect,
  type CompactContinuationEffectType,
  type CompactContinuationHostCapability,
  type CompactContinuationInput,
  type CompactContinuationInvariantId,
  type CompactContinuationInvariants,
  type CompactContinuationLowerTargetReceipt,
  type CompactContinuationMarkerSemantics,
  type CompactContinuationOutcomeKind,
  type CompactContinuationPolicy,
  type CompactContinuationPressureReceipt,
  type CompactContinuationReceipt,
  type CompactContinuationRefuseCode,
  type CompactContinuationResidualState,
  type CompactContinuationSeam,
  type CompactContinuationSkipCode,
  type CompactContinuationState,
  type CompactContinuationTransitionStep,
  type CompactMaterialFacts,
  compactContinuationMarkerIdempotencyKey,
  decideCompactContinuation,
  type ForcedContinuationBoundary,
  type LhcRenderedHistoryAccounting,
  type PostMeasurementEstimate,
  type ProviderReportedInputAccounting,
  type ProviderUsageAuthority,
  type SourceLabelledEstimateAccounting,
  type TokenAccountingDomain,
  type ValidationIssue,
  type ValidationResult,
  validateCompactContinuationDecision,
  validateCompactContinuationInput,
  validateCompactContinuationReceipt,
  type WorkContinuation,
  type WriterClaim,
} from "./shared-tech/compact-continuation/index.js";
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
  HostMetadata,
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
  API_BLOCK_TYPES,
  type ApiBlock,
  type ApiBlockType,
  applyDerivationSuccess,
  type BlobLoader,
  type BlobRef,
  blobTokenEstimate,
  createDbReadTransaction,
  createDbWriteTransaction,
  createDeterministicInferenceCallbacks,
  type DbReadTransaction,
  type DbWriteTransaction,
  type DeterministicOpName,
  deterministicOutcomesSuffix,
  deterministicText,
  type ExtractedBlob,
  extractBlobs,
  hasBlobPayload,
  inlineBlobs,
  isApiBlock,
  type PostCommitHook,
  type ProviderProvenance,
  placeholderText,
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
export {
  DEFAULT_PROMPT_NAMES,
  PROMPT_NAMES,
} from "./shared-tech/prompts/index.js";
export {
  billedSignatureTokens,
  FAMILIES_CATALOG,
  type FamiliesFile,
  type FamiliesOverlay,
  type FamilySpec,
  type ModelFamilyMatch,
  mergeFamiliesCatalog,
  type ResolvedTokenFamily,
  resolveTokenFamily,
  TOKEN_ESTIMATOR_ID,
  TokenEstimator,
  type TokenFamily,
  type TokenFamilySource,
  type TokenSlice,
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
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
} from "./thread-view/index.js";
export type {
  CompactPolicy,
  ThreadAliasBinding,
  ThreadAliasLookup,
  ThreadAliasRegistration,
  ThreadAliasResolution,
  ThreadCurrentAlias,
  ThreadCurrentAliasLookup,
  ThreadFileInfo,
  ThreadRef,
} from "./threads/index.js";
export type { ChunkRecord, TurnRecord } from "./turns/index.js";

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

export interface WorkSurface {
  drain(ref: threadsDomain.ThreadRef, opts?: { maxItems?: number }): Promise<OpResult<DrainReport>>;
}

export interface ThreadViewSurface {
  getLlmRequestContext(ref: threadsDomain.ThreadRef): Promise<OpResult<LlmRequestContext>>;
  getSessionThreadView(ref: threadsDomain.ThreadRef): Promise<OpResult<SessionThreadView>>;
  status(ref: threadsDomain.ThreadRef): Promise<OpResult<ViewStatus>>;
  prune(ref: threadsDomain.ThreadRef, params?: { targetTokens?: number }): Promise<OpResult<PruneReceipt>>;
  describe(ref: threadsDomain.ThreadRef): Promise<OpResult<StoredView | null>>;
  hostMetadata(ref: threadsDomain.ThreadRef): Promise<OpResult<HostMetadata>>;
  midTurnCompact(
    ref: threadsDomain.ThreadRef,
    opts: threadViewDomain.MidTurnCompactOptions,
  ): Promise<OpResult<CompactReceipt>>;
  previewCompact(
    ref: threadsDomain.ThreadRef,
    opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
  ): Promise<OpResult<PreviewCompactOutcome>>;
  prepareCompact(
    ref: threadsDomain.ThreadRef,
    opts?: threadViewDomain.PrepareCompactOptions,
  ): Promise<OpResult<threadViewDomain.PreparedCompact>>;
  previewProtectedBoundary(
    ref: threadsDomain.ThreadRef,
    params: {
      protectedToolCallIds: readonly string[];
      targetZoneTokens?: number;
      compactPointOverride?: number;
    },
  ): Promise<OpResult<threadViewDomain.ProtectedBoundaryPreview>>;
  installPreparedCompact(
    ref: threadsDomain.ThreadRef,
    prepared: threadViewDomain.PreparedCompact,
    opts?: threadViewDomain.InstallPreparedOptions,
  ): Promise<OpResult<CompactReceipt>>;
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
  compactContinuation: typeof compactContinuationDomain;
  inspect: typeof inspectDomain;
  logging: LoggingSurface;
  config: ResolvedSdkConfig;
  scheduler: Scheduler;
  work: WorkSurface;
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

const DEFAULT_INFERENCE_LANE = { provider: "codex", model: "gpt-5.4-mini" } as const;

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
    prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression ?? "detailed-turn-compression-v3",
    targetMinRatio: 0.35,
    targetMaxRatio: 0.65,
    targetAimRatio: 0.5,
    thinking: DEFAULT_INFERENCE_THINKING,
  },
  chunk_summary_brief: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v3",
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

  for (const key of Object.keys(provided)) {
    if (!inferenceKeys.has(key)) {
      throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments has unknown derivation type "${key}"`);
    }
  }

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

export function initLhc(config: SdkConfig): Lhc {
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

  if (typeof config.tokenFamily !== "string" || config.tokenFamily.trim() === "") {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: tokenFamily must be a non-empty string`);
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
    view: resolveViewConfig(config.view),
    tokenFamily: config.tokenFamily,
    tokenEstimator: new TokenEstimator(config.tokenFamily, config.tokenFamilies),
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

  const seam: InstanceSeam =
    resolved.mode === "background"
      ? {
          poke: (threadId) => scheduler.poke(threadId),
          touch: (filePath, db) => scheduler.touch(filePath, db),
          view: resolved.view,
          config: resolved,
          tokenEstimator: resolved.tokenEstimator,
          drain: (filePath, opts) => runDrain(filePath, drainDeps, opts),
        }
      : {
          poke: () => {},
          touch: () => {},
          view: resolved.view,
          config: resolved,
          tokenEstimator: resolved.tokenEstimator,
          drain: (filePath, opts) => runDrain(filePath, drainDeps, opts),
        };

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
    threads: scopeSurface(threadsDomain, seam),
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
        hostMetadata: threadViewDomain.hostMetadata,
        midTurnCompact: threadViewDomain.midTurnCompact,
        previewCompact: threadViewDomain.previewCompact,
        prepareCompact: threadViewDomain.prepareCompact,
        previewProtectedBoundary: threadViewDomain.previewProtectedBoundary,
        installPreparedCompact: threadViewDomain.installPreparedCompact,
        compact: threadViewDomain.compact,
        materialize: threadViewDomain.materialize,
      },
      seam,
    ),
    compactContinuation: scopeSurface(compactContinuationDomain, seam),
    inspect: scopeSurface(inspectDomain, seam),
    logging,
    config: resolved,
    scheduler,
    work,
    drainSettled: async (ref) => {
      const resolvedRef = await threadsDomain.resolveThreadRef(ref);
      if (!resolvedRef.ok) return;
      const threadId = peekThreadId(resolvedRef.value.filePath);
      if (threadId === null) return;
      return scheduler.drainSettled(threadId);
    },
  };
  workRegistrationBySdk.set(sdk, { workHandlers, workDispatchers });
  return sdk;
}
