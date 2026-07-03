// Deterministic inference callbacks: marked, input-derived output for every seam
// operation — `<marker>(<digest>:<prefix>)` where digest and prefix are pure
// functions of the input. The test double reuses these helpers so in-process
// and spawned runs produce byte-identical artifacts. It is selectable only by
// explicit construction — never a production default.
import type {
  InferenceCallbacks,
  InferenceResult,
  ToolOutcome,
  ToolResultFacts,
  ToolResultOperationClass,
  ToolResultPromptMode,
  ToolResultResponseShape,
} from "./derivation.js";

export type DeterministicOpName =
  | "smoothPrompt"
  | "summarizeToolResult"
  | "compressDetailedTurn"
  | "summarizeChunkBrief";

export const DETERMINISTIC_MARKERS: Record<DeterministicOpName, string> = {
  smoothPrompt: "smoothed",
  summarizeToolResult: "toolresult",
  compressDetailedTurn: "projection",
  summarizeChunkBrief: "brief",
};

// FNV-1a 32-bit over the canonical input JSON: stable, dependency-free, and
// input-sensitive enough that distinct inputs mark distinct outputs.
export function deterministicDigest(input: unknown): string {
  const text = JSON.stringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function deterministicText(op: DeterministicOpName, input: unknown, text: string): string {
  return `${DETERMINISTIC_MARKERS[op]}(${deterministicDigest(input)}:${text.slice(0, 40)})`;
}

function ok(op: DeterministicOpName, input: unknown, text: string): Promise<InferenceResult> {
  return Promise.resolve({ ok: true, text: deterministicText(op, input, text) });
}

export function deterministicOutcomesSuffix(memberOutcomes?: ToolOutcome[][]): string {
  const outcomes = (memberOutcomes ?? []).flat();
  if (outcomes.length === 0) return "";
  return `[outcomes ${outcomes.join(",")}]`;
}

export function createDeterministicInferenceCallbacks(): InferenceCallbacks {
  return {
    smoothPrompt: (i: { text: string }) => ok("smoothPrompt", i, i.text),
    summarizeToolResult: (i: {
      toolName: string;
      content: string;
      outcome?: ToolOutcome;
      targetTokens?: number;
      operationClass?: ToolResultOperationClass;
      responseShape?: ToolResultResponseShape;
      promptMode?: ToolResultPromptMode;
      facts?: ToolResultFacts;
    }) => ok("summarizeToolResult", i, i.content),
    compressDetailedTurn: (i: {
      dialogueText: string;
      inputTokens: number;
      targetMinTokens: number;
      targetAimTokens: number;
      targetMaxTokens: number;
    }) => ok("compressDetailedTurn", i, i.dialogueText),
    summarizeChunkBrief: (i: {
      text: string;
      inputTokens: number;
      targetMinTokens: number;
      targetAimTokens: number;
      targetMaxTokens: number;
    }) => ok("summarizeChunkBrief", i, i.text),
  };
}
