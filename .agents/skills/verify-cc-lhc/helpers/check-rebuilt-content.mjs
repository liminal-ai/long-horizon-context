#!/usr/bin/env node
// Grades a rebuilt session transcript against the session it was rebuilt from.
// The rebuilt prefix ends at the last "[runtime note]" line; anything after it is the resumed
// child's own output. The product (lhc buildSessionThreadView) renders a compacted view as
// "[context · …]" band blocks for every source entry before its compact point, followed by the
// entries after that point copied verbatim. So the verbatim entries must be an exact, in-order
// suffix of the source, and any source entry they leave out must be covered by a context block.
// Entries are compared one text block at a time, because the writer emits one assistant line per
// block. Runtime notes are dropped on both sides: the product re-emits retained ones and appends
// a new receipt, and neither is conversation history.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const sourcePath = opt("--source");
const rebuiltPath = opt("--rebuilt");
if (sourcePath === undefined || rebuiltPath === undefined) {
  console.error("usage: check-rebuilt-content.mjs --source OLD.jsonl --rebuilt NEW.jsonl");
  process.exit(2);
}

function entries(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const item = JSON.parse(line);
    if ((item.type !== "user" && item.type !== "assistant") || item.isMeta === true || item.isSidechain === true) continue;
    const content = item.message?.content;
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.filter((b) => b.type === "text").map((b) => b.text)
          : [];
    for (const text of texts) if (text !== "") out.push({ role: item.type, text });
  }
  return out;
}

const show = (e) => `${e.role}: ${JSON.stringify(e.text.slice(0, 120))}`;
const isContext = (e) => e.role === "user" && e.text.startsWith("[context · ");
const isNote = (e) => e.role === "user" && e.text.startsWith("[runtime note]");
const problems = [];
const source = entries(sourcePath).filter((e) => !isNote(e));
const all = entries(rebuiltPath);
const noteAt = all.findLastIndex(isNote);
if (noteAt < 0) {
  console.log("FAIL no [runtime note] line, so the rebuilt prefix cannot be located");
  process.exit(1);
}
const rebuilt = all.slice(0, noteAt).filter((e) => !isNote(e));
const context = rebuilt.filter(isContext);
const verbatim = rebuilt.filter((e) => !isContext(e));

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
const compactedCount = source.length - verbatim.length;
if (problems.length === 0) {
  const tail = source.slice(compactedCount);
  verbatim.forEach((e, i) => {
    const want = tail[i];
    if (e.role !== want.role || e.text !== want.text) {
      problems.push(`verbatim entry ${i + 1} differs from source tail: got ${show(e)}, want ${show(want)}`);
    }
  });
}
if (compactedCount > 0 && context.length === 0) {
  problems.push(
    `history lost: ${compactedCount} source entries are neither kept verbatim nor covered by a [context · …] block`,
  );
}
// Context blocks carry no provenance in the transcript, so double coverage is judged by text: a
// retained prompt inside a block is only suspect when no compacted source entry contains it.
const compactedText = source.slice(0, compactedCount).map((e) => e.text);
for (const e of verbatim.filter((v) => v.role === "user")) {
  if (context.some((c) => c.text.includes(e.text)) && !compactedText.some((t) => t.includes(e.text))) {
    problems.push(`user entry kept verbatim and also inside a compacted block: ${show(e)}`);
  }
}

const summary = `source=${source.length} rebuilt_context=${context.length} rebuilt_verbatim=${verbatim.length}`;
if (problems.length > 0) {
  console.log(`FAIL ${summary}`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`OK ${summary}`);
