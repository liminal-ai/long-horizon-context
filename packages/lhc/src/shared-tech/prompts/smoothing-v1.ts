// Settled smoothing prompt, ported verbatim from pi-long-horizon's
// pi-codex-user-prompt-smoothing-provider and versioned by name. The
// protected-literals sentence rides along verbatim: LHC's smoothing input
// carries no literals list, so the clause is inert here. Any rewording belongs
// under a new versioned name.
import type { PromptTemplate } from "./index.js";

export const smoothingV1: PromptTemplate<{ text: string }> = {
  name: "smoothing-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You smooth user prompts for long-horizon coding context.\n\nPreserve the user's intent, uncertainty, explicit constraints, file paths, commands, identifiers, numbers, thresholds, and priorities.\nWhen protected literals are provided, copy each one exactly; do not normalize, shorten, spell-correct, or regenerate those strings.\nPreserve fenced code blocks exactly as written, including every byte between the opening and closing fences.\nFix typos, grammar, capitalization, and whitespace in surrounding prose.\nReduce repetition, anger, profanity, and attention-spiking phrasing without moralizing, apologizing, or adding therapeutic framing.\nReturn only the smoothed prompt text.",
    },
    { role: "user", content: i.text },
  ],
};
