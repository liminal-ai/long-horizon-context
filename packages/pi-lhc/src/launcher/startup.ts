import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpResult, SdkConfig, ThreadRef } from "lhc";
import { disposeInstance, initInstance } from "../lifecycle/instance.js";
import { pickThread, type ThreadChoice } from "../lifecycle/picker.js";
import { durableThreadEntryOf, LHC_THREAD_ENTRY_TYPE } from "../lifecycle/thread-entry.js";
import type { LaunchFlags, ResolveDeps } from "../lifecycle/thread-resolution.js";
import { resolveStartupThread } from "./resolve-startup.js";
import { seedPiSessionFromLhc } from "./seed-session.js";

export interface LhcLauncherStartupDeps {
  cwd: string;
  launchFlags: LaunchFlags;
  registryPath?: string;
  newThreadFilePath: () => string;
  sdkConfig: SdkConfig;
  selectThread?: (choices: readonly ThreadChoice[]) => Promise<string | null>;
}

export interface LhcLauncherStartup {
  threadRef: ThreadRef;
  sessionManager: SessionManager;
  seededMessageCount: number;
}

function resolveDepsOf(deps: LhcLauncherStartupDeps): ResolveDeps {
  const resolveDeps: ResolveDeps = { cwd: deps.cwd, newThreadFilePath: deps.newThreadFilePath };
  if (deps.registryPath !== undefined) resolveDeps.registryPath = deps.registryPath;
  return resolveDeps;
}

async function resolveLauncherThread(
  launch: LaunchFlags,
  deps: LhcLauncherStartupDeps,
): Promise<OpResult<ThreadRef | null>> {
  if (launch.resume === true && deps.selectThread !== undefined) {
    const pickerDeps: {
      registryPath?: string;
      select: (choices: readonly ThreadChoice[]) => Promise<string | null>;
    } = {
      select: deps.selectThread,
    };
    if (deps.registryPath !== undefined) pickerDeps.registryPath = deps.registryPath;
    return pickThread(deps.cwd, pickerDeps);
  }
  return resolveStartupThread(launch, resolveDepsOf(deps));
}

/** Resolve the LHC thread, read `getSessionThreadView`, and seed an in-memory PI session. */
export async function prepareLhcLauncherStartup(deps: LhcLauncherStartupDeps): Promise<OpResult<LhcLauncherStartup>> {
  const resolved = await resolveLauncherThread(deps.launchFlags, deps);
  if (!resolved.ok) return resolved;
  if (resolved.value === null) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "thread_not_found",
        reason: "launcher startup resolved no LHC thread",
      },
    };
  }

  const threadRef = resolved.value;
  const readInstance = await initInstance(threadRef, deps.sdkConfig);
  if (!readInstance.ok) return readInstance;

  try {
    const sessionManager = SessionManager.inMemory(deps.cwd);
    const seeded = await seedPiSessionFromLhc(readInstance.value, threadRef, sessionManager);
    if (!seeded.ok) return seeded;

    const durableEntry = durableThreadEntryOf(threadRef);
    if (durableEntry !== null) {
      sessionManager.appendCustomEntry(LHC_THREAD_ENTRY_TYPE, durableEntry);
    }

    return {
      ok: true,
      value: {
        threadRef,
        sessionManager,
        seededMessageCount: seeded.value.messageCount,
      },
    };
  } finally {
    await disposeInstance(readInstance.value);
  }
}
