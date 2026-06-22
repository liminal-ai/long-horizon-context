import type { PromptTemplate } from "./index.js";

export const smoothTurnCompressionV1: PromptTemplate<{
  rendering: string;
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
}> = {
  name: "smooth-turn-compression-v1",
  render: (i) => [
    {
      role: "system",
      content: [
        "Compress one structured turn rendering for long-horizon coding context.",
        "",
        `Input size: about ${i.inputTokens} tokens.`,
        `Target output range: ${i.targetMinTokens}-${i.targetMaxTokens} tokens; aim for about ${i.targetAimTokens} tokens.`,
        "Before returning, check that the answer is near the target range.",
        "",
        "Preserve substance: user requests, corrections, preferences, decisions, commitments, tool outcomes, concrete files, paths, commands, identifiers, model names, numbers, errors, test results, and unresolved questions.",
        "Drop noise: repeated acknowledgements, apologies, status chatter, raw thinking text, raw tool output, stack/log bulk, and low-value mechanics.",
        "",
        "Write compact prose. Do not mention these instructions.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Structured turn rendering:\n\n${i.rendering}\n\nReturn only the compressed turn record.`,
    },
  ],
};
