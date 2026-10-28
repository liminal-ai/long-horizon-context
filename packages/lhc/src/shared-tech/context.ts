import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSdkConfig } from "./derivation.js";
import type { OpResult } from "./errors.js";
import type { DrainReport } from "./scheduler.js";
import type { TokenEstimator } from "./token-counting/index.js";
import type { ResolvedViewConfig } from "./view.js";

export interface InstanceSeam {
  poke: (threadId: string) => void;
  touch: (filePath: string, db: DatabaseSync) => void;
  view?: ResolvedViewConfig;
  config?: ResolvedSdkConfig;
  tokenEstimator?: TokenEstimator;
  drain?: (filePath: string, opts?: { maxItems?: number }) => Promise<OpResult<DrainReport>>;
}
const seamStore = new AsyncLocalStorage<InstanceSeam>();

export function runWithInstanceSeam<T>(seam: InstanceSeam, operation: () => T): T {
  return seamStore.run(seam, operation);
}

type SchedulerPoke = (threadId: string) => void;
let schedulerPoke: SchedulerPoke | null = null;

export function setSchedulerPoke(poke: SchedulerPoke | null): void {
  schedulerPoke = poke;
}

type ThreadTouch = (filePath: string, db: DatabaseSync) => void;
let threadTouch: ThreadTouch | null = null;

export function setThreadTouch(touch: ThreadTouch | null): void {
  threadTouch = touch;
}

export function resolveInstancePoke(): (threadId: string) => void {
  const seam = seamStore.getStore();
  if (seam !== undefined) return seam.poke;
  return (threadId) => {
    schedulerPoke?.(threadId);
  };
}

export function resolveInstanceViewConfig(): ResolvedViewConfig | undefined {
  return seamStore.getStore()?.view;
}

export function resolveInstanceConfig(): ResolvedSdkConfig | undefined {
  return seamStore.getStore()?.config;
}

export function resolveInstanceTokenEstimator(domainCall: string): TokenEstimator {
  const estimator = seamStore.getStore()?.tokenEstimator ?? seamStore.getStore()?.config?.tokenEstimator;
  if (estimator !== undefined) return estimator;
  throw new TypeError(`${domainCall} requires an SDK initialised with tokenFamily`);
}

export function resolveInstanceDrain(): InstanceSeam["drain"] {
  return seamStore.getStore()?.drain;
}

export function runWithThreadTouchSuppressed<T>(operation: () => T): T {
  const seam = seamStore.getStore();
  const base: InstanceSeam = seam ?? {
    poke: (threadId) => {
      schedulerPoke?.(threadId);
    },
    touch: (filePath, db) => {
      threadTouch?.(filePath, db);
    },
  };
  return seamStore.run({ ...base, touch: () => {} }, operation);
}

export function fireThreadTouch(filePath: string, db: DatabaseSync): void {
  const seam = seamStore.getStore();
  if (seam !== undefined) {
    seam.touch(filePath, db);
    return;
  }
  threadTouch?.(filePath, db);
}
