import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

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

import { mapRolloutLine } from "./map.js";
import { discoverSessionFile, type DiscoverDeps } from "../rollout/discover.js";
import type { RolloutLineItem } from "../rollout/types.js";
import { watchRolloutFile, type RolloutWatcher } from "../rollout/watcher.js";
import type { WatcherEmission } from "../rollout/types.js";
import { type CaptureStats, emptyCaptureStats } from "../stats.js";

const DEFAULT_LHC_DIR = join(homedir(), ".lhc");

export function defaultThreadFilePath(): string {
  const dir = join(DEFAULT_LHC_DIR, "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_DRAIN_SETTLED_CAP_MS = 30_000;
export const DRAIN_NOT_SETTLED_MESSAGE = "cc-lhc: drain not settled at exit, work remains pending";

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

export async function createCaptureThread(cwd: string, registryPath?: string): Promise<OpResult<ThreadRef>> {
  const created = await threads.newThread({
    filePath: defaultThreadFilePath(),
    cwd,
    title: defaultThreadTitle(cwd),
    ...(registryPath === undefined ? {} : { registryPath }),
  });
  if (!created.ok) return created;
  return {
    ok: true,
    value: registryPath === undefined ? { threadId: created.value.threadId } : { threadId: created.value.threadId, registryPath },
  };
}

export interface CaptureSessionDeps {
  cwd?: string;
  registryPath?: string;
  discoverDeps?: DiscoverDeps;
  startedAt?: Date;
  noInference?: boolean;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Test hook: replace intake flush to observe batch ordering. */
  flushBatchFn?: typeof flushBatch;
  /** Test hook: substitute SDK construction. */
  initSdkFn?: (config: SdkConfig) => Lhc;
  /** Test hook: cap for drainSettled at stop (default 30s). */
  drainSettledCapMs?: number;
}

export interface CaptureSession {
  stats: CaptureStats;
  stop(): Promise<void>;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function flushBatch(
  sdk: Lhc,
  threadRef: ThreadRef,
  items: RolloutLineItem[],
  stats: CaptureStats,
  log: (message: string) => void,
  logError: (message: string) => void,
  lineOffset: number,
): Promise<void> {
  const events = [];
  for (const [index, item] of items.entries()) {
    const mapped = mapRolloutLine(item, lineOffset + index);
    stats.skippedSidechain += mapped.stats.sidechain;
    stats.skippedUnknown += mapped.stats.unknown;
    stats.skippedMeta += mapped.stats.meta;
    stats.skippedImage += mapped.stats.image;
    events.push(...mapped.events);
  }
  if (events.length === 0) return;

  try {
    const result = await sdk.intakeStream.messageEvents(threadRef, events);
    if (!result.ok) {
      logError(`cc-lhc intake error: ${result.error.code} ${result.error.reason}`);
      return;
    }
    const recorded = result.value.events.filter((entry) => entry.outcome === "recorded").length;
    stats.eventsSent += recorded;
    log(`cc-lhc intake batch: ${recorded}/${events.length} recorded`);
  } catch (cause) {
    logError(`cc-lhc intake threw: ${detail(cause)}`);
  }
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
  const startedAt = deps.startedAt ?? new Date();
  const log = deps.log ?? (() => {});
  const logError = deps.logError ?? ((message: string) => {
    console.error(message);
  });
  const flush = deps.flushBatchFn ?? flushBatch;
  const stats = emptyCaptureStats();
  const abort = new AbortController();

  let sdk: Lhc | undefined;
  let threadRef: ThreadRef | undefined;
  let watcher: RolloutWatcher | undefined;
  let discoverPromise: Promise<void> | undefined;
  let stopped = false;
  let batchQueue: Promise<void> = Promise.resolve();
  let lineCounter = 0;

  const enqueueEmissions = (emissions: WatcherEmission[]): void => {
    batchQueue = batchQueue.then(async () => {
      if (stopped && emissions.length === 0) return;
      const items: RolloutLineItem[] = [];
      for (const emission of emissions) {
        stats.linesSeen += 1;
        if (emission.kind === "parse_error") {
          stats.parseFailures += 1;
          logError(`cc-lhc parse fail: ${emission.error}`);
          continue;
        }
        items.push(emission.item);
      }
      if (items.length === 0 || sdk === undefined || threadRef === undefined) return;
      const lineOffset = lineCounter;
      lineCounter += items.length;
      await flush(sdk, threadRef, items, stats, log, logError, lineOffset);
    });
  };

  void (async () => {
    const threadResult = await createCaptureThread(cwd, deps.registryPath);
    if (!threadResult.ok) {
      logError(`cc-lhc thread create failed: ${threadResult.error.reason}`);
      return;
    }
    if (stopped) return;

    threadRef = threadResult.value;
    stats.threadId = "threadId" in threadRef ? threadRef.threadId : null;
    sdk = (deps.initSdkFn ?? initLhc)(
      captureSdkConfig(deps.noInference === true ? { noInference: true } : {}),
    );

    discoverPromise = discoverSessionFile(cwd, startedAt, { ...deps.discoverDeps, signal: abort.signal })
      .then((filePath) => {
        if (stopped) return;
        log(`cc-lhc rollout: ${filePath}`);
        watcher = watchRolloutFile(filePath, {
          onBatch: (emissions) => {
            enqueueEmissions(emissions);
          },
          onBufferCap: (message) => {
            logError(`cc-lhc watcher: ${message}`);
          },
        });
      })
      .catch((cause) => {
        if (abort.signal.aborted) return;
        logError(`cc-lhc discover failed: ${detail(cause)}`);
      });
  })();

  return {
    stats,
    stop: async () => {
      stopped = true;
      abort.abort();
      if (watcher !== undefined) watcher.stop();
      if (discoverPromise !== undefined) await discoverPromise.catch(() => {});
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
