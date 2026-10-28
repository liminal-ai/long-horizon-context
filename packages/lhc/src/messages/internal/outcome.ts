import type { ToolOutcome } from "../../shared-tech/index.js";

export function deriveToolOutcome(pairedResult: { isError: boolean } | undefined): ToolOutcome {
  if (pairedResult === undefined) return "unknown";
  return pairedResult.isError ? "failed" : "succeeded";
}
