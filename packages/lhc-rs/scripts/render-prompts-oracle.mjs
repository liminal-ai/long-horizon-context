/**
 * TS oracle: renders every lhc prompt template with sentinel inputs and
 * writes fixtures/prompt-renders.json — the byte-parity contract for the
 * Rust prompt ports (Wave 1 tests compare against this file).
 * Regenerate only deliberately (requires tsx):
 *   cd packages/lhc && pnpm exec tsx ../lhc-rs/scripts/render-prompts-oracle.mjs
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chunkBriefV1 } from "../../lhc/src/shared-tech/prompts/chunk-brief-v1.ts";
import { chunkBriefV2 } from "../../lhc/src/shared-tech/prompts/chunk-brief-v2.ts";
import { chunkBriefV3 } from "../../lhc/src/shared-tech/prompts/chunk-brief-v3.ts";
import { detailedTurnCompressionV1 } from "../../lhc/src/shared-tech/prompts/detailed-turn-compression-v1.ts";
import { detailedTurnCompressionV2 } from "../../lhc/src/shared-tech/prompts/detailed-turn-compression-v2.ts";
import { detailedTurnCompressionV3 } from "../../lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts";
import { smoothingV1 } from "../../lhc/src/shared-tech/prompts/smoothing-v1.ts";
import { toolResultV1 } from "../../lhc/src/shared-tech/prompts/tool-result-v1.ts";
import { toolResultV2 } from "../../lhc/src/shared-tech/prompts/tool-result-v2.ts";

function joinMsgs(msgs) {
  return msgs.map((m) => `${m.role}\0${m.content}`).join("\n---\n");
}

const fixtures = {
  "chunk-brief-v1": () =>
    chunkBriefV1.render({
      memberProjections: ["SENTINEL_PROJ_A", "SENTINEL_PROJ_B"],
      memberOutcomes: [["succeeded"], ["failed"]],
    }),
  "chunk-brief-v2": () =>
    chunkBriefV2.render({
      text: "SENTINEL_CHUNK_TEXT",
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    }),
  "chunk-brief-v3": () =>
    chunkBriefV3.render({
      text: "SENTINEL_CHUNK_TEXT",
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    }),
  "detailed-turn-compression-v1": () =>
    detailedTurnCompressionV1.render({
      dialogueText: "SENTINEL_DIALOGUE",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    }),
  "detailed-turn-compression-v2": () =>
    detailedTurnCompressionV2.render({
      dialogueText: "SENTINEL_DIALOGUE",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    }),
  "detailed-turn-compression-v3": () =>
    detailedTurnCompressionV3.render({
      dialogueText: "SENTINEL_DIALOGUE",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    }),
  "smoothing-v1": () => smoothingV1.render({ text: "SENTINEL_SMOOTH_TEXT" }),
  "tool-result-v1": () =>
    toolResultV1.render({
      toolName: "SENTINEL_TOOL",
      content: "SENTINEL_CONTENT",
      outcome: "succeeded",
      targetTokens: 99,
      guidance: "SENTINEL_GUIDANCE",
    }),
  "tool-result-v2": () =>
    toolResultV2.render({
      toolName: "SENTINEL_TOOL",
      content: "SENTINEL_CONTENT",
      outcome: "succeeded",
      targetTokens: 120,
      promptMode: "content_summary",
      responseShape: "file_content",
      facts: {
        toolName: "SENTINEL_TOOL",
        outcome: "succeeded",
        targetPath: "notes/plan.md",
        operationClass: "read",
        responseShape: "file_content",
        outputChars: 16,
      },
    }),
};

const out = {};
for (const [name, fn] of Object.entries(fixtures)) {
  const msgs = fn();
  out[name] = { messages: msgs, joined: joinMsgs(msgs) };
}
writeFileSync(new URL("../fixtures/prompt-renders.json", import.meta.url).pathname, JSON.stringify(out, null, 1));
console.log("wrote", Object.keys(out).length, "templates");
