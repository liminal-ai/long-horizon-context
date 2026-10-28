import type { PromptTemplate } from "./index.js";

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
