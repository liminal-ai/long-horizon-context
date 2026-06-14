import type { FormKind, ModelAssignment } from "lhc";
import type { ExtensionContext } from "../pi/types.js";
import type { SessionState } from "../lifecycle/state.js";
import type { ValidationReport } from "../shared/diagnostics.js";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-5.1, AC-5.2, AC-5.3. A reachability probe on top of LHC's shape
// validation: existence (`modelRegistry.find`) then configured-auth
// (`hasConfiguredAuth` / `getAvailable`). Reporting must not assume a TUI.

/** Re-exported from its spec'd home here (defined in shared/diagnostics so the
 *  plain-data SessionState can reference it without a lifecycle→inference edge). */
export type { ValidationReport };

/** Probe each assignment; classify unreachable lanes. Story 6. Throws until
 *  then — a stub returning `{ unreachable: [] }` would falsely report "all
 *  reachable" (story §Anti-Shim). */
export function validateReachable(
  assignments: Record<FormKind, ModelAssignment>,
  ctx: ExtensionContext,
): ValidationReport {
  throw new NotImplementedError("inference.validateReachable");
}

/** Surface unreachable lanes via `ctx.ui` when available + a structured
 *  diagnostic in `SessionState.health` always (headless-safe). Story 6. */
export function report(r: ValidationReport, ctx: ExtensionContext, state: SessionState): void {
  throw new NotImplementedError("inference.report");
}
