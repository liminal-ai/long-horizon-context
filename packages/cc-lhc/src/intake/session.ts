import { basename } from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  inspect,
  type Lhc,
  type MessageEventInput,
  type OpResult,
  type SdkConfig,
  type ThreadRef,
  threads,
} from "lhc";
import type { CaptureCommandContext } from "../commands/dispatch.js";
import { ccAssignments } from "../inference/assignments.js";
import { claudeCliModelCall } from "../inference/claude-cli.js";
import {
  applyCaptureDegraded,
  type CaptureGenerationState,
  type CapturePhase,
  canMutateCapture,
  createCaptureGeneration,
  isCaptureHealthy,
  markCaptureClosed,
  markCaptureReady,
} from "../observation/degradation.js";
import { createPostMeasurementEstimateFold, type PostMeasurementEstimateFold } from "../observation/estimate.js";
import {
  createTurnFoldState,
  observeWatcherEmission,
  postMeasurementAddFromAcceptedEvents,
} from "../observation/observe.js";
import { createSamplingDedupeState, type SamplingDedupeState } from "../observation/sampling.js";
import type { LifecycleSignal } from "../observation/types.js";
import {
  assertRolloutMatchesExpectedSession,
  type DiscoverDeps,
  discoverExpectedSessionFile,
  SessionAttributionError,
} from "../rollout/discover.js";
import type { ExpectedSession } from "../rollout/expected-session.js";
import type { RolloutLineItem, WatcherEmission } from "../rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../rollout/watcher.js";
import { type CaptureStats, emptyCaptureStats } from "../stats.js";
import {
  defaultLineageDbPath,
  type LaunchClass,
  type LineageDbDeps,
  type LineageOutcome,
  lookupSessionLineage,
  resolveCaptureThread,
  safeAppendThreadSignatures,
  safeLoadThreadSignatures,
  safeRecordSessionThread,
} from "./lineage-db.js";
import { captureThreadRef, defaultRegistryPath, defaultThreadFilePath } from "./paths.js";
import {
  type ContinuityHandle,
  openContinuityHandle,
  type PrefixBoundary,
  type PrefixBoundaryVerified,
  prefixBoundaryNone,
  prefixBoundaryUnknown,
  readFdRange,
  verifyPrefixBoundaryOnHandle,
} from "./prefix-boundary.js";
import {
  createReplayDedupeState,
  eventContentSignature,
  filterReplayEvents,
  type ReplayDedupeState,
} from "./replay-dedupe.js";
import { classifyTurnSignal } from "./turn-signal.js";

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_DRAIN_SETTLED_CAP_MS = 30_000;
export const DRAIN_NOT_SETTLED_MESSAGE = "cc-lhc: drain not settled at exit, work remains pending";
export const CAPTURE_DEGRADED_REFUSAL = "capture degraded — mutation refused until restart/reconciliation";
export const CAPTURE_NOT_READY_REFUSAL = "capture not ready — binding incomplete";

export function isInferenceDisabled(): boolean {
  return process.env.CC_LHC_NO_INFERENCE === "1";
}

export function captureSdkConfig(options: { noInference?: boolean } = {}): SdkConfig {
  if (options.noInference === true || isInferenceDisabled()) {
    return {
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    };
  }
  return {
    mode: "background",
    inference: {
      call: claudeCliModelCall,
      assignments: ccAssignments(),
      timeoutMs: DEFAULT_INFERENCE_TIMEOUT_MS,
    },
  };
}

export function defaultThreadTitle(cwd: string): string {
  const leaf = basename(cwd);
  if (leaf !== "") return leaf;
  return cwd !== "" ? cwd : "cc-lhc session";
}

export async function createCaptureThread(
  cwd: string,
  registryPath: string = defaultRegistryPath(),
): Promise<OpResult<ThreadRef>> {
  const created = await threads.newThread({
    filePath: defaultThreadFilePath(),
    cwd,
    title: defaultThreadTitle(cwd),
    registryPath,
  });
  if (!created.ok) return created;
  return {
    ok: true,
    value: captureThreadRef(created.value.threadId, registryPath),
  };
}

export interface ContinueCapture {
  threadRef: ThreadRef;
  sdk: Lhc;
  stats: CaptureStats;
  /**
   * During handoff the SDK continues but binding restarts for the new rollout.
   * Health from the prior generation is not auto-carried as ready.
   */
  priorGeneration?: number;
}

export interface CaptureSessionDeps {
  cwd?: string;
  registryPath?: string;
  discoverDeps?: DiscoverDeps;
  startedAt?: Date;
  noInference?: boolean;
  continueCapture?: ContinueCapture;
  resumeSessionId?: string;
  continueFlag?: boolean;
  expectedSession?: ExpectedSession;
  knownRolloutPath?: string;
  /**
   * Explicit content-verifiable prefix fence (tests / in-process handoff).
   * When omitted, lineage supplies provenance after resolve.
   */
  prefixBoundary?: PrefixBoundary;
  /** @deprecated Prefer prefixBoundary; count-only is not content-verifiable. */
  replayedPrefixLines?: number;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  /**
   * In-wrapper handoff: do NOT persist the session→thread lineage row at bind.
   * Canonical success lineage is written by the wrapper only after the
   * generation is proven ready-after-replay; the pending capability
   * (thread/sdk/prefix) is passed directly instead of trusted from a row.
   */
  suppressBindLineageRecord?: boolean;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /**
   * Test seam: substitute intake flush. Production returns `FlushBatchResult`.
   * Legacy injectors may return void (success, all recorded) or false (failure).
   */
  flushBatchFn?: (
    ...args: Parameters<typeof flushBatch>
  ) => ReturnType<typeof flushBatch> | Promise<void> | Promise<boolean> | boolean;
  initSdkFn?: (config: SdkConfig) => Lhc;
  drainSettledCapMs?: number;
  createThreadFn?: typeof createCaptureThread;
  onLifecycle?: (signals: readonly LifecycleSignal[]) => void;
  /** Generation id seed (tests / restart counters). */
  generationSeed?: number;
  /** Test seam: injectable watcher I/O (fstat/read failures). */
  watcherIo?: Partial<import("../rollout/watcher.js").WatcherIo>;
  /** Test seam: substitute watchRolloutFile. */
  watchRolloutFileFn?: typeof watchRolloutFile;
  /**
   * Test seam: delay during bind before/around lineage resolution so stop()
   * can win ownership. Resolves when the test releases it.
   */
  bindHold?: Promise<void>;
}

export interface RolloutCaptureInfo {
  path: string | undefined;
  sessionId: string | undefined;
}

export interface CaptureCommandContextExtended extends CaptureCommandContext {
  captureDegraded: boolean;
  captureGeneration: number;
  capturePhase: CapturePhase;
}

export interface CaptureSession {
  stats: CaptureStats;
  getCommandContext(): CaptureCommandContextExtended;
  getRolloutInfo(): RolloutCaptureInfo;
  isTurnOpen(): boolean;
  /** True only when phase is ready (bound + not degraded). */
  isCaptureHealthy(): boolean;
  /** True when phase is ready (mutation allowed). Binding reports false. */
  isCaptureReady(): boolean;
  getCaptureHealth(): CaptureGenerationState;
  getCaptureGeneration(): number;
  stop(): Promise<void>;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function launchClassOf(source: ExpectedSession["source"]): LaunchClass {
  return source === "fresh" || source === "explicit_new" ? "fresh" : "existing";
}

function normalizeThreadRef(threadRef: ThreadRef, registryPath: string): ThreadRef {
  if ("threadId" in threadRef) {
    return captureThreadRef(threadRef.threadId, "registryPath" in threadRef ? threadRef.registryPath : registryPath);
  }
  return threadRef;
}

function threadIdFromRef(threadRef: ThreadRef): string {
  return "threadId" in threadRef ? threadRef.threadId : "";
}

/** Per-event intake outcome after a successful `messageEvents` call. */
export type IntakeEventOutcome = {
  idempotencyKey: string;
  outcome: "recorded" | "skipped";
};

/**
 * Result of one whole-batch flush. Test injectors may still return void/true
 * (treat as all-recorded success) or false (failure).
 */
export type FlushBatchResult = { ok: true; eventOutcomes: IntakeEventOutcome[] } | { ok: false };

/**
 * Intake already-filtered events into LHC. Callers must run replay filter first
 * and only publish post-measurement estimate / turn_settled after success.
 *
 * Returns `{ ok: false }` when intake fails or the result mapping is invalid
 * (caller must not commit pressure growth). When `events` is empty, returns
 * success with an empty outcome list (no-op).
 *
 * Signatures are persisted only for events whose outcome is `recorded`.
 */
async function flushBatch(
  sdk: Lhc,
  threadRef: ThreadRef,
  _items: RolloutLineItem[],
  events: MessageEventInput[],
  stats: CaptureStats,
  log: (message: string) => void,
  logError: (message: string) => void,
  dedupeState: ReplayDedupeState | undefined,
  persistSignatures: ((signatures: string[]) => Promise<LineageOutcome>) | undefined,
  onIntakeFailure: (reason: string) => void,
  /** Precomputed content signatures for accepted events (order matches `events`). */
  signaturesToAdd: readonly string[] = [],
): Promise<FlushBatchResult> {
  if (events.length === 0) return { ok: true, eventOutcomes: [] };

  try {
    const result = await sdk.intakeStream.messageEvents(threadRef, events);
    if (!result.ok) {
      logError(`cc-lhc intake error: ${result.error.code} ${result.error.reason}`);
      onIntakeFailure(`intake_error:${result.error.code}`);
      return { ok: false };
    }

    const batchEvents = result.value.events;
    if (!Array.isArray(batchEvents) || batchEvents.length !== events.length) {
      logError(
        `cc-lhc intake outcome map invalid: expected ${events.length} event outcome(s), got ${
          Array.isArray(batchEvents) ? batchEvents.length : "non-array"
        }`,
      );
      onIntakeFailure("intake_outcome_map:length_mismatch");
      return { ok: false };
    }

    const eventOutcomes: IntakeEventOutcome[] = [];
    for (let i = 0; i < events.length; i += 1) {
      const input = events[i]!;
      const entry = batchEvents[i]!;
      const key = typeof entry?.idempotencyKey === "string" ? entry.idempotencyKey : "";
      if (key === "" || key !== input.idempotencyKey) {
        logError(
          `cc-lhc intake outcome map invalid: key mismatch at index ${i} (input=${input.idempotencyKey}, result=${key || "<missing>"})`,
        );
        onIntakeFailure("intake_outcome_map:key_mismatch");
        return { ok: false };
      }
      const outcome = entry.outcome === "skipped" ? "skipped" : entry.outcome === "recorded" ? "recorded" : null;
      if (outcome === null) {
        logError(`cc-lhc intake outcome map invalid: bad outcome at index ${i}`);
        onIntakeFailure("intake_outcome_map:bad_outcome");
        return { ok: false };
      }
      eventOutcomes.push({ idempotencyKey: key, outcome });
    }

    const recorded = eventOutcomes.filter((entry) => entry.outcome === "recorded").length;
    stats.eventsSent += recorded;
    log(`cc-lhc intake batch: ${recorded}/${events.length} recorded`);

    // Persist identity only for events whose canonical acceptance is established.
    if (dedupeState !== undefined && signaturesToAdd.length > 0) {
      const recordedSignatures: string[] = [];
      for (let i = 0; i < events.length; i += 1) {
        if (eventOutcomes[i]!.outcome !== "recorded") continue;
        const signature = signaturesToAdd[i];
        if (signature === undefined) continue;
        recordedSignatures.push(signature);
        dedupeState.seen.add(signature);
      }
      if (persistSignatures !== undefined && recordedSignatures.length > 0) {
        const outcome = await persistSignatures(recordedSignatures);
        if (!outcome.ok) {
          onIntakeFailure(outcome.reason);
          // Fail closed for pressure: undurable identity must not arm mutation.
          return { ok: false };
        }
      }
    }
    return { ok: true, eventOutcomes };
  } catch (cause) {
    logError(`cc-lhc intake threw: ${detail(cause)}`);
    onIntakeFailure(`intake_threw:${detail(cause)}`);
    return { ok: false };
  }
}

/**
 * Normalize flushBatchFn / production results for the session queue.
 * - `false` → failure
 * - `void` / `true` → success, all events treated as recorded (legacy test injectors)
 * - `{ ok: false }` → failure
 * - `{ ok: true, eventOutcomes }` → success with explicit outcomes
 */
function normalizeFlushResult(
  // Legacy injectors return void (success); production returns FlushBatchResult.
  result: FlushBatchResult | boolean | undefined | null,
  events: readonly MessageEventInput[],
): FlushBatchResult {
  if (result === false) return { ok: false };
  if (result === undefined || result === null || result === true) {
    return {
      ok: true,
      eventOutcomes: events.map((event) => ({
        idempotencyKey: event.idempotencyKey,
        outcome: "recorded" as const,
      })),
    };
  }
  return result;
}

export async function awaitDrainSettled(
  sdk: Lhc,
  threadRef: ThreadRef,
  options: { capMs?: number; logError?: (message: string) => void } = {},
): Promise<void> {
  const capMs = options.capMs ?? DEFAULT_DRAIN_SETTLED_CAP_MS;
  const logError = options.logError ?? (() => {});
  await Promise.race([
    sdk.drainSettled(threadRef),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        logError(DRAIN_NOT_SETTLED_MESSAGE);
        resolve();
      }, capMs);
    }),
  ]);
}

/** Start capture synchronously; `stop()` is always safe even before discovery resolves. */
export function startCaptureSession(deps: CaptureSessionDeps = {}): CaptureSession {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? (() => {});
  const logError =
    deps.logError ??
    ((message: string) => {
      console.error(message);
    });
  const flush = deps.flushBatchFn ?? flushBatch;
  const createThread = deps.createThreadFn ?? createCaptureThread;
  const registryPath = deps.registryPath ?? defaultRegistryPath();
  const lineageDbPath = deps.lineageDbPath ?? defaultLineageDbPath();
  const stats = emptyCaptureStats();
  const abort = new AbortController();
  const samplingDedupe: SamplingDedupeState = createSamplingDedupeState();
  const turnFold = createTurnFoldState();
  const estimateFold: PostMeasurementEstimateFold = createPostMeasurementEstimateFold();
  const userOnLifecycle = deps.onLifecycle;
  /** Explicit boundary wins; otherwise lineage supplies provenance after resolve. */
  let resolvedPrefix: PrefixBoundary =
    deps.prefixBoundary ??
    (deps.replayedPrefixLines !== undefined && deps.replayedPrefixLines > 0
      ? // Count-only without digest is unknown — never trusted skip.
        { kind: "unknown" as const }
      : prefixBoundaryNone());
  const hadExplicitBoundary = deps.prefixBoundary !== undefined;

  let expectedSession: ExpectedSession | undefined = deps.expectedSession;
  if (expectedSession === undefined && deps.knownRolloutPath !== undefined) {
    expectedSession = {
      sessionId: basename(deps.knownRolloutPath, ".jsonl"),
      source: "rebuilt_handoff",
    };
  }
  if (expectedSession === undefined && deps.resumeSessionId !== undefined) {
    expectedSession = { sessionId: deps.resumeSessionId, source: "explicit_resume" };
  }

  let sdk: Lhc | undefined;
  let threadRef: ThreadRef | undefined;
  let watcher: RolloutWatcher | undefined;
  let rolloutFilePath: string | undefined;
  let rolloutSessionId: string | undefined;
  let stopped = false;
  /** After truncate/rewrite or failed prefix: never feed intake. */
  let intakeHalted = false;
  let batchQueue: Promise<void> = Promise.resolve();
  let lineCounter = 0;
  let turnOpen = false;
  let dedupeState: ReplayDedupeState | undefined;
  let persistSignatures: ((signatures: string[]) => Promise<LineageOutcome>) | undefined;
  const genSeed =
    deps.generationSeed ??
    (deps.continueCapture?.priorGeneration !== undefined ? deps.continueCapture.priorGeneration + 1 : 1);
  let captureHealth: CaptureGenerationState = createCaptureGeneration(genSeed);

  const publishLifecycle = (signals: readonly LifecycleSignal[]): void => {
    if (userOnLifecycle === undefined || signals.length === 0) return;
    try {
      userOnLifecycle(signals);
    } catch (cause) {
      // Lifecycle consumer failure must not poison capture queue or intake.
      logError(`cc-lhc lifecycle subscriber threw: ${detail(cause)}`);
      const applied = applyCaptureDegraded(captureHealth, `lifecycle_subscriber:${detail(cause)}`);
      captureHealth = applied.state;
      if (applied.isFirstForKey) {
        logError(`cc-lhc capture degraded (gen ${captureHealth.generation}): lifecycle_subscriber`);
      }
    }
  };

  /** Latch degradation; log only on first occurrence of the stored key. */
  const degradeQuiet = (reason: string): boolean => {
    const applied = applyCaptureDegraded(captureHealth, reason);
    captureHealth = applied.state;
    if (applied.isFirstForKey) {
      logError(`cc-lhc capture degraded (gen ${captureHealth.generation}): ${applied.countKey}`);
    }
    return applied.isFirstForKey;
  };

  /**
   * Latch degradation and emit capture_degraded only on first occurrence of the
   * stored key (including a single reasons_capped transition after the cap).
   */
  const degradeAndEmit = (reason: string): void => {
    const applied = applyCaptureDegraded(captureHealth, reason);
    captureHealth = applied.state;
    if (applied.isFirstForKey) {
      logError(`cc-lhc capture degraded (gen ${captureHealth.generation}): ${applied.countKey}`);
      publishLifecycle([
        {
          kind: "capture_degraded",
          reason: applied.countKey,
          generation: captureHealth.generation,
        },
      ]);
    }
  };

  /**
   * Process one watcher emission batch serially.
   *
   * Architecture (LIM-64 correctness + batch performance):
   * 1. Observe every line; publish non-pressure lifecycle immediately.
   * 2. Filter replay before submission; fully replay-dropped lines contribute
   *    no estimate/settle (may still have republished sampling_observed/turn-open).
   * 3. Submit all remaining events in ONE `messageEvents` call for the batch
   *    (O(batches), not O(lines)).
   * 4. Map `BatchResult.events` by input order + idempotencyKey; malformed
   *    mapping degrades and publishes no deferred pressure.
   * 5. Publish deferred pressure in original line order; mode:add only from
   *    events accepted as newly recorded (duplicate-idempotency skips do not
   *    count as post-measurement growth).
   */
  const enqueueEmissions = (emissions: WatcherEmission[]): Promise<void> => {
    batchQueue = batchQueue
      .then(async () => {
        // After stop settles closed, do not process further (closed is terminal).
        if (captureHealth.phase === "closed") return;
        if (intakeHalted) return;
        if (stopped && emissions.length === 0) return;

        type LineWork =
          | { kind: "skip_pressure" }
          | {
              kind: "pressure_candidate";
              item: RolloutLineItem | undefined;
              samplingEmitted: boolean;
              deferredPressure: readonly LifecycleSignal[];
              wouldPostMeasurementAdd: boolean;
              toSend: MessageEventInput[];
              signaturesToAdd: string[];
              /** Inclusive start index into the flat batch event array. */
              eventStart: number;
              eventCount: number;
            };

        const lineWork: LineWork[] = [];
        const batchEvents: MessageEventInput[] = [];
        const batchSignatures: string[] = [];
        const batchItems: RolloutLineItem[] = [];

        for (const emission of emissions) {
          stats.linesSeen += 1;

          const lineIndex = lineCounter;
          lineCounter += 1;

          // Live suffix only: full folds + runtime lifecycle. Prefix was
          // validated separately without mutating these folds.
          // deferPressureLifecycle: estimate/settled held until after intake.
          const observeOpts: Parameters<typeof observeWatcherEmission>[2] = {
            samplingDedupe,
            generation: captureHealth.generation,
            turnFold,
            estimateFold,
            deferPressureLifecycle: true,
          };
          if (expectedSession !== undefined) {
            observeOpts.expectedSessionId = expectedSession.sessionId;
          }
          const observed = observeWatcherEmission(emission, lineIndex, observeOpts);

          // Mutation fence turn state folds classifyTurnSignal directly so
          // assistant tool_use state-maintenance keeps isTurnOpen true even
          // when lifecycle does not re-emit turn_opened.
          if (emission.kind === "line") {
            const turnSignal = classifyTurnSignal(emission.item);
            if (turnSignal === "opens") turnOpen = true;
            if (turnSignal === "closes") turnOpen = false;
          }

          // Immediate (non-pressure) lifecycle for THIS line before intake:
          // sampling_observed, turn_opened, native_compact, capture_degraded.
          // Governor must not arm wouldMutate until deferred settle after intake.
          const immediateLifecycle: LifecycleSignal[] = [];
          const pendingMismatches: LifecycleSignal[] = [];
          for (const signal of observed.lifecycle) {
            if (signal.kind === "capture_degraded") {
              if (degradeQuiet(signal.reason)) {
                immediateLifecycle.push(...pendingMismatches, signal);
              }
              pendingMismatches.length = 0;
            } else if (signal.kind === "session_mismatch_observed") {
              pendingMismatches.push(signal);
            } else {
              immediateLifecycle.push(signal);
            }
          }
          publishLifecycle(immediateLifecycle);

          if (emission.kind === "parse_error") {
            stats.parseFailures += 1;
            logError(`cc-lhc parse fail: ${emission.error}`);
            lineWork.push({ kind: "skip_pressure" });
            continue;
          }

          stats.skippedSidechain += observed.stats.sidechain;
          stats.skippedUnknown += observed.stats.unknown;
          stats.skippedMeta += observed.stats.meta;
          stats.skippedImage += observed.stats.image;

          if (sdk === undefined || threadRef === undefined) {
            lineWork.push({ kind: "skip_pressure" });
            continue;
          }

          const samplingEmitted = observed.lifecycle.some((s) => s.kind === "sampling_observed");
          const filtered =
            dedupeState === undefined
              ? {
                  toSend: observed.events,
                  skipped: 0,
                  signaturesToAdd: observed.events.map((e) => eventContentSignature(e)),
                }
              : filterReplayEvents(observed.events, dedupeState);

          if (filtered.skipped > 0) {
            stats.skippedReplay += filtered.skipped;
            log(`cc-lhc replay dedupe: skipped ${filtered.skipped} event(s)`);
          }

          // Fully replay-dropped: zero estimate/settle. Immediate lifecycle
          // (including sampling_observed / turn_opened) already published.
          if (observed.events.length > 0 && filtered.toSend.length === 0) {
            lineWork.push({ kind: "skip_pressure" });
            continue;
          }

          const eventStart = batchEvents.length;
          batchEvents.push(...filtered.toSend);
          batchSignatures.push(...filtered.signaturesToAdd);
          if (emission.kind === "line") {
            batchItems.push(emission.item);
          }
          lineWork.push({
            kind: "pressure_candidate",
            item: emission.kind === "line" ? emission.item : undefined,
            samplingEmitted,
            deferredPressure: observed.deferredPressure,
            wouldPostMeasurementAdd: observed.wouldPostMeasurementAdd,
            toSend: filtered.toSend,
            signaturesToAdd: filtered.signaturesToAdd,
            eventStart,
            eventCount: filtered.toSend.length,
          });
        }

        if (sdk === undefined || threadRef === undefined) return;

        // Empty mapped events only (meta/sidechain chrome with deferred settle):
        // no intake call; still allow deferred set/settle for those candidates.
        const needsIntake = batchEvents.length > 0;
        let eventOutcomes: IntakeEventOutcome[] | null = null;
        if (needsIntake) {
          const rawFlush = await flush(
            sdk,
            threadRef,
            batchItems,
            batchEvents,
            stats,
            log,
            logError,
            dedupeState,
            persistSignatures,
            (reason) => degradeAndEmit(reason),
            batchSignatures,
          );
          // `flushBatchFn` may return void (legacy injectors).
          const flushResult = normalizeFlushResult(rawFlush as FlushBatchResult | boolean | undefined, batchEvents);
          if (!flushResult.ok) {
            // Failed or malformed intake: publish no deferred pressure from this batch.
            return;
          }
          // Extra guard: injector-supplied outcomes must still align by length/key.
          if (flushResult.eventOutcomes.length !== batchEvents.length) {
            logError(
              `cc-lhc intake outcome map invalid: expected ${batchEvents.length} event outcome(s), got ${flushResult.eventOutcomes.length}`,
            );
            degradeAndEmit("intake_outcome_map:length_mismatch");
            return;
          }
          for (let i = 0; i < batchEvents.length; i += 1) {
            if (flushResult.eventOutcomes[i]!.idempotencyKey !== batchEvents[i]!.idempotencyKey) {
              logError(`cc-lhc intake outcome map invalid: key mismatch at index ${i}`);
              degradeAndEmit("intake_outcome_map:key_mismatch");
              return;
            }
          }
          eventOutcomes = flushResult.eventOutcomes;
        } else {
          eventOutcomes = [];
        }

        // Publish deferred pressure in original line order after successful intake.
        for (const work of lineWork) {
          if (work.kind !== "pressure_candidate") continue;

          const lineOutcomes =
            work.eventCount === 0 ? [] : eventOutcomes.slice(work.eventStart, work.eventStart + work.eventCount);
          const recordedEvents = work.toSend.filter((_event, i) => lineOutcomes[i]?.outcome === "recorded");
          // A line that submitted events but recorded none is a pure skip
          // (duplicate idempotency). Do not publish set/settle/add for it —
          // skipped outcomes are not new post-measurement growth.
          if (work.eventCount > 0 && recordedEvents.length === 0) {
            continue;
          }

          const pressureSignals: LifecycleSignal[] = [];
          for (const signal of work.deferredPressure) {
            if (signal.kind === "post_measurement_estimate" && signal.mode !== "add") {
              pressureSignals.push(signal);
            }
          }
          if (work.wouldPostMeasurementAdd && !work.samplingEmitted && recordedEvents.length > 0) {
            const add = postMeasurementAddFromAcceptedEvents(recordedEvents);
            if (add !== null) pressureSignals.push(add);
          }
          for (const signal of work.deferredPressure) {
            if (signal.kind === "turn_settled") {
              pressureSignals.push(signal);
            }
          }
          publishLifecycle(pressureSignals);
        }
      })
      .catch((cause: unknown) => {
        logError(`cc-lhc batch queue error: ${detail(cause)}`);
        degradeAndEmit(`batch_queue:${detail(cause)}`);
      });
    return batchQueue;
  };

  /**
   * Content-verify a rebuilt prefix on a held continuity handle (no path
   * re-open), parse for attribution only, then hand the same handle to the
   * watcher so proof and watch share file identity.
   */
  const establishVerifiedPrefix = (
    handle: ContinuityHandle,
    boundary: PrefixBoundaryVerified,
  ): { ok: true; startOffset: number } | { ok: false; reason: string } => {
    const verified = verifyPrefixBoundaryOnHandle(handle, boundary);
    if (!verified.ok) return verified;

    let prefixRaw: string;
    try {
      prefixRaw = readFdRange(handle.fd, 0, boundary.byteLength).toString("utf8");
    } catch (cause) {
      return { ok: false, reason: `prefix_boundary:validate_read:${detail(cause)}` };
    }
    if (boundary.byteLength > 0 && prefixRaw.length === 0 && boundary.lineCount > 0) {
      return { ok: false, reason: "prefix_boundary:validate_read:empty" };
    }
    const lines =
      boundary.byteLength === 0
        ? []
        : prefixRaw.endsWith("\n")
          ? prefixRaw.slice(0, -1).split("\n")
          : prefixRaw.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      let emission: WatcherEmission;
      try {
        emission = { kind: "line", item: JSON.parse(raw) as RolloutLineItem, raw };
      } catch (cause) {
        return {
          ok: false,
          reason: `prefix_boundary:malformed_line:${detail(cause)}`,
        };
      }
      const observed = observeWatcherEmission(emission, i, {
        generation: captureHealth.generation,
        suppressRuntimeLifecycle: true,
        ...(expectedSession !== undefined ? { expectedSessionId: expectedSession.sessionId } : {}),
      });
      for (const signal of observed.lifecycle) {
        if (signal.kind === "capture_degraded") {
          return { ok: false, reason: `prefix_boundary:degraded:${signal.reason}` };
        }
        if (signal.kind === "session_mismatch_observed") {
          return {
            ok: false,
            reason: `prefix_boundary:session_mismatch:${signal.observed}`,
          };
        }
      }
    }
    stats.replayedPrefixLines = boundary.lineCount;
    lineCounter = boundary.lineCount;
    return { ok: true, startOffset: boundary.byteLength };
  };

  if (deps.continueCapture !== undefined) {
    threadRef = normalizeThreadRef(deps.continueCapture.threadRef, registryPath);
    sdk = deps.continueCapture.sdk;
    Object.assign(stats, deps.continueCapture.stats);
    stats.threadId = threadIdFromRef(threadRef) || stats.threadId;
    // Handoff continues SDK but remains binding until new rollout is attributed.
    captureHealth = createCaptureGeneration(genSeed);
  }

  void (async () => {
    try {
      if (expectedSession === undefined) {
        degradeAndEmit("discovery_conflict:missing_expected_session");
        logError("cc-lhc: expectedSession required for capture bind — capture degraded");
        return;
      }

      let filePath: string;
      if (deps.knownRolloutPath !== undefined) {
        const assertDeps =
          deps.discoverDeps?.readFileFn !== undefined ? { readFileFn: deps.discoverDeps.readFileFn } : {};
        await assertRolloutMatchesExpectedSession(deps.knownRolloutPath, expectedSession.sessionId, assertDeps);
        filePath = deps.knownRolloutPath;
      } else {
        filePath = await discoverExpectedSessionFile(cwd, expectedSession.sessionId, {
          ...deps.discoverDeps,
          signal: abort.signal,
        });
      }
      if (stopped) return;

      if (basename(filePath, ".jsonl") !== expectedSession.sessionId) {
        throw new SessionAttributionError(
          "conflict",
          `bound path ${filePath} does not match expected ${expectedSession.sessionId}`,
        );
      }

      rolloutFilePath = filePath;
      rolloutSessionId = expectedSession.sessionId;
      log(`cc-lhc rollout: ${filePath} (expected session ${expectedSession.sessionId})`);

      // Single ownership gate for initial and continued bind: stop during this
      // await wins before SDK init, lineage writes, continuity open, or watcher.
      if (deps.bindHold !== undefined) {
        await deps.bindHold;
        if (stopped) return;
      }

      if (threadRef === undefined || sdk === undefined) {
        const resolution = await resolveCaptureThread({
          sessionId: rolloutSessionId,
          cwd,
          launchClass: launchClassOf(expectedSession.source),
          ...(deps.resumeSessionId === undefined ? {} : { resumeSessionId: deps.resumeSessionId }),
          ...(deps.continueFlag === undefined ? {} : { continueFlag: deps.continueFlag }),
          registryPath,
          lineageDbPath,
          ...(deps.discoverDeps?.projectsRoot === undefined ? {} : { projectsRoot: deps.discoverDeps.projectsRoot }),
          log,
          logError,
          onLineageFailure: (reason) => degradeAndEmit(reason),
          ...(deps.lineageDeps === undefined ? {} : { lineageDeps: deps.lineageDeps }),
          createThreadFn: createThread,
        });
        if (stopped) return;

        threadRef = resolution.threadRef;
        dedupeState = resolution.dedupeState;
        persistSignatures = resolution.persistSignatures;
        // Durable prefix provenance from lineage when caller did not pass one
        // (external process-exit resume of a rebuilt session).
        if (!hadExplicitBoundary) {
          resolvedPrefix = resolution.prefix;
        }
        stats.threadId = threadIdFromRef(threadRef) || null;
        if (stopped) return;
        sdk = (deps.initSdkFn ?? initLhc)(captureSdkConfig(deps.noInference === true ? { noInference: true } : {}));
      } else {
        const continuedThreadId = threadIdFromRef(threadRef);
        if (continuedThreadId !== "") {
          if (deps.suppressBindLineageRecord !== true) {
            const recorded = await safeRecordSessionThread(
              lineageDbPath,
              rolloutSessionId,
              continuedThreadId,
              logError,
              deps.lineageDeps,
            );
            if (stopped) return;
            if (!recorded.ok) degradeAndEmit(recorded.reason);
          }
          const loaded = safeLoadThreadSignatures(lineageDbPath, continuedThreadId, logError, deps.lineageDeps);
          if (stopped) return;
          if (!loaded.outcome.ok) degradeAndEmit(loaded.outcome.reason);
          dedupeState = createReplayDedupeState(true, loaded.signatures);
          persistSignatures = async (added) => {
            const outcome = await safeAppendThreadSignatures(
              lineageDbPath,
              continuedThreadId,
              added,
              logError,
              deps.lineageDeps,
            );
            if (!outcome.ok) degradeAndEmit(outcome.reason);
            return outcome;
          };
          log(`cc-lhc: continuing thread ${continuedThreadId} for session ${rolloutSessionId}`);
          if (!hadExplicitBoundary) {
            try {
              const entry = lookupSessionLineage(lineageDbPath, rolloutSessionId, deps.lineageDeps);
              if (entry !== undefined) {
                resolvedPrefix = entry.prefix;
              } else {
                // Continue path without a target row: always unknown for
                // non-explicit provenance (do not invent none).
                resolvedPrefix = prefixBoundaryUnknown();
              }
            } catch {
              resolvedPrefix = prefixBoundaryUnknown();
            }
          }
        }
      }
      if (stopped) return;

      // --- Prefix provenance gate (before any skip / watcher start) ---
      let watcherStartOffset = 0;
      if (resolvedPrefix.kind === "unknown") {
        degradeAndEmit("prefix_boundary:unknown_provenance");
        logError(
          "cc-lhc: unknown prefix provenance — capture refused; " +
            "reconcile by re-running compact/prune (verified boundary) or " +
            "explicitly establishing known-none for a native session",
        );
        return;
      }

      let continuity: ContinuityHandle | undefined;
      try {
        if (stopped) return;
        continuity = openContinuityHandle(filePath);
      } catch (cause) {
        degradeAndEmit(`prefix_boundary:open_failed:${detail(cause)}`);
        return;
      }
      if (stopped) {
        continuity.close();
        return;
      }

      if (resolvedPrefix.kind === "verified") {
        log(
          `cc-lhc: verifying rebuilt-prefix fence lines=${resolvedPrefix.lineCount} ` +
            `bytes=${resolvedPrefix.byteLength} for ${rolloutSessionId}`,
        );
        const established = establishVerifiedPrefix(continuity, resolvedPrefix);
        if (!established.ok) {
          continuity.close();
          degradeAndEmit(established.reason);
          return;
        }
        if (stopped) {
          continuity.close();
          return;
        }
        watcherStartOffset = established.startOffset;
        log(
          `cc-lhc: prefix verified; watcher starts at byte ${watcherStartOffset} ` +
            `(skipped ${resolvedPrefix.lineCount} line(s))`,
        );
      }

      if (stopped) {
        continuity.close();
        return;
      }

      // Ownership transfer: only assign watcher after construction succeeds.
      // Continuity handle is owned by the watcher thereafter.
      // Verified prefix: transfer the already-proven persisted digest — watcher
      // must not re-read [0, startOffset) to invent a new baseline.
      const watchFn = deps.watchRolloutFileFn ?? watchRolloutFile;
      let constructed: RolloutWatcher;
      try {
        constructed = watchFn({
          continuity,
          startOffset: watcherStartOffset,
          ...(watcherStartOffset > 0 && resolvedPrefix.kind === "verified"
            ? { expectedConsumedDigest: resolvedPrefix.sha256 }
            : {}),
          ...(deps.watcherIo === undefined ? {} : { io: deps.watcherIo }),
          onBatch: (emissions) => enqueueEmissions(emissions),
          onBufferCap: (message) => {
            logError(`cc-lhc watcher: ${message}`);
            degradeAndEmit(`buffer_cap:${message}`);
          },
          onInitialFailure: (message) => {
            logError(`cc-lhc watcher initial: ${message}`);
          },
          onFileShrink: (message) => {
            intakeHalted = true;
            degradeAndEmit(`file_shrink:${message}`);
          },
          onContinuityFailure: (message) => {
            intakeHalted = true;
            degradeAndEmit(`file_continuity:${message}`);
          },
          onRuntimeFailure: (message) => {
            intakeHalted = true;
            degradeAndEmit(`watcher_runtime:${message}`);
          },
        });
      } catch (cause) {
        continuity.close();
        degradeAndEmit(`watcher_construct:${detail(cause)}`);
        return;
      }
      if (stopped) {
        constructed.stop();
        return;
      }
      watcher = constructed;

      try {
        await watcher.initialCatchUp;
      } catch (cause) {
        if (stopped) return;
        degradeAndEmit(`initial_catchup:${detail(cause)}`);
        return;
      }
      await batchQueue;
      if (stopped) return;
      if (intakeHalted) return;
      if (captureHealth.phase === "binding") {
        captureHealth = markCaptureReady(captureHealth, lineCounter);
        publishLifecycle([{ kind: "session_bound", sessionId: expectedSession.sessionId }]);
        log(`cc-lhc capture ready (gen ${captureHealth.generation}, durableLine=${lineCounter})`);
      }
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (cause instanceof SessionAttributionError) {
        degradeAndEmit(`discovery_conflict:${cause.code}:${cause.message}`);
      } else {
        degradeAndEmit(`discover_failed:${detail(cause)}`);
      }
      logError(`cc-lhc discover failed: ${detail(cause)}`);
    }
  })();

  return {
    stats,
    getCommandContext(): CaptureCommandContextExtended {
      return {
        captureDisabled: false,
        stats,
        sdk,
        threadRef,
        captureDegraded: captureHealth.phase === "degraded",
        captureGeneration: captureHealth.generation,
        capturePhase: captureHealth.phase,
      };
    },
    getRolloutInfo(): RolloutCaptureInfo {
      return { path: rolloutFilePath, sessionId: rolloutSessionId };
    },
    isTurnOpen(): boolean {
      return turnOpen;
    },
    isCaptureHealthy(): boolean {
      return isCaptureHealthy(captureHealth);
    },
    isCaptureReady(): boolean {
      return canMutateCapture(captureHealth);
    },
    getCaptureHealth(): CaptureGenerationState {
      return {
        ...captureHealth,
        reasons: [...captureHealth.reasons],
      };
    },
    getCaptureGeneration(): number {
      return captureHealth.generation;
    },
    stop: async () => {
      stopped = true;
      abort.abort();
      if (watcher !== undefined) watcher.stop();
      // Final flush and queue settlement may still degrade; closed is applied last.
      await batchQueue;
      if (sdk !== undefined && threadRef !== undefined && deps.noInference !== true && !isInferenceDisabled()) {
        let drainTimedOut = false;
        await awaitDrainSettled(sdk, threadRef, {
          ...(deps.drainSettledCapMs === undefined ? {} : { capMs: deps.drainSettledCapMs }),
          logError: (message) => {
            drainTimedOut = true;
            logError(message);
          },
        });
        if (drainTimedOut) {
          try {
            await sdk.intakeStream.messageEvents(threadRef, [
              {
                eventKind: "runtime_note",
                idempotencyKey: `cc-lhc:drain-not-settled:${Date.now()}`,
                actor: "system",
                harness: "cc",
                payload: { text: `[capture] ${DRAIN_NOT_SETTLED_MESSAGE}` },
              },
            ]);
          } catch {
            // Best-effort
          }
        }
        const overview = await inspect.overview(threadRef);
        if (overview.ok) {
          stats.derivationsPending = overview.value.derivation.pending;
        }
      }
      // Terminal: no further phase transitions after stop() resolves.
      captureHealth = markCaptureClosed(captureHealth);
    },
  };
}
