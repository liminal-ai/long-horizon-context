import type { ThreadRef } from "lhc";
import type { ValidationReport } from "../shared/diagnostics.js";

// AC-1.3 / AC-2.7. This module is COMPLETE, not stubbed (story Technical
// Notes): its shape is what prevents stale PI-context retention later. The
// holder has no slot for a PI ctx/session object, so retaining one across hooks
// is impossible in normal use — the structural enforcement the tech arch's
// plain-data-only rule calls for.

/** Recorded when a writable-thread capture fails: the failure degrades to a
 *  durable, queryable gap rather than throwing into a PI hook (AC-2.7). */
export interface CaptureFailureDiagnostic {
  code: string;
  eventKey?: string;
  message: string;
  recordedGap: boolean;
}

/** The connector's entire retained state between PI hooks: a thread reference,
 *  told-the-user flags, and health diagnostics — ALL plain data. Everything
 *  stored here must survive `structuredClone` (no functions, no class
 *  instances, no PI objects). */
export interface SessionState {
  threadRef: ThreadRef;
  flags: {
    startupValidationReported: boolean;
    [k: string]: boolean;
  };
  health: {
    lastCaptureFailure?: CaptureFailureDiagnostic;
    startupValidation?: ValidationReport;
  };
}

/** Build the initial plain-data holder for a resolved thread. */
export function createSessionState(threadRef: ThreadRef): SessionState {
  return {
    threadRef,
    flags: { startupValidationReported: false },
    health: {},
  };
}
