// One-time/seed generator: merges the current harvest instruction with each
// specimen's dialogue into a single editable case file. Line 1 = meta JSON
// (scoring only). Everything AFTER the marker line is sent verbatim as the
// single user message.
import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "=== PROMPT BELOW — everything after this line is sent verbatim as one user message ===";

for (const spec of ["t2", "t3", "t5", "t6", "t8"]) {
  const fixture = JSON.parse(readFileSync(`specimens/${spec}-detailed_turn_compression.json`, "utf8"));
  const dialogue = fixture.messages[1].content.replace(/^<dialogue_to_compress>\n/, "").replace(/\n<\/dialogue_to_compress>$/, "");
  const { targetMinTokens: min, targetAimTokens: aim, targetMaxTokens: max } = fixture.targets;
  const meta = { specimen: spec, inputTokens: fixture.inputTokens, min, aim, max };

  const prompt = `You condense dialogues from AI coding sessions so they can stand in for the original in a long-running conversation history. The condensed version is what the assistant will "remember" about this exchange later, so it must carry everything a future reader needs and nothing they don't.

The dialogue below is about ${fixture.inputTokens} tokens. Write a condensed version of approximately ${aim} tokens. It must be no shorter than ${min} tokens and no longer than ${max} tokens. That means keeping roughly half the length: this is substantial condensation, NOT a brief summary (too lossy) and NOT a light trim (too faithful).

Keep, verbatim where possible:
- everything the user asked for, decided, corrected, or constrained
- exact identifiers: file paths, commands, function names, model names, numbers, error text, test results
- conclusions, outcomes, and factual claims the assistant produced

Condense or drop:
- step-by-step narration of process ("Now let me look at...", "Next I'll read...")
- repetition, pleasantries, closing offers ("If you want, I can...")
- long explanations that restate what identifiers already say

Write it as compact prose in the same dialogue register (User: / Assistant:).

<dialogue>
${dialogue}
</dialogue>

Now write the condensed version (${min}-${max} tokens, aim ~${aim}). Output only the condensed dialogue.`;

  writeFileSync(`turn-compression/cases/${spec}.txt`, JSON.stringify(meta) + "\n" + MARKER + "\n" + prompt);
  console.log(`${spec}.txt: prompt+content, in=${fixture.inputTokens}t window=${min}-${max}`);
}
