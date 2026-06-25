import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { OpResult, SdkConfig, ThreadRef } from "lhc";
import { seedPiSessionFromLhc } from "../launcher/seed-session.js";
import type { ModelDescriptor } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import { durableThreadEntryOf, LHC_THREAD_ENTRY_TYPE } from "./thread-entry.js";

export const LHC_REHYDRATE_COMMAND = "lhc-rehydrate";

export interface RehydrateModelPrefs {
  model: ModelDescriptor | null;
  thinkingLevel: string;
}

interface RehydrateSetupPrefs {
  threadRef: ThreadRef;
  sdkConfig: SdkConfig;
}

let pendingModelPrefs: RehydrateModelPrefs | null = null;
let pendingSetupPrefs: RehydrateSetupPrefs | null = null;

export function setPendingRehydrate(prefs: {
  threadRef: ThreadRef;
  sdkConfig: SdkConfig;
  modelPrefs: RehydrateModelPrefs;
}): void {
  pendingSetupPrefs = { threadRef: prefs.threadRef, sdkConfig: prefs.sdkConfig };
  pendingModelPrefs = prefs.modelPrefs;
}

export function takePendingRehydrateSetup(): RehydrateSetupPrefs | null {
  const setup = pendingSetupPrefs;
  pendingSetupPrefs = null;
  return setup;
}

export function takePendingRehydrateModelPrefs(): RehydrateModelPrefs | null {
  const prefs = pendingModelPrefs;
  pendingModelPrefs = null;
  return prefs;
}

/** Test seam: clear unconsumed rehydrate handoff. */
export function clearPendingRehydrate(): void {
  pendingModelPrefs = null;
  pendingSetupPrefs = null;
}

/** Hydrate a replacement in-memory PI session from the latest LHC thread-view. */
export async function rehydratePiSessionFromLhc(
  instance: LhcInstance,
  threadRef: ThreadRef,
  sessionManager: PiSessionManager,
): Promise<OpResult<{ messageCount: number }>> {
  const seeded = await seedPiSessionFromLhc(instance, threadRef, sessionManager);
  if (!seeded.ok) return seeded;

  const durableEntry = durableThreadEntryOf(threadRef);
  if (durableEntry !== null) {
    sessionManager.appendCustomEntry(LHC_THREAD_ENTRY_TYPE, durableEntry);
  }

  return seeded;
}
