// The deterministic provider: marked, input-derived output for every seam
// operation — `<marker>(<digest>:<prefix>)` where digest and prefix are pure
// functions of the input. It backs the named-provider registry's
// "deterministic" entry (DD-11) so spawned-CLI tests exercise the production
// resolution seam, and the test double reuses these helpers so in-process and
// spawned runs produce byte-identical artifacts. It is selectable only by
// explicit name — never a production default.
import type {
  DerivationProvider,
  ProviderResult,
  RenderingPart,
  ToolOutcome,
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

export function deterministicText(
  op: DeterministicOpName,
  input: unknown,
  text: string,
): string {
  return `${DETERMINISTIC_MARKERS[op]}(${deterministicDigest(input)}:${text.slice(0, 40)})`;
}

function ok(op: DeterministicOpName, input: unknown, text: string): Promise<ProviderResult> {
  return Promise.resolve({ ok: true, text: deterministicText(op, input, text) });
}

// The chunk-summary contract made visible in deterministic output (AC-3.8):
// the detailed summary's artifact carries the members' tool-run receipts —
// account and outcome — verbatim; the brief summary's carries outcomes
// only. Pure suffixes over the input fields, shared with the test double so
// in-process and spawned artifacts stay byte-identical; empty receipt sets
// add nothing, keeping receipt-less output unchanged.
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

export function createDeterministicProvider(): DerivationProvider {
  return {
    smoothPrompt: (i: { text: string }) => ok("smoothPrompt", i, i.text),
    summarizeToolResult: (i: {
      toolName: string;
      content: string;
      outcome?: ToolOutcome;
      targetTokens?: number;
      guidance?: string;
    }) =>
      ok("summarizeToolResult", i, i.content),
    composeTurnRendering: (i: { parts: RenderingPart[] }) =>
      ok("composeTurnRendering", i, i.parts.map((p) => p.text).join(" | ")),
    compressSmoothTurn: (i: { rendering: string }) => ok("compressSmoothTurn", i, i.rendering),
    summarizeChunkDetailed: async (i: {
      memberProjections: string[];
      memberReceipts?: ToolRunReceipt[][];
    }) => {
      const base = await ok("summarizeChunkDetailed", i, i.memberProjections.join(" | "));
      if (!base.ok) return base;
      return { ok: true, text: base.text + deterministicReceiptsSuffix(i.memberReceipts) };
    },
    summarizeChunkBrief: async (i: {
      memberProjections: string[];
      memberOutcomes?: ToolOutcome[][];
    }) => {
      const base = await ok("summarizeChunkBrief", i, i.memberProjections.join(" | "));
      if (!base.ok) return base;
      return { ok: true, text: base.text + deterministicOutcomesSuffix(i.memberOutcomes) };
    },
  };
}
