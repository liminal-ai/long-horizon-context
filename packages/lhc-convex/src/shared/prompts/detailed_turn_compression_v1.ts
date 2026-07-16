import type { PromptTemplate } from "./index.js";

export const detailedTurnCompressionV1: PromptTemplate<{
  dialogueText: string;
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
}> = {
  name: "detailed-turn-compression-v1",
  render: (i) => [
    {
      role: "system",
      content: [
        "Below is one exchange from a coding conversation.",
        "",
        `It is about ${i.inputTokens} tokens long.`,
        "",
        `Shorten it to about ${i.targetAimTokens} tokens. The final output must fall within ${i.targetMinTokens}-${i.targetMaxTokens} tokens.`,
        "",
        "Write the shortened version as compact prose.",
        "",
        "Preserve:",
        "- the user's request, correction, decision, or preference",
        "- the agent's answer, action, mistake, or commitment",
        "- the useful conclusion from thinking, if it affected the work",
        "- the useful outcome from tool calls/results, if it affected the work",
        "- concrete files, paths, commands, model names, numbers, errors, test results, and commit hashes",
        "- unresolved questions or blocked work",
        "",
        "Remove:",
        "- raw thinking text",
        "- raw tool output",
        "- repeated acknowledgements",
        "- apologies and status chatter",
        "- local filler",
        "- details that did not affect what happened next",
        "",
        "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.",
        "",
        `Before returning, estimate whether the output is within ${i.targetMinTokens}-${i.targetMaxTokens} tokens.`,
        "If it is too short, expand it by restoring missing substance.",
        "If it is too long, contract it by removing lower-value detail and repeated explanation.",
        "",
        `The final answer must be within ${i.targetMinTokens}-${i.targetMaxTokens} tokens.`,
        "",
        "Rewrite only the text inside <turn_rendering_to_compress>.",
        "Return only the shortened exchange, without XML tags.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `<turn_rendering_to_compress>\n${i.dialogueText}\n</turn_rendering_to_compress>`,
    },
  ],
};
