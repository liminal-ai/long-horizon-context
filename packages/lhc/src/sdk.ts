export * as inspect from "./inspect/index.js";
export * as intakeStream from "./intake-stream/index.js";
export * as messages from "./messages/index.js";
export * as logging from "./shared-tech/logging/index.js";
export * as threadView from "./thread-view/index.js";
export * as threads from "./threads/index.js";
export * as turns from "./turns/index.js";

import * as inspectDomain from "./inspect/index.js";
import * as intakeStreamDomain from "./intake-stream/index.js";
import * as messagesDomain from "./messages/index.js";
import { dispatchMessageDeriveWork } from "./messages/internal/derive.js";
import { messageWorkHandlers } from "./messages/internal/handlers.js";
import type {
  CompactReceipt,
  ErrorResult,
  OpResult,
  PullResult,
  StoredView,
  SweepReceipt,
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
// Epic 05 inference vocabulary (shared-tech/inference-types.ts): the host-supplied
// ModelCall boundary and the per-kind assignment config — type-only; the
// adapter and registry are construction internals behind initLhc.
// Epic 04 inspect vocabulary (shared-tech/inspect.ts): the report shapes the
// inspect surface serves.
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
  ModelAssignment,
  ModelCall,
  ModelCallFailureKind,
  ModelCallInput,
  ModelCallResult,
  OpResult,
  ProviderResult,
  PullResult,
  RenderingPart,
  ResolvedSdkConfig,
  ResolvedViewConfig,
  Scheduler,
  SchedulerMode,
  SdkConfig,
  SdkViewConfig,
  StoredView,
  SubjectKind,
  SweepReceipt,
  ToolOutcome,
  ToolRunReceipt,
  ViewCompactParams,
  ViewContentsReport,
  ViewMessage,
  ViewMeta,
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
  createDeterministicProvider,
  type DbReadTransaction,
  type DbWriteTransaction,
  type DeterministicOpName,
  deterministicOutcomesSuffix,
  deterministicReceiptsSuffix,
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
// Epic 03 view vocabulary (shared-tech/view.ts): config shapes live on SdkConfig
// from Story 0; the operation shapes land with Stories 1–5.
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
} from "./thread-view/index.js";
export type { ThreadFileInfo, ThreadRef } from "./threads/index.js";
export type { ChunkRecord, TurnRecord } from "./turns/index.js";

// ── LHC initialization (DD-6/DD-7) ────────────────────────────────

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
// a throw, never a silent undefined (DD-6, AC-1.8's foundation).
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

// The work surface (CLI: lhc work …). Story 1 carries drain; report and
// requeue land in Story 4.
export interface WorkSurface {
  drain(ref: threadsDomain.ThreadRef, opts?: { maxItems?: number }): Promise<OpResult<DrainReport>>;
}

// The thread-view surface as the SDK exposes it (Epic 03, tech design
// §Interface Definitions): the operations only — the Story 0 config
// substrate the domain index also carries is construction machinery, not an
// operation. Epic 04 Story 3 adds `describe`, the stored-snapshot read the
// inspect domain composes (DD-1).
export interface ThreadViewSurface {
  pull(ref: threadsDomain.ThreadRef): Promise<OpResult<PullResult>>;
  status(ref: threadsDomain.ThreadRef): Promise<OpResult<ViewStatus>>;
  describe(ref: threadsDomain.ThreadRef): Promise<OpResult<StoredView | null>>;
  compact(
    ref: threadsDomain.ThreadRef,
    opts: { profile?: string; params?: ViewCompactParams; sweep?: boolean; signal?: { aborted: boolean } },
  ): Promise<OpResult<CompactReceipt>>;
  sweep(ref: threadsDomain.ThreadRef): Promise<OpResult<SweepReceipt>>;
  materialize(
    ref: threadsDomain.ThreadRef,
    opts: { path: string; format?: "pi-session" },
  ): Promise<OpResult<{ writtenPath: string }>>;
}

export interface LoggingSurface {
  write(ref: threadsDomain.ThreadRef, entry: loggingDomain.LogEntry): Promise<OpResult<void>>;
  query(ref: threadsDomain.ThreadRef, q: loggingDomain.LogQuery): Promise<OpResult<loggingDomain.StoredLogEntry[]>>;
}

export type IntakeStreamSurface = typeof intakeStreamDomain & {
  initLhc(config: SdkConfig): Lhc;
};

export interface Lhc {
  threads: typeof threadsDomain;
  intakeStream: IntakeStreamSurface;
  messages: typeof messagesDomain;
  turns: typeof turnsDomain;
  threadView: ThreadViewSurface;
  // Epic 04: the read-only report surface. Scoped through the instance seam
  // like every other namespace so the status read it composes resolves THIS
  // SDK's view config (threshold, visibility budgets).
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

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: ${name} must be a non-negative number, got ${value}`);
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

// The default provider lane and model for inference derivation types (AC-6.4),
// used when the host omits an inference type from inference.assignments
// (AC-6.2). The provider key is an opaque routing key the host's ModelCall
// interprets — LHC never resolves it.
const DEFAULT_INFERENCE_LANE = { provider: "codex", model: "gpt-5.4-mini" } as const;

// Default assignment per inference derivation type (AC-6.2, AC-6.4): the
// documented default lane and model, the registry's default prompt template,
// and the tested target ratios for the compression/brief types. Deterministic
// derivations are not inference assignments. Construction-internal: the defaults are observable
// through routed calls (TC-6.4a), not part of the public export surface.
const DEFAULT_INFERENCE_ASSIGNMENTS: Readonly<Record<string, ModelAssignment>> = {
  smoothed_prompt: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1",
  },
  tool_result_summary: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v1",
  },
  smooth_turn_compression: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression ?? "lower-band-v1",
    targetMinRatio: 0.35,
    targetMaxRatio: 0.65,
    targetAimRatio: 0.5,
  },
  chunk_summary_brief: {
    provider: DEFAULT_INFERENCE_LANE.provider,
    model: DEFAULT_INFERENCE_LANE.model,
    prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v1",
    targetMinRatio: 0.08,
    targetMaxRatio: 0.2,
    targetAimRatio: 0.12,
  },
};

// Resolve the `inference` construction path (Epic 05 Flow 1, DD-5; Epic 07
// Story 0 AC-0.3/6.1–6.4): validate the host function and the assignment map,
// then fill defaults. Provided inference assignments must carry non-empty
// provider/model and a registry-known prompt (AC-6.1). Inference types the host
// omits are filled from DEFAULT_INFERENCE_ASSIGNMENTS (AC-6.2, AC-6.4).
// Unknown keys are rejected — never silently ignored. Then the adapter is built into the same InferenceCallbacks
// slot direct injection uses. No partial construction: every mistake throws
// before anything is assembled (AC-1.1, AC-1.3).
function resolveInferenceCallbacks(inference: InferenceConfig): InferenceCallbacks {
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

  // Validate every provided INFERENCE assignment (AC-6.1): non-empty
  // provider/model/prompt, and the prompt must name a registry template.
  for (const kind of inferenceKeys) {
    const assignment = provided[kind];
    if (assignment === undefined) continue; // filled from defaults below
    if (assignment === null || typeof assignment !== "object") {
      throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments.${kind} must be an object`);
    }
    for (const field of ["provider", "model", "prompt"] as const) {
      const value = assignment[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${INIT_CONFIG_PREFIX}: inference.assignments.${kind}.${field} must be a non-empty string`);
      }
    }
    if (PROMPT_REGISTRY[assignment.prompt] === undefined) {
      throw new TypeError(
        `${INIT_CONFIG_PREFIX}: inference.assignments.${kind}.prompt names unknown template "${assignment.prompt}"`,
      );
    }
  }

  // Merge: inference types default-filled (AC-6.2, AC-6.4).
  const merged: Record<string, ModelAssignment> = {};
  for (const kind of inferenceKeys) {
    const assignment = provided[kind];
    merged[kind] = assignment ?? DEFAULT_INFERENCE_ASSIGNMENTS[kind]!;
  }

  // Guard defaults (AC-6.2, TC-6.2a).
  const resolvedGuards = resolveGuards(inference.guards);

  const timeoutMs = inference.timeoutMs ?? 60_000;
  const maxInputChars = inference.maxInputChars ?? 200_000;
  requirePositive(timeoutMs, "inference.timeoutMs");
  requirePositive(maxInputChars, "inference.maxInputChars");
  return createInferenceCallbacks({
    call: inference.call,
    assignments: merged,
    guards: resolvedGuards,
    timeoutMs,
    maxInputChars,
  });
}

// The only initialization path: inference callbacks, mode, clock, and policy enter here.
// Config mistakes are programmer errors at construction and throw; operating
// failures after construction return OpResults per the error contract.
export function initLhc(config: SdkConfig): Lhc {
  // Inference callbacks arrive by direct injection or by the inference config
  // (Epic 05 DD-5); there is no named inference-callback registry and no env/flag
  // resolution path to fall back on. The XOR rule is validated before anything
  // downstream so the error names the caller's mistake, not a symptom (AC-1.1).
  if (config.inferenceCallbacks !== undefined && config.provider !== undefined) {
    throw new TypeError(
      `${INIT_CONFIG_PREFIX}: inferenceCallbacks and provider are aliases; supply only inferenceCallbacks`,
    );
  }
  const directCallbacks = config.inferenceCallbacks ?? config.provider;
  if (directCallbacks !== undefined && config.inference !== undefined) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference`);
  }
  if (directCallbacks === undefined && config.inference === undefined) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference`);
  }
  if (config.mode !== "background" && config.mode !== "manual") {
    throw new TypeError(
      `${INIT_CONFIG_PREFIX}: mode must be "background" or "manual", got ${JSON.stringify(config.mode)}`,
    );
  }
  let inferenceCallbacks: InferenceCallbacks;
  if (config.inference !== undefined) {
    inferenceCallbacks = resolveInferenceCallbacks(config.inference);
  } else {
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
    provider: inferenceCallbacks,
    mode: config.mode,
    clock: config.clock ?? (() => new Date()),
    retry: config.retry ?? { budget: 3, backoffBaseMs: 5000, backoffCapMs: 60000 },
    smoothing: config.smoothing ?? { maxInferenceTokens: 4000 },
    toolResult: config.toolResult ?? {
      smallTierTokens: 1000,
      largeTierTokens: 5000,
      smallTargetRatio: 0.15,
      midTargetRatio: 0.04,
    },
    lease: config.lease ?? { durationMs: 120000 },
    chunkPolicy: config.chunkPolicy ?? { targetProjectedTokens: 2200, maxProjectedTokens: 4400 },
    // Epic 03 (FC-0.2): built-ins merged with user profiles by name, band
    // sums and visibility budgets validated — throws naming the violation.
    view: resolveViewConfig(config.view),
  };
  requirePositive(resolved.retry.budget, "retry.budget");
  requireNonNegative(resolved.retry.backoffBaseMs, "retry.backoffBaseMs");
  requireNonNegative(resolved.retry.backoffCapMs, "retry.backoffCapMs");
  if (resolved.retry.backoffCapMs < resolved.retry.backoffBaseMs) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: retry.backoffCapMs must be >= retry.backoffBaseMs`);
  }
  requirePositive(resolved.smoothing.maxInferenceTokens, "smoothing.maxInferenceTokens");
  requirePositive(resolved.toolResult.smallTierTokens, "toolResult.smallTierTokens");
  requirePositive(resolved.toolResult.largeTierTokens, "toolResult.largeTierTokens");
  if (resolved.toolResult.largeTierTokens < resolved.toolResult.smallTierTokens) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: toolResult.largeTierTokens must be >= smallTierTokens`);
  }
  requirePositive(resolved.toolResult.smallTargetRatio, "toolResult.smallTargetRatio");
  requirePositive(resolved.toolResult.midTargetRatio, "toolResult.midTargetRatio");
  requirePositive(resolved.lease.durationMs, "lease.durationMs");
  requirePositive(resolved.chunkPolicy.targetProjectedTokens, "chunkPolicy.targetProjectedTokens");
  if (resolved.chunkPolicy.maxProjectedTokens < resolved.chunkPolicy.targetProjectedTokens) {
    throw new TypeError(`${INIT_CONFIG_PREFIX}: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens`);
  }

  // Handler maps merge from per-domain contributions at construction (DD-6).
  const workHandlers = mapWorkQHandlers([messageWorkHandlers, turnWorkHandlers]);
  const workDispatchers: DurableWorkDispatcherMap = {
    "messages.derive": (run, item) => dispatchMessageDeriveWork(run.openDb(), run.config, item),
    "turns.deriveTurn": (run, item) =>
      dispatchTurnOwnedWork(run.openDb(), run.config, { ...item, kind: "turn_derivation" }),
    "turns.deriveDetailedChunk": (run, item) =>
      dispatchTurnOwnedWork(run.openDb(), run.config, { ...item, kind: "chunk_summary_detailed" }),
    "turns.deriveBriefChunk": (run, item) =>
      dispatchTurnOwnedWork(run.openDb(), run.config, { ...item, kind: "chunk_summary_brief" }),
  };

  const drainDeps: DrainDeps = {
    lookupDispatcher: (operation, kind) => lookupWorkDispatcher(workDispatchers, operation, kind),
    hasAnyHandler: () => Object.keys(workDispatchers).length > 0,
    config: resolved,
    openThreadDatabase: threadsDomain.openThreadDatabase,
  };
  const scheduler = createScheduler(resolved.mode, drainDeps);

  // This SDK's per-instance delivery seam (epic-fix-001). Every operation
  // invoked through the scoped surfaces below runs inside it, so enqueue pokes
  // (DD-5) and thread-file touches (DD-10) reach THIS instance's scheduler in
  // background mode, or a no-op in manual mode — isolated from any other SDK
  // alive in the process. A manual SDK therefore never auto-drains, whatever
  // the construction order, because its operations deliver to the no-op seam,
  // not to whatever a background SDK installed below.
  // The seam also carries this instance's resolved view config (Epic 03,
  // tech design Flow 4): thread-view operations invoked through sdk.* read
  // THIS SDK's profiles/budgets/threshold; below-SDK direct domain calls
  // fall back to the built-in defaults inside the thread-view surface.
  const seam: InstanceSeam =
    resolved.mode === "background"
      ? {
          poke: (threadId) => scheduler.poke(threadId),
          touch: (filePath, db) => scheduler.touch(filePath, db),
          view: resolved.view,
          toolResult: resolved.toolResult,
          config: resolved,
        }
      : { poke: () => {}, touch: () => {}, view: resolved.view, toolResult: resolved.toolResult, config: resolved };

  // Background mode also installs the below-SDK default seam so a direct
  // domain call made with no SDK scope — a top-level mutation in the
  // single-background "production path" — still reaches the one installed
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
  };

  const intakeStreamSurface: IntakeStreamSurface = {
    ...intakeStreamDomain,
    initLhc,
  };

  const sdk: Lhc = {
    threads: threadsDomain,
    intakeStream: scopeSurface(intakeStreamSurface, seam),
    messages: scopeSurface(messagesDomain, seam),
    turns: scopeSurface(turnsDomain, seam),
    threadView: scopeSurface<ThreadViewSurface>(
      {
        pull: threadViewDomain.pull,
        status: threadViewDomain.status,
        describe: threadViewDomain.describe,
        compact: threadViewDomain.compact,
        sweep: threadViewDomain.sweep,
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

/** @deprecated Use initLhc. */
export const createSdk = initLhc;
