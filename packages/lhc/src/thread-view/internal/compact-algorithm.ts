// Which Smart Compact execution plan runs. Exactly two states, one selector:
//
//   default                          the bounded plan (metadata aggregates,
//                                    hydration only for visited candidates)
//   LHC_COMPACT_ALGORITHM=legacy     the eager plan, unchanged
//
// There is no comparison mode, no shadow execution, and no automatic fallback:
// a value other than `legacy` — including a misspelling — is the default. The
// escape hatch is not silent; selecting it emits a process warning once, so a
// host running the unbounded plan says so on stderr without flooding it from
// every preview.

/** The environment variable that selects the execution plan. */
export const COMPACT_ALGORITHM_ENV_VAR = "LHC_COMPACT_ALGORITHM";

/** The one accepted value: exact, lowercase, no synonyms. */
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

/** Announces the escape hatch on stderr, once per process. */
export function emitLegacyCompactDiagnostic(): void {
  if (diagnosticEmitted) return;
  diagnosticEmitted = true;
  process.emitWarning(LEGACY_COMPACT_DIAGNOSTIC, "LhcCompactAlgorithmWarning");
}
