import { createSdk, type Lhc, type OpResult, type SdkConfig, type ThreadRef } from "lhc";
import type { LhcInstance } from "../shared/instance.js";
import { notImplemented } from "../shared/not-implemented.js";

// AC-1.1, AC-1.4, AC-1.5.

/** The connector's name for SDK construction — the agreed rename of LHC's
 *  `createSdk` (tech design A-4; the rename lands in lhc later, mechanical
 *  either way). One instance per PI session in background scheduler mode; the
 *  connector never drives the queue (Flow 1). Construction itself is real (it
 *  is just a rename); the lifecycle SEAM below is what Story 1 fills in. */
export function initLhc(config: SdkConfig): Lhc {
  return createSdk(config);
}

/** Construct an instance against a resolved thread (Story 1: build the SDK in
 *  background mode, wrap with a flush-on-dispose seam). Fail-closed until then
 *  — it never returns a usable instance, so nothing can mistake the scaffold
 *  for a working session, and it throws nothing back into a hook. */
export function initInstance(
  threadRef: ThreadRef,
  config: SdkConfig,
): Promise<OpResult<LhcInstance>> {
  return Promise.resolve(notImplemented<LhcInstance>("lifecycle.initInstance"));
}

/** Dispose an instance on shutdown/switch. Story 1 wires this to flush pending
 *  LHC work before releasing the instance; Story 0 exposes the seam but fails
 *  closed so shutdown cannot be mistaken for a successful flush. */
export function disposeInstance(instance: LhcInstance | null): Promise<OpResult<void>> {
  void instance;
  return Promise.resolve(notImplemented<void>("lifecycle.disposeInstance"));
}
