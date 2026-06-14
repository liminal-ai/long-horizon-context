import {
  createSdk,
  threads,
  type Lhc,
  type OpResult,
  type SdkConfig,
  type ThreadRef,
} from "lhc";
import type { LhcInstance } from "../shared/instance.js";

// AC-1.1, AC-1.4, AC-1.5.

/** The connector's name for SDK construction — the agreed rename of LHC's
 *  `createSdk` (tech design A-4; the rename lands in lhc later, mechanical
 *  either way). One instance per PI session in background scheduler mode; the
 *  connector never drives the queue (Flow 1). */
export function initLhc(config: SdkConfig): Lhc {
  return createSdk(config);
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Flush-on-dispose: await any pending background derivations for this thread,
 *  then release the instance. Captured intake is already durable (intake writes
 *  commit synchronously), so the flush is about letting in-flight background
 *  work settle before shutdown — never a throw back into a PI hook. */
async function disposeSdk(sdk: Lhc, threadRef: ThreadRef): Promise<OpResult<void>> {
  try {
    await sdk.drainSettled(threadRef);
  } catch (cause) {
    return {
      ok: false,
      error: {
        errorClass: "system_error",
        code: "storage_failure",
        reason: `instance dispose flush failed: ${detail(cause)}`,
      },
    };
  }
  return { ok: true, value: undefined };
}

/** Construct one LHC instance against a resolved thread in background scheduler
 *  mode (AC-1.1). The thread is validated first so an unresolvable ref returns a
 *  typed result rather than a half-built instance; background mode is forced
 *  regardless of the caller's config so the connector cannot accidentally drive
 *  the queue. A malformed inference/provider config is a programmer error and
 *  throws here per LHC's construction contract — the hook guard in `index.ts`
 *  contains it so nothing reaches the PI session. */
export async function initInstance(
  threadRef: ThreadRef,
  config: SdkConfig,
): Promise<OpResult<LhcInstance>> {
  const info = await threads.info(threadRef);
  if (!info.ok) return info;

  const sdk = initLhc({ ...config, mode: "background" });
  const instance: LhcInstance = {
    sdk,
    threadRef,
    dispose: () => disposeSdk(sdk, threadRef),
  };
  return { ok: true, value: instance };
}

/** Dispose an instance on shutdown/switch with flush (AC-1.4). Null-safe: a
 *  shutdown with no live instance is a successful no-op, never an error. */
export function disposeInstance(instance: LhcInstance | null): Promise<OpResult<void>> {
  if (instance === null) return Promise.resolve({ ok: true, value: undefined });
  return instance.dispose();
}
