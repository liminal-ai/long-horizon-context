// Deterministic inference callbacks: marked, input-derived output for every seam
// operation — `<marker>(<digest>:<prefix>)` where digest and prefix are pure
// functions of the input. The test double reuses these helpers so in-process
// and spawned runs produce byte-identical artifacts. It is selectable only by
// explicit construction — never a production default.
import type {
  InferenceCallbacks,
  InferenceResult,
  RenderingPart,
  ToolOutcome,
  ToolResultFacts,
  ToolResultOperationClass,
  ToolResultPromptMode,
  ToolResultResponseShape,
  ToolRunReceipt,
} from "./derivation.js";

export type DeterministicOpName =
  | "smoothPrompt"
  | "summarizeToolResult"
  | "composeTurnRendering"
  | "compressSmoothTurn"
  | "summarizeChunkDetailed"
  | "summarizeChunkBrief";

export const DETERMINISTIC_MARKERS: Record<DeterministicOpName, string> = {
  smoothPrompt: "smoothed",
  summarizeToolResult: "toolresult",
  composeTurnRendering: "rendering",
  compressSmoothTurn: "projection",
  summarizeChunkDetailed: "detailed",
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

// The detailed summary's artifact carries the members' tool-run receipts —
// account and outcome — verbatim. Pure suffixes over the input fields are
// shared with the test double so in-process and spawned artifacts stay
// byte-identical.
export function deterministicReceiptsSuffix(memberReceipts?: ToolRunReceipt[][]): string {
  const receipts = (memberReceipts ?? []).flat();
  if (receipts.length === 0) return "";
  return `[receipts ${receipts.map((r) => `${r.account}=>${r.outcome}`).join("; ")}]`;
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
    composeTurnRendering: (i: { parts: RenderingPart[] }) =>
      ok("composeTurnRendering", i, i.parts.map((p) => p.text).join(" | ")),
    compressSmoothTurn: (i: {
      rendering: string;
      inputTokens: number;
      targetMinTokens: number;
      targetAimTokens: number;
      targetMaxTokens: number;
    }) => ok("compressSmoothTurn", i, i.rendering),
    summarizeChunkDetailed: async (i: { memberProjections: string[]; memberReceipts?: ToolRunReceipt[][] }) => {
      const base = await ok("summarizeChunkDetailed", i, i.memberProjections.join(" | "));
      if (!base.ok) return base;
      return { ok: true, text: base.text + deterministicReceiptsSuffix(i.memberReceipts) };
    },
    summarizeChunkBrief: (i: {
      text: string;
      inputTokens: number;
      targetMinTokens: number;
      targetAimTokens: number;
      targetMaxTokens: number;
    }) => ok("summarizeChunkBrief", i, i.text),
  };
}

/** @deprecated Use createDeterministicInferenceCallbacks. */
export const createDeterministicProvider = createDeterministicInferenceCallbacks;
