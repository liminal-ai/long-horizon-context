#!/usr/bin/env node
// Grades a rebuilt session transcript against two oracles. The rebuilt prefix is every line before
// the receipt, the last "[runtime note]" line. Whatever follows it is the resumed child's own output.
// 1. The canonical LHC session view the writer rendered from (--view, from read-seam-view.mjs or a
//    production roundtrip). The prefix must equal the production writer's render of that view, line
//    for line, so a lost, extra, changed or reordered [context · …] block or retained entry fails.
// 2. The source transcript. Its conversation, read through the intake's own mapping, must end with
//    exactly the prefix's retained conversation. The view cannot see what intake got wrong (LH-245),
//    and this can.
import { readFileSync } from "node:fs";

const root = new URL("../../../../", import.meta.url);
const { mapRolloutLine } = await import(new URL("packages/cc-lhc/dist/intake/map.js", root).href);
const { buildRolloutLines } = await import(new URL("packages/cc-lhc/dist/rollout/rebuild.js", root).href);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const sourcePath = opt("--source");
const rebuiltPath = opt("--rebuilt");
const viewPath = opt("--view");
if (sourcePath === undefined || rebuiltPath === undefined || viewPath === undefined) {
  console.error("usage: check-rebuilt-content.mjs --source OLD.jsonl --rebuilt NEW.jsonl --view VIEW.json");
  process.exit(2);
}

const jsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
const userText = (line) =>
  line.type === "user" && typeof line.message?.content === "string" ? line.message.content : "";
const isBand = (line) => userText(line).startsWith("[context · ");
const body = (line) => JSON.stringify([line.type, line.message?.content]);
const showLine = (line) => (line === undefined ? "nothing" : body(line).slice(0, 160));
const show = (e) => `${e.role}: ${JSON.stringify(e.text.slice(0, 120))}`;
const leadingBands = (lines) => {
  const end = lines.findIndex((l) => !isBand(l));
  return end < 0 ? lines.length : end;
};
const problems = [];

const all = jsonl(rebuiltPath);
const noteAt = all.findLastIndex((l) => userText(l).startsWith("[runtime note] "));
if (noteAt < 0) {
  console.log("FAIL no [runtime note] line, so the rebuilt prefix cannot be located");
  process.exit(1);
}
const prefix = all.slice(0, noteAt);

const expected = [];
for (const entry of JSON.parse(readFileSync(viewPath, "utf8")).entries) {
  const marker = (entry.sourceKinds ?? []).includes("compact_continuation_marker");
  for (const { line } of buildRolloutLines({ entries: [entry], newSessionId: "view", envelope: { cwd: "" } })) {
    expected.push({ line, marker });
  }
}
const wantBands = expected.slice(0, leadingBands(expected.map((e) => e.line))).map((e) => userText(e.line));
const gotBands = prefix.filter(isBand).map(userText);
if (gotBands.length !== wantBands.length) {
  problems.push(`context blocks: rebuilt has ${gotBands.length}, the canonical view has ${wantBands.length}`);
}
const firstBandDiff = wantBands.findIndex((want, i) => i < gotBands.length && gotBands[i] !== want);
if (firstBandDiff >= 0) {
  problems.push(
    `context block ${firstBandDiff + 1} differs from the canonical view: got ${JSON.stringify(gotBands[firstBandDiff].slice(0, 120))}, want ${JSON.stringify(wantBands[firstBandDiff].slice(0, 120))}`,
  );
}
for (let i = 0; i < Math.max(prefix.length, expected.length); i += 1) {
  if (prefix[i] === undefined || expected[i] === undefined || body(prefix[i]) !== body(expected[i].line)) {
    problems.push(
      `rebuilt line ${i + 1} differs from the writer's render of the canonical view: got ${showLine(prefix[i])}, want ${showLine(expected[i]?.line)}`,
    );
    break;
  }
}

// Intake drops chrome and joins user text blocks; runtime notes are not conversation.
function conversation(lines, skip) {
  const out = [];
  lines.forEach((line, i) => {
    if (skip(line, i)) return;
    for (const event of mapRolloutLine(line, i).events) {
      if (event.eventKind === "user_prompt") out.push({ role: "user", text: event.payload.text });
      if (event.eventKind === "assistant_text") out.push({ role: "assistant", text: event.payload.text });
    }
  });
  return out;
}
// Claude also writes api-request-blob snapshots whose message.role is "user", which intake maps as
// prompts (LH-245). Only real transcript records count as source conversation.
const RECORD_TYPES = new Set(["user", "assistant", "summary"]);
const source = conversation(jsonl(sourcePath), (l) => !RECORD_TYPES.has(l.type));
const markers = new Set(expected.filter((e) => e.marker).map((e) => userText(e.line)));
const bandEnd = leadingBands(prefix);
const verbatim = conversation(prefix, (l, i) => i < bandEnd || markers.has(userText(l)));

const key = (e) => `${e.role}\0${e.text}`;
const have = new Map();
for (const e of source) have.set(key(e), (have.get(key(e)) ?? 0) + 1);
const seen = new Map();
for (const e of verbatim) {
  const n = (seen.get(key(e)) ?? 0) + 1;
  seen.set(key(e), n);
  const max = have.get(key(e)) ?? 0;
  if (max === 0) problems.push(`entry not in source: ${show(e)}`);
  else if (n === max + 1) problems.push(`entry duplicated (${n} copies, source has ${max}): ${show(e)}`);
}
if (verbatim.length <= source.length && !problems.some((p) => p.startsWith("entry "))) {
  const tail = source.slice(source.length - verbatim.length);
  const i = verbatim.findIndex((e, j) => key(e) !== key(tail[j]));
  if (i >= 0) problems.push(`verbatim entry ${i + 1} differs from source tail: got ${show(verbatim[i])}, want ${show(tail[i])}`);
}

const summary = `view_lines=${expected.length} context=${gotBands.length} retained=${verbatim.length} source=${source.length}`;
if (problems.length > 0) {
  console.log(`FAIL ${summary}`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`OK ${summary}`);
