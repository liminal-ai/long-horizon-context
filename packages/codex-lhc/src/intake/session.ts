import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  inspect,
  type Lhc,
  type OpResult,
  type SdkConfig,
  type ThreadRef,
  threads,
} from "lhc";

import { ccAssignments } from "../inference/assignments.js";
import { claudeCliModelCall } from "../inference/claude-cli.js";
import { type DiscoverDeps, discoverSessionFile, parseRolloutFilename } from "../rollout/discover.js";
import type { RolloutLineItem, WatcherEmission } from "../rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../rollout/watcher.js";
import { type CaptureStats, emptyCaptureStats } from "../stats.js";
import {
  defaultLineageDbPath,
  type LineageDbDeps,
  lineageWriteFailureMessage,
  resolveCaptureThread,
  safeAppendThreadSignatures,
  safeLoadThreadSignatures,
  safeRecordSessionThread,
} from "./lineage-db.js";
import { mapRolloutLine } from "./map.js";
import { captureThreadRef, defaultRegistryPath, defaultThreadFilePath } from "./paths.js";
import { createReplayDedupeState, filterReplayEvents, type ReplayDedupeState } from "./replay-dedupe.js";
import { classifyTurnSignal } from "./turn-signal.js";

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_DRAIN_SETTLED_CAP_MS = 30_000;
export const DRAIN_NOT_SETTLED_MESSAGE = "codex-lhc: drain not settled at exit";

export interface CaptureCommandContext {
  captureDisabled: boolean;
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
}

export function isInferenceDisabled(): boolean {
  return process.env.CODEX_LHC_NO_INFERENCE === "1";
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
  return cwd !== "" ? cwd : "codex-lhc session";
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
}

export interface CaptureSessionDeps {
  cwd?: string;
  registryPath?: string;
  discoverDeps?: DiscoverDeps;
  startedAt?: Date;
  noInference?: boolean;
  continueCapture?: ContinueCapture;
  resumeSessionId?: string;
  resumeLast?: boolean;
  /** Skip discovery and tail this rollout file directly (post-swap handoff). */
  knownRolloutPath?: string;
  /**
   * First N tailed lines are a replayed prefix (the rebuilt rollout after a
   * swap): tally them under stats.replayedPrefixLines instead of linesSeen.
   */
  replayedPrefixLines?: number;
  lineageDbPath?: string;
  lineageDeps?: LineageDbDeps;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Test hook: replace intake flush to observe batch ordering. */
  flushBatchFn?: typeof flushBatch;
  /** Test hook: substitute SDK construction. */
  initSdkFn?: (config: SdkConfig) => Lhc;
  /** Test hook: cap for drainSettled at stop (default 30s). */
  drainSettledCapMs?: number;
  /** Test hook: substitute thread creation. */
  createThreadFn?: typeof createCaptureThread;
}

export interface RolloutCaptureInfo {
  path: string | undefined;
  sessionId: string | undefined;
}

export interface CaptureSession {
  stats: CaptureStats;
  getCommandContext(): CaptureCommandContext;
  getRolloutInfo(): RolloutCaptureInfo;
  /** Whether the tailed rollout says a codex turn is open. */
  isTurnOpen(): boolean;
  stop(): Promise<void>;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function sessionIdFromRolloutPath(filePath: string): string {
  const fromName = parseRolloutFilename(basename(filePath));
  return fromName ?? basename(filePath, ".jsonl");
}

function codexSessionsRoot(discoverDeps: DiscoverDeps | undefined): string {
  const codexHome = discoverDeps?.codexHome ?? join(homedir(), ".codex");
  return join(codexHome, "sessions");
}

async function flushBatch(
  sdk: Lhc,
  threadRef: ThreadRef,
  items: RolloutLineItem[],
  stats: CaptureStats,
  log: (message: string) => void,
  logError: (message: string) => void,
  lineOffset: number,
  dedupeState: ReplayDedupeState | undefined,
  persistSignatures: ((signatures: string[]) => Promise<void>) | undefined,
  replayedPrefixItems: number,
  seenSessionMeta: { value: boolean },
): Promise<void> {
  const events = [];
  for (const [index, item] of items.entries()) {
    if (index < replayedPrefixItems) continue;
    const mapped = mapRolloutLine(item, lineOffset + index);
    stats.skippedSidechain += mapped.stats.sidechain;
    stats.skippedUnknown += mapped.stats.unknown;
    stats.skippedMeta += mapped.stats.meta;
    stats.skippedImage += mapped.stats.image;
    if (mapped.stats.sessionMeta > 0) {
      if (seenSessionMeta.value) {
        stats.embeddedSessionMeta += mapped.stats.sessionMeta;
      }
      seenSessionMeta.value = true;
    }
    events.push(...mapped.events);
  }
  if (events.length === 0) return;

  const filtered =
    dedupeState === undefined
      ? { toSend: events, skipped: 0, signaturesToAdd: [] as string[] }
      : filterReplayEvents(events, dedupeState);

  if (filtered.skipped > 0) {
    stats.skippedReplay += filtered.skipped;
    log(`codex-lhc replay dedupe: skipped ${filtered.skipped} event(s)`);
  }
  if (filtered.toSend.length === 0) return;

  try {
    const result = await sdk.intakeStream.messageEvents(threadRef, filtered.toSend);
    if (!result.ok) {
      logError(`codex-lhc intake error: ${result.error.code} ${result.error.reason}`);
      return;
    }
    const recorded = result.value.events.filter((entry) => entry.outcome === "recorded").length;
    stats.eventsSent += recorded;
    log(`codex-lhc intake batch: ${recorded}/${filtered.toSend.length} recorded`);

    if (dedupeState !== undefined && filtered.signaturesToAdd.length > 0) {
      for (const signature of filtered.signaturesToAdd) {
        dedupeState.seen.add(signature);
      }
      if (persistSignatures !== undefined) {
        try {
          await persistSignatures(filtered.signaturesToAdd);
        } catch (cause) {
          logError(lineageWriteFailureMessage(cause));
        }
      }
    }
  } catch (cause) {
    logError(`codex-lhc intake threw: ${detail(cause)}`);
  }
}

export async function awaitDrainSettled(
  sdk: Lhc,
  threadRef: ThreadRef,
  options: { capMs?: number; logError?: (message: string) => void } = {},
): Promise<void> {
  const capMs = options.capMs ?? DEFAULT_DRAIN_SETTLED_CAP_MS;
  const logError = options.logError ?? (() => {});
  let timedOut = false;
  await Promise.race([
    sdk.drainSettled(threadRef),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, capMs);
    }),
  ]);
  if (!timedOut) return;

  const status = await sdk.threadView.status(threadRef);
  const pending = status.ok ? status.value.derivation.pending + status.value.derivation.retrying : undefined;
  if (pending === 0) return;

  const pendingPart = pending === undefined ? "" : ` (${pending} derivation pending)`;
  logError(`${DRAIN_NOT_SETTLED_MESSAGE}, work remains pending${pendingPart}`);
}

/** Start capture synchronously; `stop()` is always safe even before discovery resolves. */
export function startCaptureSession(deps: CaptureSessionDeps = {}): CaptureSession {
  const cwd = deps.cwd ?? process.cwd();
  const startedAt = deps.startedAt ?? new Date();
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

  let sdk: Lhc | undefined;
  let threadRef: ThreadRef | undefined;
  let watcher: RolloutWatcher | undefined;
  let rolloutFilePath: string | undefined;
  let rolloutSessionId: string | undefined;
  let stopped = false;
  let batchQueue: Promise<void> = Promise.resolve();
  let lineCounter = 0;
  let turnOpen = false;
  let prefixRemaining = deps.replayedPrefixLines ?? 0;
  let dedupeState: ReplayDedupeState | undefined;
  let persistSignatures: ((signatures: string[]) => Promise<void>) | undefined;
  const seenSessionMeta = { value: false };

  const enqueueEmissions = (emissions: WatcherEmission[]): void => {
    batchQueue = batchQueue.then(async () => {
      if (stopped && emissions.length === 0) return;
      const items: RolloutLineItem[] = [];
      let prefixItems = 0;
      for (const emission of emissions) {
        const isPrefixLine = prefixRemaining > 0;
        if (isPrefixLine) {
          prefixRemaining -= 1;
          stats.replayedPrefixLines += 1;
        } else {
          stats.linesSeen += 1;
        }
        if (emission.kind === "parse_error") {
          stats.parseFailures += 1;
          logError(`codex-lhc parse fail: ${emission.error}`);
          continue;
        }
        if (isPrefixLine) prefixItems += 1;
        else {
          const signal = classifyTurnSignal(emission.item);
          if (signal === "opens") turnOpen = true;
          else if (signal === "closes") turnOpen = false;
        }
        items.push(emission.item);
      }
      if (items.length === 0 || sdk === undefined || threadRef === undefined) return;
      const lineOffset = lineCounter;
      lineCounter += items.length;
      await flush(
        sdk,
        threadRef,
        items,
        stats,
        log,
        logError,
        lineOffset,
        dedupeState,
        persistSignatures,
        prefixItems,
        seenSessionMeta,
      );
    });
  };

  if (deps.continueCapture !== undefined) {
    threadRef = normalizeThreadRef(deps.continueCapture.threadRef, registryPath);
    sdk = deps.continueCapture.sdk;
    Object.assign(stats, deps.continueCapture.stats);
    stats.threadId = threadIdFromRef(threadRef) || stats.threadId;
  }

  void (async () => {
    try {
      const discovered =
        deps.knownRolloutPath === undefined
          ? await discoverSessionFile(startedAt, {
              expectedCwd: cwd,
              ...deps.discoverDeps,
              signal: abort.signal,
            })
          : {
              path: deps.knownRolloutPath,
              sessionId: sessionIdFromRolloutPath(deps.knownRolloutPath),
            };
      if (stopped) return;

      rolloutFilePath = discovered.path;
      rolloutSessionId = discovered.sessionId;
      log(`codex-lhc rollout: ${discovered.path}`);

      if (threadRef === undefined || sdk === undefined) {
        const resolution = await resolveCaptureThread({
          sessionId: rolloutSessionId,
          cwd,
          ...(deps.resumeSessionId === undefined ? {} : { resumeSessionId: deps.resumeSessionId }),
          ...(deps.resumeLast === undefined ? {} : { resumeLast: deps.resumeLast }),
          registryPath,
          lineageDbPath,
          sessionsRoot: codexSessionsRoot(deps.discoverDeps),
          log,
          logError,
          ...(deps.lineageDeps === undefined ? {} : { lineageDeps: deps.lineageDeps }),
          createThreadFn: createThread,
        });
        if (stopped) return;

        threadRef = resolution.threadRef;
        dedupeState = resolution.dedupeState;
        persistSignatures = resolution.persistSignatures;
        stats.threadId = threadIdFromRef(threadRef) || null;
        sdk = (deps.initSdkFn ?? initLhc)(captureSdkConfig(deps.noInference === true ? { noInference: true } : {}));
      } else {
        const continuedThreadId = threadIdFromRef(threadRef);
        if (continuedThreadId !== "") {
          await safeRecordSessionThread(lineageDbPath, rolloutSessionId, continuedThreadId, logError, deps.lineageDeps);
          dedupeState = createReplayDedupeState(
            true,
            safeLoadThreadSignatures(lineageDbPath, continuedThreadId, logError, deps.lineageDeps),
          );
          persistSignatures = async (added) => {
            await safeAppendThreadSignatures(lineageDbPath, continuedThreadId, added, logError, deps.lineageDeps);
          };
          log(`codex-lhc: continuing thread ${continuedThreadId} for session ${rolloutSessionId}`);
        }
      }

      watcher = watchRolloutFile(discovered.path, {
        onBatch: (emissions) => {
          enqueueEmissions(emissions);
        },
        onBufferCap: (message) => {
          logError(`codex-lhc watcher: ${message}`);
        },
      });
    } catch (cause) {
      if (abort.signal.aborted) return;
      logError(`codex-lhc discover failed: ${detail(cause)}`);
    }
  })();

  return {
    stats,
    getCommandContext(): CaptureCommandContext {
      return {
        captureDisabled: false,
        stats,
        sdk,
        threadRef,
      };
    },
    getRolloutInfo(): RolloutCaptureInfo {
      return { path: rolloutFilePath, sessionId: rolloutSessionId };
    },
    isTurnOpen(): boolean {
      return turnOpen;
    },
    stop: async () => {
      stopped = true;
      abort.abort();
      if (watcher !== undefined) watcher.stop();
      await batchQueue;
      if (sdk !== undefined && threadRef !== undefined && deps.noInference !== true && !isInferenceDisabled()) {
        await awaitDrainSettled(sdk, threadRef, {
          ...(deps.drainSettledCapMs === undefined ? {} : { capMs: deps.drainSettledCapMs }),
          logError,
        });
        const overview = await inspect.overview(threadRef);
        if (overview.ok) {
          stats.derivationsPending = overview.value.derivation.pending + overview.value.derivation.retrying;
        }
      }
    },
  };
}
