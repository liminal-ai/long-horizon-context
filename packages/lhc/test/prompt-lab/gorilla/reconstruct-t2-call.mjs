// Reconstruct the exact model call sent to gpt-5.4-mini for t2's detailed_turn_compression.
// Uses the real template module and the real target arithmetic against the real assembly row.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { estimateTokens } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/index.js";
import { detailedTurnCompressionV2 } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/shared-tech/prompts/detailed-turn-compression-v2.js";

const db = new DatabaseSync(process.argv[2]);
const row = db.prepare(
  "SELECT content FROM derivation WHERE derivation_type='pre_detailed_assembly' AND subject_id='t2'",
).get();
const dialogueText = row.content;

const inputTokens = estimateTokens(dialogueText);
// compressionTargetTokens (derive.ts:118) with resolved default ratios (sdk.ts:384-386)
const targets = {
  targetMinTokens: Math.max(1, Math.round(inputTokens * 0.35)),
  targetAimTokens: Math.max(1, Math.round(inputTokens * 0.5)),
  targetMaxTokens: Math.max(1, Math.round(inputTokens * 0.65)),
};
// maxInputChars default 200_000 — content is ~24k chars, so boundContent is a no-op.

const messages = detailedTurnCompressionV2.render({ dialogueText, inputTokens, ...targets });

const out = [
  "# Reconstruction: exact model call for t2 detailed_turn_compression",
  "",
  "provider: openai-codex   model: gpt-5.4-mini   thinking: (DEFAULT_INFERENCE_THINKING)",
  `template: detailed-turn-compression-v2   inputTokens: ${inputTokens}`,
  `targets: min=${targets.targetMinTokens}  aim=${targets.targetAimTokens}  max=${targets.targetMaxTokens}  (ratios 0.35/0.5/0.65)`,
  "input bounding: none applied (content 23,018 chars < maxInputChars 200,000)",
  "",
  "=".repeat(80),
  ...messages.flatMap((m) => [
    "",
    `━━━ MESSAGE role=${m.role} (${estimateTokens(m.content)} tokens) ━━━`,
    "",
    m.content,
  ]),
  "",
  "=".repeat(80),
  "",
  "ACTUAL MODEL OUTPUT (from derivation row): \"Compressed.\"",
  'metadata: {"inferenceAttempted":true,"inferenceSucceeded":true,"sizeDisposition":"under_min"}',
  "",
].join("\n");

const target = "/Users/leemoore/code/pi-long-horizon/liminal-context/t2-compression-call-reconstruction.txt";
writeFileSync(target, out);
console.log(`written: ${target}`);
console.log(`inputTokens=${inputTokens} targets=${JSON.stringify(targets)}`);
console.log(`system msg tokens=${estimateTokens(messages[0].content)}, user msg tokens=${estimateTokens(messages[1].content)}`);
