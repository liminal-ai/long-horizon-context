export const COMPACT_ALGORITHM_ENV_VAR = "LHC_COMPACT_ALGORITHM";

export const LEGACY_COMPACT_ALGORITHM = "legacy";

export type CompactAlgorithm = "bounded" | "legacy";

export function resolveCompactAlgorithm(env: NodeJS.ProcessEnv = process.env): CompactAlgorithm {
  return env[COMPACT_ALGORITHM_ENV_VAR] === LEGACY_COMPACT_ALGORITHM ? "legacy" : "bounded";
}

export const LEGACY_COMPACT_DIAGNOSTIC =
  `${COMPACT_ALGORITHM_ENV_VAR}=${LEGACY_COMPACT_ALGORITHM}: Smart Compact is running the legacy eager ` +
  "selector, which reads every live message and every closed chunk's fallback material before selecting. " +
  "Unset it to restore the bounded selector.";

let diagnosticEmitted = false;

export function emitLegacyCompactDiagnostic(): void {
  if (diagnosticEmitted) return;
  diagnosticEmitted = true;
  process.emitWarning(LEGACY_COMPACT_DIAGNOSTIC, "LhcCompactAlgorithmWarning");
}
