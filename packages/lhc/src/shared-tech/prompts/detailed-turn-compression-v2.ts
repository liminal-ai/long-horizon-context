import type { PromptTemplate } from "./index.js";

export const detailedTurnCompressionV2: PromptTemplate<{
  dialogueText: string;
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
}> = {
  name: "detailed-turn-compression-v2",
  render: (dialogue) => [
    {
      role: "system",
      content: [
        "Below is a user↔assistant dialogue from a coding conversation.",
        "",
        `It is about ${dialogue.inputTokens} tokens long.`,
        "",
        `Compress it to about ${dialogue.targetAimTokens} tokens (roughly 30-50% of the input). The final output must fall within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens.`,
        "",
        "Write the compressed version as compact prose in the same dialogue register.",
        "",
        "Preserve:",
        "- user constraints, corrections, decisions, and preferences",
        "- exact identifiers: file paths, commands, model names, numbers, errors, test results, commit hashes",
        "- decisions made during the exchange",
        "- outcomes and conclusions the assistant stated",
        "",
        "Remove:",
        "- pleasantries and repeated acknowledgements",
        "- repetition and meta-commentary",
        "- filler that does not change what happened",
        "",
        `Before returning, estimate whether the output is within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens.`,
        "If it is too short, expand it by restoring missing substance.",
        "If it is too long, contract it by removing lower-value detail and repeated explanation.",
        "",
        `The final answer must be within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens.`,
        "",
        "Rewrite only the text inside <dialogue_to_compress>.",
        "Return only the compressed dialogue, without XML tags.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `<dialogue_to_compress>\n${dialogue.dialogueText}\n</dialogue_to_compress>`,
    },
  ],
};
