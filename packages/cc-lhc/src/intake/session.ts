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
  canMutateCapture,
  createCaptureGeneration,
  isCaptureHealthy,
  markCaptureClosed,
  markCaptureReady,
  type CaptureGenerationState,
  type CapturePhase,
} from "../observation/degradation.js";
import { createTurnFoldState, observeWatcherEmission } from "../observation/observe.js";
import { createSamplingDedupeState, type SamplingDedupeState } from "../observation/sampling.js";
import type { LifecycleSignal } from "../observation/types.js";
import { classifyTurnSignal } from "./turn-signal.js";
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
  lineageWriteFailureMessage,
  lookupSessionLineage,
  resolveCaptureThread,
  safeAppendThreadSignatures,
  safeLoadThreadSignatures,
  safeRecordSessionThread,
  type LineageOutcome,
} from "./lineage-db.js";
import { captureThreadRef, defaultRegistryPath, defaultThreadFilePath } from "./paths.js";
import {
  type ContinuityHandle,
  type PrefixBoundary,
  type PrefixBoundaryVerified,
  openContinuityHandle,
  prefixBoundaryNone,
  prefixBoundaryUnknown,
  readFdRange,
  verifyPrefixBoundaryOnHandle,
} from "./prefix-boundary.js";
import { createReplayDedupeState, filterReplayEvents, type ReplayDedupeState } from "./replay-dedupe.js";

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
  flushBatchFn?: typeof flushBatch;
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

async function flushBatch(
  sdk: Lhc,
  threadRef: ThreadRef,
  items: RolloutLineItem[],
  events: MessageEventInput[],
  stats: CaptureStats,
  log: (message: string) => void,
  logError: (message: string) => void,
  dedupeState: ReplayDedupeState | undefined,
  persistSignatures: ((signatures: string[]) => Promise<LineageOutcome>) | undefined,
  onIntakeFailure: (reason: string) => void,
): Promise<void> {
  if (events.length === 0) return;

  const filtered =
    dedupeState === undefined
      ? { toSend: events, skipped: 0, signaturesToAdd: [] as string[] }
      : filterReplayEvents(events, dedupeState);

  if (filtered.skipped > 0) {
    stats.skippedReplay += filtered.skipped;
    log(`cc-lhc replay dedupe: skipped ${filtered.skipped} event(s)`);
  }
  if (filtered.toSend.length === 0) return;

  try {
    const result = await sdk.intakeStream.messageEvents(threadRef, filtered.toSend);
    if (!result.ok) {
      logError(`cc-lhc intake error: ${result.error.code} ${result.error.reason}`);
      onIntakeFailure(`intake_error:${result.error.code}`);
      return;
    }
    const recorded = result.value.events.filter((entry) => entry.outcome === "recorded").length;
    stats.eventsSent += recorded;
    log(`cc-lhc intake batch: ${recorded}/${filtered.toSend.length} recorded`);

    if (dedupeState !== undefined && filtered.signaturesToAdd.length > 0) {
      for (const signature of filtered.signaturesToAdd) {
        dedupeState.seen.add(signature);
      }
      if (persistSignatures !== undefined) {
        const outcome = await persistSignatures(filtered.signaturesToAdd);
        if (!outcome.ok) {
          onIntakeFailure(outcome.reason);
        }
      }
    }
  } catch (cause) {
    logError(`cc-lhc intake threw: ${detail(cause)}`);
    onIntakeFailure(`intake_threw:${detail(cause)}`);
  }
  void items;
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

  const enqueueEmissions = (emissions: WatcherEmission[]): Promise<void> => {
    batchQueue = batchQueue
      .then(async () => {
        // After stop settles closed, do not process further (closed is terminal).
        if (captureHealth.phase === "closed") return;
        if (intakeHalted) return;
        if (stopped && emissions.length === 0) return;
        const items: RolloutLineItem[] = [];
        const intakeEvents: MessageEventInput[] = [];
        for (const emission of emissions) {
          stats.linesSeen += 1;

          const lineIndex = lineCounter;
          lineCounter += 1;

          // Live suffix only: full folds + runtime lifecycle. Prefix was
          // validated separately without mutating these folds.
          const observeOpts: Parameters<typeof observeWatcherEmission>[2] = {
            samplingDedupe,
            generation: captureHealth.generation,
            turnFold,
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

          const lifecycleToPublish: LifecycleSignal[] = [];
          const pendingMismatches: LifecycleSignal[] = [];
          for (const signal of observed.lifecycle) {
            if (signal.kind === "capture_degraded") {
              if (degradeQuiet(signal.reason)) {
                lifecycleToPublish.push(...pendingMismatches, signal);
              }
              pendingMismatches.length = 0;
            } else if (signal.kind === "session_mismatch_observed") {
              // Observation emits this immediately before its paired
              // capture_degraded. Publish both only when that reason is new.
              pendingMismatches.push(signal);
            } else {
              lifecycleToPublish.push(signal);
            }
          }
          publishLifecycle(lifecycleToPublish);

          if (emission.kind === "parse_error") {
            stats.parseFailures += 1;
            logError(`cc-lhc parse fail: ${emission.error}`);
            continue;
          }

          stats.skippedSidechain += observed.stats.sidechain;
          stats.skippedUnknown += observed.stats.unknown;
          stats.skippedMeta += observed.stats.meta;
          stats.skippedImage += observed.stats.image;
          intakeEvents.push(...observed.events);
          items.push(emission.item);
        }

        if (intakeEvents.length === 0 || sdk === undefined || threadRef === undefined) return;
        await flush(
          sdk,
          threadRef,
          items,
          intakeEvents,
          stats,
          log,
          logError,
          dedupeState,
          persistSignatures,
          (reason) => degradeAndEmit(reason),
        );
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
          deps.discoverDeps?.readFileFn !== undefined
            ? { readFileFn: deps.discoverDeps.readFileFn }
            : {};
        await assertRolloutMatchesExpectedSession(
          deps.knownRolloutPath,
          expectedSession.sessionId,
          assertDeps,
        );
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
          ...(deps.discoverDeps?.projectsRoot === undefined
            ? {}
            : { projectsRoot: deps.discoverDeps.projectsRoot }),
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
          const loaded = safeLoadThreadSignatures(
            lineageDbPath,
            continuedThreadId,
            logError,
            deps.lineageDeps,
          );
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
