// PRE-DIAL-IN: structurally sound, untuned (AC-2.3); the dial-in working
// period produces the tuned text under a new versioned name.
import type { RenderingPart } from "../derivation.js";
import type { PromptTemplate } from "./index.js";

function partLine(part: RenderingPart): string {
  const outcome = part.outcome === undefined ? "" : ` (outcome: ${part.outcome})`;
  return `[${part.kind}${outcome}]\n${part.text}`;
}

export const turnComposeV1: PromptTemplate<{ parts: RenderingPart[] }> = {
  name: "turn-compose-v1",
  render: (i) => [
    {
      role: "system",
      content:
        "You compose one turn of an engineering conversation into a faithful narrative account. Work only from the parts given, in order. Attribute each action to its speaker or tool. Preserve concrete facts: paths, identifiers, counts, error text. State each tool outcome plainly using the outcome given. No commentary, no speculation, 250 words maximum.",
    },
    { role: "user", content: `Turn parts, in order:\n\n${i.parts.map(partLine).join("\n\n")}` },
  ],
};
