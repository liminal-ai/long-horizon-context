// Capture executable prompt fixtures for the bad (+baseline) specimens.
// Each fixture: exact rendered messages, model config, targets, original output.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { estimateTokens } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/index.js";
import { detailedTurnCompressionV2 } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/shared-tech/prompts/detailed-turn-compression-v2.js";
import { chunkBriefV2 } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/shared-tech/prompts/chunk-brief-v2.js";

const db = new DatabaseSync("/Users/leemoore/.lhc/threads/2891d502-07a6-4d14-8eba-211f025b5436.sqlite", { readOnly: true });
const get = (type, id) => db.prepare("SELECT content, metadata FROM derivation WHERE derivation_type=? AND subject_id=? AND state='ready'").get(type, id);

const SPECIMENS = [
  { id: "t2", kind: "detailed_turn_compression", note: "acknowledgment failure: output was the literal string 'Compressed.'" },
  { id: "t5", kind: "detailed_turn_compression", note: "fabrication: 436->637 tokens, invented README body not present in input dialog" },
  { id: "t3", kind: "detailed_turn_compression", note: "deep under-compression: 4.7% vs 35-65% window; user side of dialog dropped" },
  { id: "t6", kind: "detailed_turn_compression", note: "under-compression at scale: 5.4% on 5669-token input" },
  { id: "c4", kind: "chunk_summary_brief", note: "brief-lane under: 3.5% vs 8-20% window, thinnest content" },
  { id: "t8", kind: "detailed_turn_compression", note: "BASELINE (good): 11.4%, preserves user ask, dense accurate key points. Regression reference." },
];

const RATIOS = {
  detailed_turn_compression: { lo: 0.35, aim: 0.5, hi: 0.65, inputType: "pre_detailed_assembly", template: detailedTurnCompressionV2, textKey: "dialogueText" },
  chunk_summary_brief: { lo: 0.08, aim: 0.12, hi: 0.2, inputType: "chunk_summary_detailed", template: chunkBriefV2, textKey: "text" },
};

for (const s of SPECIMENS) {
  const cfg = RATIOS[s.kind];
  const input = get(cfg.inputType, s.id);
  const output = get(s.kind, s.id);
  const inputTokens = estimateTokens(input.content);
  const targets = {
    targetMinTokens: Math.max(1, Math.round(inputTokens * cfg.lo)),
    targetAimTokens: Math.max(1, Math.round(inputTokens * cfg.aim)),
    targetMaxTokens: Math.max(1, Math.round(inputTokens * cfg.hi)),
  };
  const messages = cfg.template.render({ [cfg.textKey]: input.content, inputTokens, ...targets });
  const fixture = {
    specimen: s.id,
    derivationKind: s.kind,
    note: s.note,
    model: { provider: "openai-codex", model: "gpt-5.4-mini", thinking: "none" },
    template: cfg.template.name,
    ratios: { min: cfg.lo, aim: cfg.aim, max: cfg.hi },
    inputTokens,
    targets,
    messages,
    originalOutput: output.content,
    originalOutputTokens: estimateTokens(output.content),
    originalMetadata: JSON.parse(output.metadata),
  };
  const path = `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/prompt-lab/specimens/${s.id}-${s.kind}.json`;
  writeFileSync(path, JSON.stringify(fixture, null, 2));
  console.log(`${s.id}: in=${inputTokens}t out=${fixture.originalOutputTokens}t -> ${path.split("/").pop()}`);
}
