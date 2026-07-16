// Pre-dial-in template kept under its versioned name for provenance.
import type { ToolOutcome } from "../derivation.js";
import type { PromptTemplate } from "./index.js";

function outcomesSection(memberOutcomes?: ToolOutcome[][]): string {
  const outcomes = (memberOutcomes ?? []).flat();
  if (outcomes.length === 0) return "";
  return `\n\nTool outcomes, in order: ${outcomes.join(", ")}`;
}

export const chunkBriefV1: PromptTemplate<{
  memberProjections: string[];
  memberOutcomes?: ToolOutcome[][];
}> = {
  name: "chunk-brief-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You write a brief summary of a sequence of conversation turns. State what was worked on and what was accomplished, and reflect the tool outcomes given. No detail beyond outcomes, no speculation, three sentences maximum.",
    },
    {
      role: "user",
      content:
        `Turns, in order:\n\n${i.memberProjections
          .map((memberText, idx) => `${String(idx + 1)}. ${memberText}`)
          .join("\n\n")}` + outcomesSection(i.memberOutcomes),
    },
  ],
};
