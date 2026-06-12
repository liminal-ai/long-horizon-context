// PRE-DIAL-IN: written to the POC smoothing prompt's standard (concrete
// instruction, fact-preservation rule, length bound); the POC's settled text
// is ported verbatim in the adapter/prompts story, and the dial-in working
// period owns tuning after that.
import type { PromptTemplate } from "./index.js";

export const smoothingV1: PromptTemplate<{ text: string }> = {
  name: "smoothing-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You rewrite a user's raw prompt into clear, well-formed prose for an engineering record. Preserve the user's intent, every constraint, and every concrete fact: paths, identifiers, names, numbers, error text. Do not add requests the user did not make and do not answer the prompt. Keep it at most as long as the original.",
    },
    { role: "user", content: i.text },
  ],
};
