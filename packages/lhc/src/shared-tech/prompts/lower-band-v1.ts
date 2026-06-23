// Pre-dial-in template kept under its versioned name.
import type { PromptTemplate } from "./index.js";

export const lowerBandV1: PromptTemplate<{ rendering: string }> = {
  name: "lower-band-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You condense one turn's narrative account into a compact record for a long-horizon context. Keep what happened, decisions made, and concrete facts: paths, identifiers, counts, error text. Drop pleasantries and restatement. No commentary, 80 words maximum.",
    },
    { role: "user", content: i.rendering },
  ],
};
