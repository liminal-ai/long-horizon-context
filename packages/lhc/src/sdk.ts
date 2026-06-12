export * as threads from "./domains/threads/index.js";
export * as intakeStream from "./domains/intake-stream/index.js";
export * as messages from "./domains/messages/index.js";
export * as turns from "./domains/turns/index.js";
export * as threadView from "./domains/thread-view/index.js";
export * as inspect from "./domains/inspect/index.js";

import * as inspectDomain from "./domains/inspect/index.js";
import * as intakeStreamDomain from "./domains/intake-stream/index.js";
import * as threadViewDomain from "./domains/thread-view/index.js";
import { resolveViewConfig } from "./domains/thread-view/index.js";
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
import {
  runWithInstanceSeam,
  setSchedulerPoke as installSchedulerPoke,
  setThreadTouch,
  type InstanceSeam,
} from "./shared/context.js";
import {
  PROVIDER_OPERATIONS,
  type ResolvedSdkConfig,
  type SdkConfig,
  type WorkHandler,
} from "./shared/derivation.js";
import type { ErrorResult, OpResult } from "./shared/errors.js";
import type {
  CompactReceipt,
  PullResult,
  StoredView,
  SweepReceipt,
  ViewCompactParams,
  ViewProfile,
  ViewStatus,
} from "./shared/view.js";
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
  deterministicOutcomesSuffix,
  deterministicReceiptsSuffix,
  deterministicText,
  type DeterministicOpName,
} from "./providers/deterministic.js";
export { registeredProviderNames, resolveNamedProvider } from "./providers/registry.js";

export type {
  CompletionTx,
  DependencyGap,
  DerivationProvider,
  DerivedForm,
  DerivedFormMetadata,
  DerivedFormState,
  FormKind,
  FormReportEntry,
  HandlerFormWrite,
  HandlerOutcome,
  HandlerRunContext,
  ProviderResult,
  RenderingPart,
  ResolvedSdkConfig,
  SdkConfig,
  SubjectKind,
  ToolOutcome,
  ToolRunReceipt,
  WorkHandler,
} from "./shared/derivation.js";
export type { DrainReport, Scheduler, SchedulerMode } from "./scheduler.js";

// Epic 03 view vocabulary (shared/view.ts): config shapes live on SdkConfig
// from Story 0; the operation shapes land with Stories 1–5.
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
} from "./domains/thread-view/index.js";
export type {
  Band,
  CompactReceipt,
  PullResult,
  ResolvedViewConfig,
  SdkViewConfig,
  StoredView,
  SweepReceipt,
  ViewCompactParams,
  ViewMessage,
  ViewMeta,
  ViewProfile,
  ViewProfileOverride,
  ViewStatus,
  VisibilityBudgets,
} from "./shared/view.js";
export {
  countLiveItems,
  enqueue,
  queueDetail,
  supersedeQueued,
  type ClaimedWorkItem,
  type EnqueueFormTarget,
  type EnqueueInput,
  type QueueDetailRow,
} from "./tech-utils/work-queue/index.js";

// Epic 04 inspect vocabulary (shared/inspect.ts): the report shapes the
// inspect surface serves.
export type {
  HealthReport,
  InspectOverview,
  ViewContentsReport,
} from "./shared/inspect.js";

export type { ThreadFileInfo, ThreadRef } from "./domains/threads/index.js";
export type {
  Block,
  BlockType,
  MessageDetail,
  MessageListOptions,
  MessageRecord,
  MutationResult,
} from "./domains/messages/index.js";
export type { ChunkRecord, TurnRecord } from "./domains/turns/index.js";
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
    opts: { profile?: string; params?: ViewCompactParams; sweep?: boolean },
  ): Promise<OpResult<CompactReceipt>>;
  sweep(ref: threadsDomain.ThreadRef): Promise<OpResult<SweepReceipt>>;
  materialize(
    ref: threadsDomain.ThreadRef,
    opts: { path: string; format?: "pi-session" },
  ): Promise<OpResult<{ writtenPath: string }>>;
}

export interface Lhc {
  threads: typeof threadsDomain;
  intakeStream: typeof intakeStreamDomain;
  messages: typeof messagesDomain;
  turns: typeof turnsDomain;
  threadView: ThreadViewSurface;
  // Epic 04: the read-only report surface. Scoped through the instance seam
  // like every other namespace so the status read it composes resolves THIS
  // SDK's view config (threshold, visibility budgets).
  inspect: typeof inspectDomain;
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

// Bind a domain surface to one SDK instance's delivery seam (epic-fix-001):
// every operation invoked through sdk.* runs inside runWithInstanceSeam, so
// the poke/touch it triggers deep inside reaches THIS SDK's scheduler
// (background) or a no-op (manual) — never another SDK's. Non-function exports
// (e.g. a domain's workHandlers table) pass through unchanged. The wrapped
// object is the same shape as the namespace, so the public surface type holds.
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
    // Epic 03 (FC-0.2): built-ins merged with user profiles by name, band
    // sums and visibility budgets validated — throws naming the violation.
    view: resolveViewConfig(config.view),
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
        }
      : { poke: () => {}, touch: () => {}, view: resolved.view };

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

  return {
    threads: threadsDomain,
    intakeStream: scopeSurface(intakeStreamDomain, seam),
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
