// PRE-DIAL-IN: structurally sound, untuned (AC-2.3); the dial-in working
// period produces the tuned text under a new versioned name. Input bounding
// (DD-7) is applied by the adapter before this template renders.
import type { PromptTemplate } from "./index.js";

export const toolResultV1: PromptTemplate<{ toolName: string; content: string }> = {
  name: "tool-result-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You summarize tool output for an engineering record. Preserve concrete facts: paths, identifiers, counts, error text. State the outcome plainly. No commentary, no speculation, 150 words maximum.",
    },
    { role: "user", content: `Tool: ${i.toolName}\n\nOutput:\n${i.content}` },
  ],
};
