// PRE-DIAL-IN: structurally sound, untuned (AC-2.3); the dial-in working
// period produces the tuned text under a new versioned name.
import type { ToolRunReceipt } from "../../shared/derivation.js";
import type { PromptTemplate } from "./index.js";

function receiptsSection(memberReceipts?: ToolRunReceipt[][]): string {
  const receipts = (memberReceipts ?? []).flat();
  if (receipts.length === 0) return "";
  const lines = receipts.map((r) => `- ${r.account} => ${r.outcome}`);
  return `\n\nTool-run receipts (what changed, outcome):\n${lines.join("\n")}`;
}

export const chunkDetailedV1: PromptTemplate<{
  memberProjections: string[];
  memberReceipts?: ToolRunReceipt[][];
}> = {
  name: "chunk-detailed-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You summarize a sequence of conversation turns for an engineering record. Preserve the arc of the work, decisions made, and concrete facts: paths, identifiers, counts, error text. Use the tool-run receipts as the authority on what changed and each outcome. No commentary, no speculation, 150 words maximum.",
    },
    {
      role: "user",
      content:
        `Turns, in order:\n\n${i.memberProjections
          .map((projection, idx) => `${String(idx + 1)}. ${projection}`)
          .join("\n\n")}` + receiptsSection(i.memberReceipts),
    },
  ],
};
