// Startup validation probes inference assignments against PI's registry,
// reports unreachable lanes, and leaves capture running.
//
// This layer runs AFTER shape validation (which LHC's initLhc enforces at
// construction). It adds a reachability probe on top: for each assignment,
// check that the provider/model pair exists in PI's registry and that auth is
// configured. This surfaces misconfigurations before the first derivation use,
// rather than as a silent derivation failure later.
//
// Reporting must not assume a TUI. The report surfaces through ctx.ui when
// available and always persists to SessionState.health for headless modes.

import { writeSync } from "node:fs";
import type { ModelAssignment } from "lhc";
import type { SessionState } from "../lifecycle/state.js";
import type { ExtensionContext } from "../pi/types.js";
import type { ValidationReport } from "../shared/diagnostics.js";
import { ASSIGNMENT_KINDS } from "./model-call.js";

// Re-export ValidationReport from its spec'd home (defined in shared/diagnostics
// so SessionState can reference it without a lifecycle→inference edge).
export type { ValidationReport };

interface ReportDeps {
  reporter?: StartupValidationReporter;
}

function defaultHeadlessLog(message: string): void {
  writeSync(2, `${message}\n`);
}

export interface StartupValidationReporterInput {
  message: string;
  report: ValidationReport;
  ctx: ExtensionContext;
  state: SessionState;
}

export type StartupValidationReporter = (input: StartupValidationReporterInput) => void;

export function defaultStartupValidationReporter({ message, ctx }: StartupValidationReporterInput): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, { level: "warn" });
  } else {
    defaultHeadlessLog(message);
  }
}

/** Probe each assignment and classify unreachable lanes.
 *
 *  For each inference derivation kind:
 *  1. Call ctx.modelRegistry.find(provider, model) to check if the lane exists.
 *  2. If found, call ctx.modelRegistry.hasConfiguredAuth(handle) to check auth.
 *  3. Classify the failure:
 *     - "unknown_model": provider/model not found in registry → fix assignment
 *     - "auth_not_configured": lane exists but no auth → log in / configure auth
 *
 *  Returns a structured report listing all unreachable lanes with their fixes.
 *  Reachable lanes are not listed; an empty `unreachable` array means all lanes
 *  are reachable. */
export function validateReachable(
  assignments: Record<string, ModelAssignment> | undefined,
  ctx: ExtensionContext,
): ValidationReport {
  const unreachable: ValidationReport["unreachable"] = [];

  for (const kind of ASSIGNMENT_KINDS) {
    const assignment = assignments?.[kind];
    if (assignment === undefined) continue;
    const { provider, model } = assignment;

    // Check if the model exists in PI's registry
    const resolved = ctx.modelRegistry.find(provider, model);

    if (resolved === undefined) {
      // Unknown lane: provider/model not found → fix assignment
      unreachable.push({
        kind,
        provider,
        model,
        reason: "unknown_model",
        fix: `Update '${kind}' assignment to use a known provider/model pair available in PI's model registry`,
      });
      continue; // Skip auth check for unknown models
    }

    // Lane exists; check if auth is configured
    if (!ctx.modelRegistry.hasConfiguredAuth(resolved)) {
      // Known lane but no auth → log in / configure auth
      unreachable.push({
        kind,
        provider,
        model,
        reason: "auth_not_configured",
        fix: `Log in or configure auth for ${provider}/${model} in PI settings`,
      });
    }
  }

  return { unreachable };
}

/** Surface unreachable lanes via ctx.ui when available + structured diagnostic.
 *
 *  Reporting is headless-safe:
 *  - If ctx.hasUI is true, surface through ctx.ui.notify with a formatted report.
 *  - Always persist the structured ValidationReport to SessionState.health.
 *  - Capture continues running even when validation fails.
 *
 *  This function never throws; validation failures are diagnostic, not fatal.
 *  The affected lane's derivations will fail classified and queryable through
 *  health, but the thread itself remains functional for capture. */
export function report(r: ValidationReport, ctx: ExtensionContext, state: SessionState, deps: ReportDeps = {}): void {
  // Mark that we've reported startup validation (avoids duplicate reporting)
  state.flags.startupValidationReported = true;

  // If there are unreachable lanes, surface them through ctx.ui when available
  if (r.unreachable.length > 0) {
    const lines = [
      "pi-lhc startup validation: unreachable derivation lanes",
      "",
      ...r.unreachable.map(
        (u) => `  • ${u.kind}: ${u.provider}/${u.model}\n    Reason: ${u.reason}\n    Fix: ${u.fix}`,
      ),
      "",
      `Capture will continue, but derivations on these lanes will fail. Update your PI settings or assignment config to resolve.`,
    ];

    const message = lines.join("\n");
    state.health.startupValidation = { ...r, message };
    const reporter = deps.reporter ?? defaultStartupValidationReporter;
    reporter({ message, report: r, ctx, state });
  } else {
    // Persist the structured report to SessionState.health (always, even in headless)
    state.health.startupValidation = r;
  }
}
