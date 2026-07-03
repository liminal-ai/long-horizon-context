// Stated vs acceptance: assignment targetMinRatio/targetMaxRatio/targetAimRatio
// (0.08–0.2, aim 0.12) are the ACCEPTANCE window that sizeDisposition measures
// against. This template states a deliberately lower target (5–10%) because
// GPT models land 1.5–2x above whatever is stated — the bias measured in the
// turn-compression prompt lab. Stated ≠ enforced, by design.
//
// v3 drops v2's embedded examples entirely: they carried ~6k tokens of
// same-project content that leaked into outputs (chunk c2 of the gorilla-2
// thread reproduced an example's "PRD"/"4-band" conclusions as if they were
// input). The compressor gets the task, the size, the voice, and the input —
// nothing else. Examples return only against a measured failure, and never
// harvested from this project's own content.
import type { PromptTemplate } from "./index.js";

// Round the stated number at a granularity matched to its own magnitude
// (nearest-100 when the target is 1000+, nearest-10 below) — coarser steps
// on small targets produce degenerate text like "around 200 (roughly
// 100-200)". Same rule as detailed-turn-compression-v3.
function statedTarget(inputTokens: number, ratio: number): number {
  const raw = inputTokens * ratio;
  const step = raw >= 1000 ? 100 : 10;
  return Math.round(raw / step) * step;
}

export const chunkBriefV3: PromptTemplate<{
  text: string;
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
}> = {
  name: "chunk-brief-v3",
  render: (input) => {
    const statedAim = statedTarget(input.inputTokens, 0.075);
    const statedLo = statedTarget(input.inputTokens, 0.05);
    const statedHi = statedTarget(input.inputTokens, 0.1);

    const content = [
      "<instructions-for-summarizing>",
      "You write brief memory notes from AI coding-session history. The note below replaces a longer stretch of conversation in an agent's memory, so it must carry what a future agent would otherwise have to rediscover: what was decided, what was corrected, what was learned, what was left open.",
      "",
      `Your job is to condense the following conversation summary down to roughly 5-10% of its original size — around ${statedAim} tokens total (roughly ${statedLo}-${statedHi}). Write it as past-tense narrative prose, not a transcript and not live instructions. Old plans read as history ("at that point the next step was..."), never as commands to the reader. Keep exact names, paths, numbers, and error text when they carry the meaning.`,
      "</instructions-for-summarizing>",
      "",
      "<content-for-summarizing>",
      input.text,
      "</content-for-summarizing>",
    ].join("\n");

    return [{ role: "user", content }];
  },
};
