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
} from "../shared/derivation.js";

export type DeterministicOpName =
  | "smoothPrompt"
  | "summarizeToolCall"
  | "summarizeToolResult"
  | "composeTurnRendering"
  | "projectLowerBand"
  | "summarizeChunkDetailed"
  | "summarizeChunkBrief";

export const DETERMINISTIC_MARKERS: Record<DeterministicOpName, string> = {
  smoothPrompt: "smoothed",
  summarizeToolCall: "toolcall",
  summarizeToolResult: "toolresult",
  composeTurnRendering: "rendering",
  projectLowerBand: "projection",
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

export function createDeterministicProvider(): DerivationProvider {
  return {
    smoothPrompt: (i: { text: string }) => ok("smoothPrompt", i, i.text),
    summarizeToolCall: (i: {
      toolName: string;
      argsJson: string;
      pairedResult?: { content: string; isError: boolean };
    }) => ok("summarizeToolCall", i, `${i.toolName} ${i.argsJson}`),
    summarizeToolResult: (i: { toolName: string; content: string }) =>
      ok("summarizeToolResult", i, i.content),
    composeTurnRendering: (i: { parts: RenderingPart[] }) =>
      ok("composeTurnRendering", i, i.parts.map((p) => p.text).join(" | ")),
    projectLowerBand: (i: { rendering: string }) => ok("projectLowerBand", i, i.rendering),
    summarizeChunkDetailed: (i: { memberProjections: string[] }) =>
      ok("summarizeChunkDetailed", i, i.memberProjections.join(" | ")),
    summarizeChunkBrief: (i: { memberProjections: string[] }) =>
      ok("summarizeChunkBrief", i, i.memberProjections.join(" | ")),
  };
}
