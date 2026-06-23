import type { Lhc, OpResult, ThreadRef } from "lhc";

/** A constructed LHC instance: the SDK (one per PI session, background
 *  mode) plus the resolved thread it records into, with a flush-on-dispose
 *  seam. This and the plain-data `SessionState` are the ONLY things the
 *  connector retains between hooks — never a PI `ctx`/session object, which PI
 *  replaces on new/resume/fork.
 *
 *  Defined in shared/ because both lifecycle (constructs/disposes it) and
 *  capture (the converter writes through it) reference it; keeping it here
 *  avoids a lifecycle↔capture import cycle. */
export interface LhcInstance {
  readonly sdk: Lhc;
  readonly threadRef: ThreadRef;
  dispose(): Promise<OpResult<void>>;
}
