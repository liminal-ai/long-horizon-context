import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { estimateTokens } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/index.js";
const db = new DatabaseSync("/Users/leemoore/.lhc/threads/2891d502-07a6-4d14-8eba-211f025b5436.sqlite", { readOnly: true });
const get = (type, id) => db.prepare("SELECT content FROM derivation WHERE derivation_type=? AND subject_id=? AND state='ready'").get(type, id)?.content;
const outDir = "/private/tmp/claude-501/-Users-leemoore-code-pi-long-horizon-liminal-context/2d2c1674-c26f-485b-8856-27b8a6c4e743/scratchpad/gorilla/specimens";
mkdirSync(outDir, { recursive: true });
const rows = [];
for (const r of db.prepare("SELECT subject_id, derivation_type, content, json_extract(metadata,'$.sizeDisposition') disp FROM derivation WHERE derivation_type IN ('detailed_turn_compression','chunk_summary_brief') AND state='ready' ORDER BY derivation_type DESC, subject_id").all()) {
  const isTurn = r.derivation_type === "detailed_turn_compression";
  const input = isTurn ? get("pre_detailed_assembly", r.subject_id) : get("chunk_summary_detailed", r.subject_id);
  const inTok = input ? estimateTokens(input) : null;
  const outTok = estimateTokens(r.content);
  const [lo, hi] = isTurn ? [0.35, 0.65] : [0.08, 0.20];
  const ratio = inTok ? outTok / inTok : null;
  rows.push({ id: r.subject_id, kind: isTurn ? "turn-compress" : "chunk-brief", inTok, outTok, ratio: ratio ? (ratio*100).toFixed(1)+"%" : "?", window: `${lo*100}-${hi*100}%`, disp: r.disp });
  writeFileSync(`${outDir}/${r.subject_id}-${isTurn?"compress":"brief"}.txt`, r.content);
}
console.log(JSON.stringify(rows, null, 0).replaceAll("},{","},\n{"));
