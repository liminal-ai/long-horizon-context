import { basename } from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type OpResult,
  type SdkConfig,
  type ThreadRef,
  threads,
} from "lhc";
import type { CaptureCommandContext } from "../commands/dispatch.js";
import { deliveredResultKeys } from "../continuity/delivery.js";
import { CAPTURE_VIEW_CONFIG } from "../governor/band-allocation.js";
import { ccAssignments } from "../inference/assignments.js";
import { claudeCliModelCall } from "../inference/claude-cli.js";
import {
  type AsyncWorkEvent,
  type AsyncWorkFold,
  createAsyncWorkFold,
  type OpenAsyncWork,
  openAsyncWork,
  seedAsyncWorkFold,
} from "../observation/async-work.js";
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
import {
  createSessionTokenFamilyState,
  formatTokenFamilyChangeLog,
  type SessionTokenFamilyState,
  TOKEN_FAMILY_STICKY_UNTIL_RELAUNCH,
} from "../observation/token-family.js";
import type { LifecycleSignal } from "../observation/types.js";
import {
  assertRolloutMatchesExpectedSession,
  type DiscoverDeps,
  discoverExpectedSessionFile,
  SessionAttributionError,
} from "../rollout/discover.js";
import type { ExpectedSession } from "../rollout/expected-session.js";
import { type ClaudeRuntimeSettings, observeClaudeRuntimeSettings } from "../rollout/runtime-settings.js";
import type { RolloutLineItem, WatcherEmission } from "../rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../rollout/watcher.js";
import { type CaptureStats, emptyCaptureStats } from "../stats.js";
import {
  bindCaptureThread,
  defaultLineageDbPath,
  type LaunchClass,
  type LineageDbDeps,
  type LineageOutcome,
  lookupSessionLineage,
  safeAppendThreadSignatures,
  safeLoadThreadSignatures,
  safeRecordSessionThread,
} from "./lineage-db.js";
import {
  type ChainStep,
  createRolloutChain,
  foldRolloutChain,
  liveAncestry,
  rewindRollbackEvent,
  rolloutKeyPrefix,
} from "./map.js";
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
import {
  createSegmentFoldState,
  foldSegmentLine,
  type SegmentCandidate,
  type SegmentEndReason,
  segmentEndEvent,
} from "./segment-fold.js";
import { classifyTurnSignal } from "./turn-signal.js";
import { identifyUnlinkedRebuild, possibleResumeTargets, unlinkedRebuildGuidance } from "./unlinked-rebuild.js";

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
export const CAPTURE_DEGRADED_REFUSAL = "capture degraded — mutation refused until restart/reconciliation";
export const CAPTURE_NOT_READY_REFUSAL = "capture not ready — binding incomplete";

export function isInferenceDisabled(): boolean {
  return process.env.CC_LHC_NO_INFERENCE === "1";
}

export function captureSdkConfig(options: { noInference?: boolean; tokenFamily: string }): SdkConfig {
  if (options.noInference === true || isInferenceDisabled()) {
    return {
      mode: "manual",
      tokenFamily: options.tokenFamily,
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      view: CAPTURE_VIEW_CONFIG,
    };
  }
  return {
    mode: "background",
    tokenFamily: options.tokenFamily,
    inference: {
      call: claudeCliModelCall,
      assignments: ccAssignments(),
      timeoutMs: DEFAULT_INFERENCE_TIMEOUT_MS,
    },
    view: CAPTURE_VIEW_CONFIG,
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

export interface LaunchThreadBinding {
  threadId: string;
  createdAtLaunch: boolean;
}

export interface ContinueCapture {
  threadRef: ThreadRef;
  sdk: Lhc;
  stats: CaptureStats;
  priorGeneration?: number;
}

export interface CaptureSessionDeps {
  cwd?: string;
  registryPath?: string;
  discoverDeps?: DiscoverDeps;
  startedAt?: Date;
  noInference?: boolean;
  continueCapture?: ContinueCapture;
  launchThread?: LaunchThreadBinding;
  expectedSession?: ExpectedSession;
  knownRolloutPath?: string;
  prefixBoundary?: PrefixBoundary;
  replayedPrefixLines?: number;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  suppressBindLineageRecord?: boolean;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  flushBatchFn?: (
    ...args: Parameters<typeof flushBatch>
  ) => ReturnType<typeof flushBatch> | Promise<void> | Promise<boolean> | boolean;
  initSdkFn?: (config: SdkConfig) => Lhc;
  onLifecycle?: (signals: readonly LifecycleSignal[]) => void;
  onAsyncWorkEvent?: (event: AsyncWorkEvent, threadId: string) => void;
  seedAsyncWork?: (threadId: string) => readonly OpenAsyncWork[];
  onResultDelivery?: (launchIds: readonly string[], threadId: string) => void;
  tokenFamily?: SessionTokenFamilyState;
  onRuntimeSettings?: (settings: Readonly<ClaudeRuntimeSettings>) => void;
  segmentThresholdTokens?: () => number;
  generationSeed?: number;
  watcherIo?: Partial<import("../rollout/watcher.js").WatcherIo>;
  watchRolloutFileFn?: typeof watchRolloutFile;
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
  isCaptureHealthy(): boolean;
  isCaptureReady(): boolean;
  getCaptureHealth(): CaptureGenerationState;
  getCaptureGeneration(): number;
  getLiveAsyncWork(): OpenAsyncWork[];
  getTokenFamily(): SessionTokenFamilyState;
  closeSettledSegment(): Promise<SettledSegmentClose>;
  stop(): Promise<void>;
}

export type SettledSegmentClose = { kind: "closed" | "skipped" | "failed"; detail: string };

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

export type IntakeEventOutcome = {
  idempotencyKey: string;
  outcome: "recorded" | "skipped";
};

export type FlushBatchResult = { ok: true; eventOutcomes: IntakeEventOutcome[] } | { ok: false };

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

function normalizeFlushResult(
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

export function startCaptureSession(deps: CaptureSessionDeps = {}): CaptureSession {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? (() => {});
  const logError =
    deps.logError ??
    ((message: string) => {
      console.error(message);
    });
  const flush = deps.flushBatchFn ?? flushBatch;
  const registryPath = deps.registryPath ?? defaultRegistryPath();
  const lineageDbPath = deps.lineageDbPath ?? defaultLineageDbPath();
  const stats = emptyCaptureStats();
  const abort = new AbortController();
  const samplingDedupe: SamplingDedupeState = createSamplingDedupeState();
  const turnFold = createTurnFoldState();
  const segmentFold = createSegmentFoldState();
  const estimateFold: PostMeasurementEstimateFold = createPostMeasurementEstimateFold();
  const tokenFamily = deps.tokenFamily ?? createSessionTokenFamilyState();
  const noteFamilyChange = (previous: SessionTokenFamilyState["resolved"]): void => {
    if (tokenFamily.modelId === null) return;
    log(
      `${formatTokenFamilyChangeLog(previous, tokenFamily.resolved, tokenFamily.modelId)}; ${TOKEN_FAMILY_STICKY_UNTIL_RELAUNCH}`,
    );
  };
  const asyncWorkFold: AsyncWorkFold = createAsyncWorkFold((event) => {
    const onAsyncWorkEvent = deps.onAsyncWorkEvent;
    if (onAsyncWorkEvent === undefined) return;
    const threadId = threadRef === undefined ? "" : threadIdFromRef(threadRef);
    if (threadId === "") return;
    try {
      onAsyncWorkEvent(event, threadId);
    } catch (cause) {
      logError(`cc-lhc continuity: async-work subscriber threw: ${detail(cause)}`);
    }
  });
  let reportedAsyncDiagnostics = 0;
  const seedCarriedWork = (): void => {
    if (deps.seedAsyncWork === undefined || threadRef === undefined) return;
    const threadId = threadIdFromRef(threadRef);
    if (threadId === "") return;
    try {
      const added = seedAsyncWorkFold(asyncWorkFold, deps.seedAsyncWork(threadId));
      if (added > 0) log(`cc-lhc continuity: ${added} carried item(s) seeded for thread ${threadId}`);
    } catch (cause) {
      logError(`cc-lhc continuity: carried work not seeded for thread ${threadId}: ${detail(cause)}`);
    }
  };
  const userOnLifecycle = deps.onLifecycle;
  let resolvedPrefix: PrefixBoundary =
    deps.prefixBoundary ??
    (deps.replayedPrefixLines !== undefined && deps.replayedPrefixLines > 0
      ? { kind: "unknown" as const }
      : prefixBoundaryNone());
  const hadExplicitBoundary = deps.prefixBoundary !== undefined;

  let expectedSession: ExpectedSession | undefined = deps.expectedSession;
  if (expectedSession === undefined && deps.knownRolloutPath !== undefined) {
    expectedSession = {
      sessionId: basename(deps.knownRolloutPath, ".jsonl"),
      source: "rebuilt_handoff",
    };
  }

  let sdk: Lhc | undefined;
  let threadRef: ThreadRef | undefined;
  let watcher: RolloutWatcher | undefined;
  let rolloutFilePath: string | undefined;
  let rolloutSessionId: string | undefined;
  let stopped = false;
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
  let runtimeSettings: ClaudeRuntimeSettings = {};
  const chain = createRolloutChain();
  let rewindFloor: number | undefined;

  const publishLifecycle = (signals: readonly LifecycleSignal[]): void => {
    if (userOnLifecycle === undefined || signals.length === 0) return;
    try {
      userOnLifecycle(signals);
    } catch (cause) {
      logError(`cc-lhc lifecycle subscriber threw: ${detail(cause)}`);
      const applied = applyCaptureDegraded(captureHealth, `lifecycle_subscriber:${detail(cause)}`);
      captureHealth = applied.state;
      if (applied.isFirstForKey) {
        logError(`cc-lhc capture degraded (gen ${captureHealth.generation}): lifecycle_subscriber`);
      }
    }
  };

  const degradeQuiet = (reason: string): boolean => {
    const applied = applyCaptureDegraded(captureHealth, reason);
    captureHealth = applied.state;
    if (applied.isFirstForKey) {
      logError(`cc-lhc capture degraded (gen ${captureHealth.generation}): ${applied.countKey}`);
    }
    return applied.isFirstForKey;
  };

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

  const readActiveTurnTokens = async (sdkRef: Lhc, ref: ThreadRef): Promise<number | null> => {
    try {
      const metadata = await sdkRef.threadView.hostMetadata(ref);
      if (!metadata.ok) {
        logError(`cc-lhc segment: host metadata ${metadata.error.code}: ${metadata.error.reason}`);
        return null;
      }
      return metadata.value.activeTurn === null ? 0 : metadata.value.activeTurn.estimatedTokens;
    } catch (cause) {
      logError(`cc-lhc segment: host metadata threw: ${detail(cause)}`);
      return null;
    }
  };

  const appendCanonicalEnd = async (
    sdkRef: Lhc,
    ref: ThreadRef,
    lineUuid: string,
    reason: SegmentEndReason,
  ): Promise<boolean> => {
    const end = segmentEndEvent(lineUuid, reason);
    const result = normalizeFlushResult(
      (await flush(sdkRef, ref, [], [end], stats, log, logError, dedupeState, persistSignatures, (why) =>
        degradeAndEmit(why),
      )) as FlushBatchResult | boolean | undefined,
      [end],
    );
    if (!result.ok) return false;
    const outcome = result.eventOutcomes[0]?.outcome ?? "skipped";
    if (outcome === "recorded") stats.segmentEnds = (stats.segmentEnds ?? 0) + 1;
    log(`cc-lhc segment: ${reason} ${outcome} (line ${lineUuid})`);
    return true;
  };

  // A rewind past every live keyed record (the session root, or a rebuilt
  // prefix whose lines carry no capture keys) keeps what the thread held at bind.
  const resolveRewindAnchor = async (sdkRef: Lhc, ref: ThreadRef, keptUuid: string | null): Promise<number | null> => {
    for (const uuid of liveAncestry(chain, keptUuid)) {
      let keepThrough = -1;
      let cursor: string | null = null;
      do {
        const page = await sdkRef.intakeStream.listEventKeysByPrefix(ref, {
          prefix: rolloutKeyPrefix(uuid),
          ...(cursor === null ? {} : { cursor }),
        });
        if (!page.ok) {
          logError(`cc-lhc rewind: key lookup ${page.error.code}: ${page.error.reason}`);
          return null;
        }
        if (page.value.capExhausted) return null;
        for (const key of page.value.keys) keepThrough = Math.max(keepThrough, key.eventOrder);
        cursor = page.value.cursor;
      } while (cursor !== null);
      if (keepThrough >= 0) return keepThrough;
    }
    return rewindFloor ?? null;
  };

  const appendRewindRollback = async (
    sdkRef: Lhc,
    ref: ThreadRef,
    step: Extract<ChainStep, { kind: "rewind" }>,
  ): Promise<void> => {
    const keepThrough = await resolveRewindAnchor(sdkRef, ref, step.keptUuid);
    if (keepThrough === null) {
      degradeAndEmit("rewind_anchor:unresolved");
      return;
    }
    const event = rewindRollbackEvent(step.hopUuid, keepThrough);
    const result = normalizeFlushResult(
      (await flush(sdkRef, ref, [], [event], stats, log, logError, dedupeState, persistSignatures, (why) =>
        degradeAndEmit(why),
      )) as FlushBatchResult | boolean | undefined,
      [event],
    );
    if (!result.ok) return;
    log(
      `cc-lhc rewind: ${step.hopUuid} returns to ${step.keptUuid ?? "the session root"}; ` +
        `rollback keeps through event ${keepThrough} (${result.eventOutcomes[0]?.outcome ?? "skipped"})`,
    );
  };

  const enqueueEmissions = (emissions: WatcherEmission[]): Promise<void> => {
    batchQueue = batchQueue
      .then(async () => {
        if (captureHealth.phase === "closed") return;
        if (intakeHalted) return;
        if (stopped && emissions.length === 0) return;

        type LineWork = {
          healthSignals: LifecycleSignal[];
          ordinaryImmediate: LifecycleSignal[];
          samplingEmitted: boolean;
          deferredPressure: readonly LifecycleSignal[];
          wouldPostMeasurementAdd: boolean;
          toSend: MessageEventInput[];
          eventStart: number;
          eventCount: number;
          fullyReplayDropped: boolean;
        };

        const lineWork: LineWork[] = [];
        const batchEvents: MessageEventInput[] = [];
        const batchSignatures: string[] = [];
        const batchItems: RolloutLineItem[] = [];

        const partitionLifecycle = (
          lifecycle: readonly LifecycleSignal[],
        ): { healthSignals: LifecycleSignal[]; ordinaryImmediate: LifecycleSignal[] } => {
          const healthSignals: LifecycleSignal[] = [];
          const ordinaryImmediate: LifecycleSignal[] = [];
          const pendingMismatches: LifecycleSignal[] = [];
          for (const signal of lifecycle) {
            if (signal.kind === "capture_degraded") {
              if (degradeQuiet(signal.reason)) {
                healthSignals.push(...pendingMismatches, signal);
              }
              pendingMismatches.length = 0;
            } else if (signal.kind === "session_mismatch_observed") {
              pendingMismatches.push(signal);
            } else {
              ordinaryImmediate.push(signal);
            }
          }
          return { healthSignals, ordinaryImmediate };
        };

        const publishLineImmediate = (work: LineWork): void => {
          if (work.healthSignals.length > 0) publishLifecycle(work.healthSignals);
          if (work.ordinaryImmediate.length > 0) publishLifecycle(work.ordinaryImmediate);
        };

        let commitFailed = false;
        const resetBatch = (): void => {
          lineWork.length = 0;
          batchEvents.length = 0;
          batchSignatures.length = 0;
          batchItems.length = 0;
        };

        const commitBatch = async (): Promise<IntakeEventOutcome[] | null> => {
          if (sdk === undefined || threadRef === undefined) {
            for (const work of lineWork) {
              publishLineImmediate(work);
            }
            resetBatch();
            return [];
          }

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
            const flushResult = normalizeFlushResult(rawFlush as FlushBatchResult | boolean | undefined, batchEvents);
            if (!flushResult.ok) {
              for (const work of lineWork) {
                publishLineImmediate(work);
              }
              commitFailed = true;
              resetBatch();
              return null;
            }
            if (flushResult.eventOutcomes.length !== batchEvents.length) {
              logError(
                `cc-lhc intake outcome map invalid: expected ${batchEvents.length} event outcome(s), got ${flushResult.eventOutcomes.length}`,
              );
              degradeAndEmit("intake_outcome_map:length_mismatch");
              for (const work of lineWork) {
                publishLineImmediate(work);
              }
              commitFailed = true;
              resetBatch();
              return null;
            }
            for (let i = 0; i < batchEvents.length; i += 1) {
              if (flushResult.eventOutcomes[i]!.idempotencyKey !== batchEvents[i]!.idempotencyKey) {
                logError(`cc-lhc intake outcome map invalid: key mismatch at index ${i}`);
                degradeAndEmit("intake_outcome_map:key_mismatch");
                for (const work of lineWork) {
                  publishLineImmediate(work);
                }
                commitFailed = true;
                resetBatch();
                return null;
              }
            }
            eventOutcomes = flushResult.eventOutcomes;
          } else {
            eventOutcomes = [];
          }

          for (const work of lineWork) {
            publishLineImmediate(work);

            if (work.fullyReplayDropped) {
              continue;
            }

            const lineOutcomes =
              work.eventCount === 0 ? [] : eventOutcomes.slice(work.eventStart, work.eventStart + work.eventCount);
            const recordedEvents = work.toSend.filter((_event, i) => lineOutcomes[i]?.outcome === "recorded");
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
              const add = postMeasurementAddFromAcceptedEvents(recordedEvents, tokenFamily.estimator);
              if (add !== null) pressureSignals.push(add);
            }
            for (const signal of work.deferredPressure) {
              if (signal.kind === "turn_settled") {
                pressureSignals.push(signal);
              }
            }
            publishLifecycle(pressureSignals);
          }
          const committed = eventOutcomes;
          resetBatch();
          return committed;
        };

        const appendSegmentEnd = async (candidate: SegmentCandidate): Promise<void> => {
          if (sdk === undefined || threadRef === undefined) return;
          let reason: SegmentEndReason;
          if (candidate.kind === "completion") {
            reason = "cc_lhc_completion";
          } else {
            const threshold = deps.segmentThresholdTokens?.();
            if (threshold === undefined) return;
            const tokens = await readActiveTurnTokens(sdk, threadRef);
            if (tokens === null || tokens < threshold) return;
            reason = "cc_lhc_segment";
          }
          await appendCanonicalEnd(sdk, threadRef, candidate.lineUuid, reason);
        };

        const processEmissions = async (): Promise<void> => {
          for (const emission of emissions) {
            stats.linesSeen += 1;

            const lineIndex = lineCounter;
            lineCounter += 1;

            const observeOpts: Parameters<typeof observeWatcherEmission>[2] = {
              samplingDedupe,
              generation: captureHealth.generation,
              turnFold,
              estimateFold,
              asyncWorkFold,
              deferPressureLifecycle: true,
              tokenFamily,
            };
            if (expectedSession !== undefined) {
              observeOpts.expectedSessionId = expectedSession.sessionId;
            }
            const previousFamily = tokenFamily.resolved;
            const previousModel = tokenFamily.modelId;
            const observed = observeWatcherEmission(emission, lineIndex, observeOpts);
            if (tokenFamily.modelId !== previousModel) noteFamilyChange(previousFamily);

            let segmentCandidate: SegmentCandidate | null = null;
            let chainStep: ChainStep = { kind: "append" };
            if (emission.kind === "line") {
              chainStep = foldRolloutChain(chain, emission.item, true);
              const turnSignal = classifyTurnSignal(emission.item);
              if (turnSignal === "opens") turnOpen = true;
              if (turnSignal === "closes") turnOpen = false;
              segmentCandidate = foldSegmentLine(segmentFold, emission.item, lineIndex, observed.events);
            }

            const { healthSignals, ordinaryImmediate } = partitionLifecycle(observed.lifecycle);
            const samplingEmitted = ordinaryImmediate.some((s) => s.kind === "sampling_observed");

            if (emission.kind === "parse_error") {
              stats.parseFailures += 1;
              logError(`cc-lhc parse fail: ${emission.error}`);
              lineWork.push({
                healthSignals,
                ordinaryImmediate,
                samplingEmitted: false,
                deferredPressure: [],
                wouldPostMeasurementAdd: false,
                toSend: [],
                eventStart: batchEvents.length,
                eventCount: 0,
                fullyReplayDropped: false,
              });
              continue;
            }

            const nextRuntimeSettings = observeClaudeRuntimeSettings(runtimeSettings, emission.item);
            if (nextRuntimeSettings !== runtimeSettings) {
              runtimeSettings = nextRuntimeSettings;
              deps.onRuntimeSettings?.({ ...runtimeSettings });
            }
            if (deps.onResultDelivery !== undefined && threadRef !== undefined) {
              const deliveredKeys = deliveredResultKeys(emission.item);
              const deliveryThreadId = threadIdFromRef(threadRef);
              if (deliveredKeys.length > 0 && deliveryThreadId !== "") {
                try {
                  deps.onResultDelivery(deliveredKeys, deliveryThreadId);
                } catch (cause) {
                  logError(`cc-lhc continuity: result-delivery subscriber threw: ${detail(cause)}`);
                }
              }
            }

            stats.skippedSidechain += observed.stats.sidechain;
            stats.skippedUnknown += observed.stats.unknown;
            stats.skippedMeta += observed.stats.meta;
            stats.skippedImage += observed.stats.image;

            if (sdk === undefined || threadRef === undefined) {
              lineWork.push({
                healthSignals,
                ordinaryImmediate,
                samplingEmitted,
                deferredPressure: observed.deferredPressure,
                wouldPostMeasurementAdd: false,
                toSend: [],
                eventStart: batchEvents.length,
                eventCount: 0,
                fullyReplayDropped: false,
              });
              continue;
            }

            if (chainStep.kind === "rewind" && !commitFailed) {
              if ((await commitBatch()) !== null) await appendRewindRollback(sdk, threadRef, chainStep);
            }

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

            if (observed.events.length > 0 && filtered.toSend.length === 0) {
              lineWork.push({
                healthSignals,
                ordinaryImmediate,
                samplingEmitted,
                deferredPressure: observed.deferredPressure,
                wouldPostMeasurementAdd: false,
                toSend: [],
                eventStart: batchEvents.length,
                eventCount: 0,
                fullyReplayDropped: true,
              });
              continue;
            }

            const eventStart = batchEvents.length;
            batchEvents.push(...filtered.toSend);
            batchSignatures.push(...filtered.signaturesToAdd);
            if (emission.kind === "line") {
              batchItems.push(emission.item);
            }
            const work: LineWork = {
              healthSignals,
              ordinaryImmediate,
              samplingEmitted,
              deferredPressure: observed.deferredPressure,
              wouldPostMeasurementAdd: observed.wouldPostMeasurementAdd,
              toSend: filtered.toSend,
              eventStart,
              eventCount: filtered.toSend.length,
              fullyReplayDropped: false,
            };
            lineWork.push(work);

            if (
              segmentCandidate !== null &&
              work.eventCount > 0 &&
              !commitFailed &&
              dedupeState?.replayWindowActive !== true
            ) {
              const outcomes = await commitBatch();
              if (outcomes === null) continue;
              const recorded = outcomes
                .slice(work.eventStart, work.eventStart + work.eventCount)
                .some((outcome) => outcome.outcome === "recorded");
              if (recorded) await appendSegmentEnd(segmentCandidate);
            }
          }

          await commitBatch();
        };
        await processEmissions();
      })
      .catch((cause: unknown) => {
        logError(`cc-lhc batch queue error: ${detail(cause)}`);
        degradeAndEmit(`batch_queue:${detail(cause)}`);
      });
    return batchQueue;
  };

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
      foldRolloutChain(chain, emission.item, false);
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

      if (deps.bindHold !== undefined) {
        await deps.bindHold;
        if (stopped) return;
      }

      if (threadRef === undefined || sdk === undefined) {
        const launchThread = deps.launchThread;
        if (launchThread === undefined) {
          degradeAndEmit("thread_binding:missing_launch_thread");
          logError("cc-lhc: capture started without a launch thread binding — capture degraded");
          return;
        }
        const resolution = await bindCaptureThread({
          sessionId: rolloutSessionId,
          threadId: launchThread.threadId,
          threadCreatedAtLaunch: launchThread.createdAtLaunch,
          launchClass: launchClassOf(expectedSession.source),
          registryPath,
          lineageDbPath,
          log,
          logError,
          onLineageFailure: (reason: string) => degradeAndEmit(reason),
          ...(deps.lineageDeps === undefined ? {} : { lineageDeps: deps.lineageDeps }),
        });
        if (stopped) return;

        threadRef = resolution.threadRef;
        dedupeState = resolution.dedupeState;
        persistSignatures = resolution.persistSignatures;
        if (!hadExplicitBoundary) {
          resolvedPrefix = resolution.prefix;
        }
        stats.threadId = threadIdFromRef(threadRef) || null;
        if (stopped) return;
        sdk = (deps.initSdkFn ?? initLhc)(
          captureSdkConfig({
            tokenFamily: tokenFamily.resolved.family,
            ...(deps.noInference === true ? { noInference: true } : {}),
          }),
        );
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
                resolvedPrefix = prefixBoundaryUnknown();
              }
            } catch {
              resolvedPrefix = prefixBoundaryUnknown();
            }
          }
        }
      }
      if (stopped) return;
      seedCarriedWork();

      let watcherStartOffset = 0;
      if (resolvedPrefix.kind === "unknown") {
        degradeAndEmit("prefix_boundary:unknown_provenance");
        const unlinked = await identifyUnlinkedRebuild({
          rolloutPath: filePath,
          lineageDbPath,
          ...(deps.lineageDeps === undefined ? {} : { lineageDeps: deps.lineageDeps }),
        });
        if (unlinked !== null) {
          const targets = await possibleResumeTargets(unlinked.possibleThreadIds, registryPath, rolloutSessionId);
          logError(unlinkedRebuildGuidance(rolloutSessionId, targets));
          return;
        }
        logError(
          "cc-lhc: unknown prefix provenance — capture refused; " +
            "reconcile by re-running /smart-compact or /smart-prune (verified boundary) or " +
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

      if (sdk !== undefined && threadRef !== undefined) {
        try {
          const frontier = await sdk.intakeStream.threadFrontier(threadRef);
          if (frontier.ok) rewindFloor = frontier.value.lastEventOrder;
        } catch (cause) {
          logError(`cc-lhc rewind: thread frontier unreadable: ${detail(cause)}`);
        }
      }
      if (stopped) {
        continuity.close();
        return;
      }

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
    closeSettledSegment(): Promise<SettledSegmentClose> {
      const run = async (): Promise<SettledSegmentClose> => {
        if (sdk === undefined || threadRef === undefined) return { kind: "skipped", detail: "capture not bound" };
        if (turnOpen) return { kind: "skipped", detail: "native turn open" };
        const lineUuid = segmentFold.lastSettledLineUuid;
        if (lineUuid === null) return { kind: "skipped", detail: "no settled terminal line folded" };
        const tokens = await readActiveTurnTokens(sdk, threadRef);
        if (tokens === null) return { kind: "failed", detail: "host metadata unreadable" };
        if (tokens <= 0) return { kind: "skipped", detail: "canonical turn already closed" };
        const ok = await appendCanonicalEnd(sdk, threadRef, lineUuid, "cc_lhc_settled_catch_up");
        return ok ? { kind: "closed", detail: `line ${lineUuid}` } : { kind: "failed", detail: "intake failed" };
      };
      const result = batchQueue.then(run);
      batchQueue = result.then(
        () => {},
        () => {},
      );
      return result;
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
    getTokenFamily(): SessionTokenFamilyState {
      return tokenFamily;
    },
    getLiveAsyncWork(): OpenAsyncWork[] {
      while (reportedAsyncDiagnostics < asyncWorkFold.diagnostics.length) {
        logError(`cc-lhc async work: ${asyncWorkFold.diagnostics[reportedAsyncDiagnostics]}`);
        reportedAsyncDiagnostics += 1;
      }
      return openAsyncWork(asyncWorkFold);
    },
    stop: async () => {
      stopped = true;
      abort.abort();
      if (watcher !== undefined) watcher.stop();
      const stopStep = async (step: string, run: () => Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (cause) {
          logError(`cc-lhc capture stop (gen ${captureHealth.generation}): ${step} failed: ${detail(cause)}`);
        }
      };
      await stopStep("final flush", async () => {
        await batchQueue;
      });
      const stopSdk = sdk;
      const stopRef = threadRef;
      if (stopSdk !== undefined && stopRef !== undefined && deps.noInference !== true && !isInferenceDisabled()) {
        await stopStep("pending-summary count for stats", async () => {
          const overview = await stopSdk.inspect.overview(stopRef);
          if (overview.ok) {
            stats.derivationsPending = overview.value.derivation.pending;
          }
        });
      }
      captureHealth = markCaptureClosed(captureHealth);
    },
  };
}
