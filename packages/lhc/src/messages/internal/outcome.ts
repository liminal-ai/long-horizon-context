// Mechanical ToolOutcome stamping (AC-2.4): the outcome on a tool-activity
// summary is a pure function of the record — paired-result presence and its
// isError flag — and nothing else. The signature takes no provider text on
// purpose (anti-shim: the violation is unrepresentable); the handler stamps
// the returned value into derivation.metadata, apart from provider prose.
import type { ToolOutcome } from "../../shared-tech/derivation.js";

export function deriveToolOutcome(
  pairedResult: { isError: boolean } | undefined,
): ToolOutcome {
  if (pairedResult === undefined) return "unknown";
  return pairedResult.isError ? "failed" : "succeeded";
}
