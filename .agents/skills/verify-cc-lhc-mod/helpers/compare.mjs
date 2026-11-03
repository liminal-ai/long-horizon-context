#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [exportFile, transcriptFile] = process.argv.slice(2);
if (exportFile === undefined || transcriptFile === undefined) {
  console.error("usage: compare.mjs <export.json> <transcript.jsonl>");
  process.exit(2);
}

const rows = readFileSync(transcriptFile, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))
  .filter((row) => typeof row.uuid === "string" && row.isSidechain !== true);

const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);
const isPrompt = (row) =>
  row.type === "user" &&
  row.isMeta !== true &&
  row.isCompactSummary !== true &&
  row.origin?.kind !== "task-notification" &&
  blocksOf(row.message?.content).some(
    (block) => block.type === "text" && !/^(\[Request interrupted|<command-|<local-command-)/.test(block.text.trimStart()),
  );

// The live branch: the parent chain from the last row (across a compaction's
// logical parent), plus every side branch off it that holds no prompt, such
// as parallel tool calls. A side branch with a prompt is one a rewind left.
const byUuid = new Map(rows.map((row) => [row.uuid, row]));
const children = new Map();
for (const row of rows) children.set(row.parentUuid, [...(children.get(row.parentUuid) ?? []), row]);
const subtree = (row) => [row, ...(children.get(row.uuid) ?? []).flatMap(subtree)];
const live = new Set();
for (let row = rows.at(-1); row !== undefined; row = byUuid.get(row.parentUuid ?? row.logicalParentUuid)) {
  live.add(row.uuid);
}
for (const uuid of [...live]) {
  for (const child of children.get(uuid) ?? []) {
    const branch = live.has(child.uuid) ? [] : subtree(child);
    if (!branch.some(isPrompt)) for (const row of branch) live.add(row.uuid);
  }
}

const expected = [];
for (const row of rows.filter((r) => live.has(r.uuid) && r.isCompactSummary !== true)) {
  for (const block of blocksOf(row.message?.content)) {
    if (row.type === "assistant" && block.type === "text" && block.text !== "") expected.push(`text ${block.text}`);
    if (row.type === "assistant" && block.type === "tool_use") expected.push(`call ${block.id}`);
    if (row.type === "user" && block.type === "tool_result") expected.push(`result ${block.tool_use_id}`);
    if (block.type === "text" && isPrompt(row)) expected.push(`prompt ${block.text}`);
  }
}

const recorded = [];
const exported = JSON.parse(readFileSync(exportFile, "utf8"));
for (const turn of exported.turns) {
  for (const message of turn.messages) {
    const content = message.blocks?.[0]?.content ?? {};
    if (message.kind === "assistant_text") recorded.push(`text ${content.text}`);
    if (message.kind === "tool_call") recorded.push(`call ${content.toolCallId}`);
    if (message.kind === "tool_result") recorded.push(`result ${content.toolCallId}`);
    if (message.kind === "user_prompt" && content.steer !== true) recorded.push(`prompt ${content.text}`);
  }
}

const count = (items) => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
const want = count(expected);
const have = count(recorded);
let failures = 0;
for (const [item, n] of want) {
  const got = have.get(item) ?? 0;
  if (got < n) console.log(`missing ${item.slice(0, 120)}`);
  if (got > n) console.log(`duplicated x${got} ${item.slice(0, 120)}`);
  if (got !== n) failures++;
}
for (const [item] of have) {
  if (!want.has(item)) {
    console.log(`extra ${item.slice(0, 120)}`);
    failures++;
  }
}
console.log(`transcript items ${expected.length}, thread items ${recorded.length}`);
console.log(`compare: ${failures === 0 ? "PASS" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
