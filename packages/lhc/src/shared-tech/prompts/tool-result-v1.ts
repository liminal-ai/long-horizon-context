// PRE-DIAL-IN: structurally sound, untuned (AC-2.3); the dial-in working
// period produces the tuned text under a new versioned name. Input bounding
// (DD-7) is applied by the adapter before this template renders.
import type { ToolOutcome } from "../derivation.js";
import type { PromptTemplate } from "./index.js";

export const toolResultV1: PromptTemplate<{
  toolName: string;
  content: string;
  outcome: ToolOutcome;
  targetTokens: number;
  guidance: string;
}> = {
  name: "tool-result-v1",
  render: (i) => [
    {
      role: "system",
      content:
        `You summarize tool output for an engineering record. Preserve the outcome/status exactly as "${i.outcome}". Target about ${i.targetTokens} tokens. ${i.guidance} No commentary, no speculation.`,
    },
    { role: "user", content: `Tool: ${i.toolName}\nOutcome: ${i.outcome}\n\nOutput:\n${i.content}` },
  ],
};
