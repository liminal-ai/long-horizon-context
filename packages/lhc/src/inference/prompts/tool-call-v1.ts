// PRE-DIAL-IN: structurally sound, untuned (AC-2.3); the dial-in working
// period produces the tuned text under a new versioned name.
import type { PromptTemplate } from "./index.js";

export const toolCallV1: PromptTemplate<{
  toolName: string;
  argsJson: string;
  pairedResult?: { content: string; isError: boolean };
}> = {
  name: "tool-call-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You summarize a tool invocation for an engineering record. State which tool was called and what it was asked to do. Preserve concrete facts: paths, identifiers, and the arguments that matter. If the paired result is provided, use it only to clarify what the call did — never to invent an outcome. No commentary, no speculation, 60 words maximum.",
    },
    {
      role: "user",
      content:
        `Tool: ${i.toolName}\n\nArguments:\n${i.argsJson}` +
        (i.pairedResult === undefined
          ? ""
          : `\n\nPaired result (isError: ${String(i.pairedResult.isError)}):\n${i.pairedResult.content}`),
    },
  ],
};
