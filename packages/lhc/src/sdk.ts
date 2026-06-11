export * as threads from "./domains/threads/index.js";
export * as intakeStream from "./domains/intake-stream/index.js";
export * as messages from "./domains/messages/index.js";
export * as turns from "./domains/turns/index.js";

import * as intakeStreamDomain from "./domains/intake-stream/index.js";
import * as messagesDomain from "./domains/messages/index.js";
import * as threadsDomain from "./domains/threads/index.js";
import * as turnsDomain from "./domains/turns/index.js";
import {
  createScheduler,
  peekThreadId,
  runDrain,
  type DrainDeps,
  type DrainReport,
  type Scheduler,
} from "./scheduler.js";
import { setSchedulerPoke as installSchedulerPoke, setThreadTouch } from "./shared/context.js";
import {
  PROVIDER_OPERATIONS,
  type ResolvedSdkConfig,
  type SdkConfig,
  type WorkHandler,
} from "./shared/derivation.js";
import type { ErrorResult, OpResult } from "./shared/errors.js";
import type { WorkKind } from "./tech-utils/work-queue/index.js";

export {
  estimateTokens,
  TOKEN_ESTIMATOR_ID,
} from "./tech-utils/token-counting/index.js";

export {
  WORK_KIND_REGISTRY,
  type WorkItemRecord,
  type WorkKind,
  type WorkOwner,
  type WorkSourceRef,
} from "./tech-utils/work-queue/index.js";

export type {
  ErrorClass,
  ErrorCode,
  ErrorResult,
  OpResult,
} from "./shared/errors.js";
export {
  runInTransaction,
  setSchedulerPoke,
  setThreadTouch,
  type OperationContext,
} from "./shared/context.js";

export {
  createDeterministicProvider,
  deterministicText,
  type DeterministicOpName,
} from "./providers/deterministic.js";
export { registeredProviderNames, resolveNamedProvider } from "./providers/registry.js";

export type {
  DependencyGap,
  DerivationProvider,
  DerivedForm,
  DerivedFormMetadata,
  DerivedFormState,
  FormKind,
  HandlerFormWrite,
  HandlerOutcome,
  HandlerRunContext,
  ProviderResult,
  RenderingPart,
  ResolvedSdkConfig,
  SdkConfig,
  SubjectKind,
  ToolOutcome,
  WorkHandler,
} from "./shared/derivation.js";
export type { DrainReport, Scheduler, SchedulerMode } from "./scheduler.js";
export {
  countLiveItems,
  queueDetail,
  supersedeQueued,
  type ClaimedWorkItem,
  type QueueDetailRow,
} from "./tech-utils/work-queue/index.js";

export type { ThreadRef } from "./domains/threads/index.js";
export type {
  Block,
  BlockType,
  MessageRecord,
} from "./domains/messages/index.js";
export type { TurnRecord } from "./domains/turns/index.js";
export type {
  BatchResult,
  EventKind,
  EventRecord,
  MessageEventInput,
} from "./domains/intake-stream/index.js";

// ── SDK assembly (DD-6/DD-7) ─────────────────────────────────────

export type WorkHandlerMap = Partial<Record<WorkKind, WorkHandler>>;

// Merge per-domain handler tables into the one join between the queue's
// opaque kinds and domain code. A kind claimed by two tables is a wiring bug
// (each kind has exactly one owner) and throws at construction.
export function assembleWorkHandlerMap(
  tables: ReadonlyArray<WorkHandlerMap>,
): WorkHandlerMap {
  const map: WorkHandlerMap = {};
  for (const table of tables) {
    for (const [kind, handler] of Object.entries(table)) {
      if (map[kind as WorkKind] !== undefined) {
        throw new TypeError(`work kind "${kind}" registered by more than one domain`);
      }
      map[kind as WorkKind] = handler;
    }
  }
  return map;
}

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
export function lookupWorkHandler(
  map: WorkHandlerMap,
  kind: string,
): OpResult<WorkHandler> {
  const handler = map[kind as WorkKind];
  if (handler === undefined) return unknownWorkKind(kind);
  return { ok: true, value: handler };
}

// The work surface (CLI: lhc work …). Story 1 carries drain; report and
// requeue land in Story 4.
export interface WorkSurface {
  drain(
    ref: threadsDomain.ThreadRef,
    opts?: { maxItems?: number },
  ): Promise<OpResult<DrainReport>>;
}

export interface Lhc {
  threads: typeof threadsDomain;
  intakeStream: typeof intakeStreamDomain;
  messages: typeof messagesDomain;
  turns: typeof turnsDomain;
  config: ResolvedSdkConfig;
  scheduler: Scheduler;
  workHandlers: WorkHandlerMap;
  lookupWorkHandler(kind: string): OpResult<WorkHandler>;
  work: WorkSurface;
  // Resolves when the scheduler has no running or pending drain for the
  // thread (issue 3) — the awaitable for background mode, and a no-op
  // resolve in manual mode.
  drainSettled(ref: threadsDomain.ThreadRef): Promise<void>;
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`createSdk config: ${name} must be a positive number, got ${value}`);
  }
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`createSdk config: ${name} must be a non-negative number, got ${value}`);
  }
}

// The only assembly path: provider, mode, clock, and policy enter here.
// Config mistakes are programmer errors at construction and throw; operating
// failures after construction return OpResults per the error contract.
export function createSdk(config: SdkConfig): Lhc {
  if (config.mode !== "background" && config.mode !== "manual") {
    throw new TypeError(
      `createSdk config: mode must be "background" or "manual", got ${JSON.stringify(config.mode)}`,
    );
  }
  if (config.provider === null || typeof config.provider !== "object") {
    throw new TypeError("createSdk config: provider must implement DerivationProvider");
  }
  for (const operation of PROVIDER_OPERATIONS) {
    if (typeof config.provider[operation] !== "function") {
      throw new TypeError(`createSdk config: provider is missing operation ${operation}`);
    }
  }

  const resolved: ResolvedSdkConfig = {
    provider: config.provider,
    mode: config.mode,
    clock: config.clock ?? (() => new Date()),
    retry: config.retry ?? { budget: 3, backoffBaseMs: 5000, backoffCapMs: 60000 },
    lease: config.lease ?? { durationMs: 120000 },
    chunkPolicy:
      config.chunkPolicy ?? { targetProjectedTokens: 2200, maxProjectedTokens: 4400 },
  };
  requirePositive(resolved.retry.budget, "retry.budget");
  requireNonNegative(resolved.retry.backoffBaseMs, "retry.backoffBaseMs");
  requireNonNegative(resolved.retry.backoffCapMs, "retry.backoffCapMs");
  if (resolved.retry.backoffCapMs < resolved.retry.backoffBaseMs) {
    throw new TypeError("createSdk config: retry.backoffCapMs must be >= retry.backoffBaseMs");
  }
  requirePositive(resolved.lease.durationMs, "lease.durationMs");
  requirePositive(resolved.chunkPolicy.targetProjectedTokens, "chunkPolicy.targetProjectedTokens");
  if (resolved.chunkPolicy.maxProjectedTokens < resolved.chunkPolicy.targetProjectedTokens) {
    throw new TypeError(
      "createSdk config: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens",
    );
  }

  // Handler maps merge from per-domain contributions at construction (DD-6).
  // The tables are empty until Stories 2–3 land the real handlers; the
  // assembly mechanics are production code from day one.
  const workHandlers = assembleWorkHandlerMap([
    messagesDomain.workHandlers,
    turnsDomain.workHandlers,
  ]);

  const drainDeps: DrainDeps = {
    lookupHandler: (kind) => lookupWorkHandler(workHandlers, kind),
    hasAnyHandler: () => Object.keys(workHandlers).length > 0,
    config: resolved,
  };
  const scheduler = createScheduler(resolved.mode, drainDeps);

  // Background mode wires the scheduler into the process-wide seams: enqueue
  // pokes (DD-5) and thread-file touches (DD-10) reach it from then on, and
  // queueing alone causes processing (AC-1.5). The slots hold one scheduler;
  // constructing a later background SDK supersedes an earlier one (the
  // displaced scheduler's in-memory state was advisory — the rows remain).
  // Manual mode leaves the slots alone: pokes stay no-ops by contract.
  if (resolved.mode === "background") {
    installSchedulerPoke((threadId) => scheduler.poke(threadId));
    setThreadTouch((filePath, db) => scheduler.touch(filePath, db));
  }

  const work: WorkSurface = {
    drain: async (ref, opts) => {
      const resolvedRef = await threadsDomain.resolveThreadRef(ref);
      if (!resolvedRef.ok) return resolvedRef;
      return runDrain(resolvedRef.value.filePath, drainDeps, opts);
    },
  };

  return {
    threads: threadsDomain,
    intakeStream: intakeStreamDomain,
    messages: messagesDomain,
    turns: turnsDomain,
    config: resolved,
    scheduler,
    workHandlers,
    lookupWorkHandler: (kind) => lookupWorkHandler(workHandlers, kind),
    work,
    drainSettled: async (ref) => {
      const resolvedRef = await threadsDomain.resolveThreadRef(ref);
      if (!resolvedRef.ok) return; // nothing can be scheduled for an unresolvable ref
      const threadId = peekThreadId(resolvedRef.value.filePath);
      if (threadId === null) return;
      return scheduler.drainSettled(threadId);
    },
  };
}
