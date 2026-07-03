#!/usr/bin/env node
// Harvest runs: absolute-token-target instruction, instructions in the user
// message (before dialogue) with a short reminder after. Goal: collect genuine
// in-window (35-65%) outputs to serve as positive exemplars for prompt v3.
import { readFileSync, appendFileSync } from "node:fs";
import { estimateTokens } from "../../../dist/index.js";

const [spec, repeats = "5", effort = "none", model = "openai/gpt-5.4-mini"] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(`specimens/${spec}-detailed_turn_compression.json`, "utf8"));
const dialogue = fixture.messages[1].content.replace(/^<dialogue_to_compress>\n/, "").replace(/\n<\/dialogue_to_compress>$/, "");
const aim = fixture.targets.targetAimTokens;
const min = fixture.targets.targetMinTokens;
const max = fixture.targets.targetMaxTokens;

const instructions = `You condense dialogues from AI coding sessions so they can stand in for the original in a long-running conversation history. The condensed version is what the assistant will "remember" about this exchange later, so it must carry everything a future reader needs and nothing they don't.

The dialogue below is about ${fixture.inputTokens} tokens. Write a condensed version of approximately ${aim} tokens. It must be no shorter than ${min} tokens and no longer than ${max} tokens. That means keeping roughly half the length: this is substantial condensation, NOT a brief summary (too lossy) and NOT a light trim (too faithful).

Keep, verbatim where possible:
- everything the user asked for, decided, corrected, or constrained
- exact identifiers: file paths, commands, function names, model names, numbers, error text, test results
- conclusions, outcomes, and factual claims the assistant produced

Condense or drop:
- step-by-step narration of process ("Now let me look at...", "Next I'll read...")
- repetition, pleasantries, closing offers ("If you want, I can...")
- long explanations that restate what identifiers already say

Write it as compact prose in the same dialogue register (User: / Assistant:).`;

const messages = [{
  role: "user",
  content: `${instructions}\n\n<dialogue>\n${dialogue}\n</dialogue>\n\nNow write the condensed version (${min}-${max} tokens, aim ~${aim}). Output only the condensed dialogue.`,
}];

const key = process.env.OPENROUTER_API_KEY;
for (let run = 1; run <= Number(repeats); run += 1) {
  const t0 = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, reasoning: { effort } }),
  });
  const payload = await res.json();
  const elapsed = Math.round(performance.now() - t0);
  const text = payload.choices?.[0]?.message?.content ?? "";
  const outTok = estimateTokens(text);
  const ratio = Number((outTok / fixture.inputTokens * 100).toFixed(1));
  const inWindow = outTok >= min && outTok <= max;
  appendFileSync("results/harvest-v2.jsonl", JSON.stringify({ specimen: spec, run, effort, model, aim, min, max, outputTokens: outTok, ratio, inWindow, elapsed, output: text }) + "\n");
  console.log(`${spec} run ${run}: out=${outTok}t ratio=${ratio}% ${inWindow ? "IN-WINDOW" : "out"} elapsed=${elapsed}ms`);
}
