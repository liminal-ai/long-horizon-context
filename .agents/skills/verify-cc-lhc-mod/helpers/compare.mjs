#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [exportFile, transcriptFile, ...ancestorFiles] = process.argv.slice(2);
if (exportFile === undefined || transcriptFile === undefined) {
  console.error("usage: compare.mjs <export.json> <transcript.jsonl> [<source transcript.jsonl>...]");
  process.exit(2);
}

const rowsOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((row) => typeof row.uuid === "string" && row.isSidechain !== true);

// A fork's thread is a copy of its source's, which can hold rows a compacted
// fork transcript no longer carries: each source, oldest first, adds its rows
// up to the last one the fork's transcript shares with it.
const own = rowsOf(transcriptFile);
const ownIds = new Set(own.map((row) => row.uuid));
const inherited = [];
for (const file of ancestorFiles) {
  const source = rowsOf(file);
  const end = source.findLastIndex((row) => ownIds.has(row.uuid));
  for (const row of source.slice(0, end + 1)) {
    if (!ownIds.has(row.uuid) && !inherited.some((r) => r.uuid === row.uuid)) inherited.push(row);
  }
}
const rows = [...inherited, ...own];

const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);
const textOf = (row) =>
  blocksOf(row.message?.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

// A command that prompts the model (a skill, a custom command) is recorded as
// the prompt "/name args"; a built-in one is filed right after its caveat row.
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const builtIn = new Set();
let afterCaveat = false;
for (const row of rows.filter((r) => r.type === "user")) {
  if (afterCaveat && textOf(row).trimStart().startsWith("<command-")) builtIn.add(row.uuid);
  afterCaveat = textOf(row).trimStart().startsWith("<local-command-caveat>");
}
const promptCommand = (row) => {
  if (row.type !== "user" || builtIn.has(row.uuid) || !textOf(row).trimStart().startsWith("<command-")) return undefined;
  const name = COMMAND_NAME.exec(textOf(row))?.[1]?.trim();
  // A typed /compact files its own plain line, recorded as the note; capture records its command row as nothing.
  if (name === undefined || name === "/compact") return undefined;
  const args = COMMAND_ARGS.exec(textOf(row))?.[1]?.trim();
  return args ? `${name} ${args}` : name;
};

const isPrompt = (row) =>
  promptCommand(row) !== undefined ||
  (row.type === "user" &&
  row.isMeta !== true &&
  row.isCompactSummary !== true &&
  row.origin?.kind !== "task-notification" &&
  blocksOf(row.message?.content).some(
    (block) =>
      block.type === "text" &&
      !/^(\[Request interrupted|\[runtime note\]|<command-|<local-command-|\/compact(\s|$))/.test(block.text.trimStart()),
  ));

// The live branch: the parent chain from the last row (across a compaction's
// logical parent), plus every side branch off it that holds no prompt, such
// as parallel tool calls. A side branch with a prompt is one a rewind left.
const byUuid = new Map(rows.map((row) => [row.uuid, row]));
const children = new Map();
for (const row of rows) children.set(row.parentUuid, [...(children.get(row.parentUuid) ?? []), row]);
const subtree = (row) => [row, ...(children.get(row.uuid) ?? []).flatMap(subtree)];
const live = new Set();
// A compact that follows another with no prompt between can name a logical parent the file never got; the
// chain before it ends at the last message row written ahead of the boundary.
const parentOf = (row) => {
  const parent = byUuid.get(row.parentUuid ?? row.logicalParentUuid);
  if (parent !== undefined || row.subtype !== "compact_boundary") return parent;
  return rows.slice(0, rows.indexOf(row)).findLast((r) => r.type === "user" || r.type === "assistant");
};
for (let row = rows.at(-1); row !== undefined && !live.has(row.uuid); row = parentOf(row)) {
  live.add(row.uuid);
}
for (const uuid of [...live]) {
  for (const child of children.get(uuid) ?? []) {
    const branch = live.has(child.uuid) ? [] : subtree(child);
    if (!branch.some(isPrompt)) for (const row of branch) live.add(row.uuid);
  }
}

function itemsOf(row) {
  const command = promptCommand(row);
  if (command !== undefined) return [`prompt ${command}`];
  const items = [];
  for (const block of blocksOf(row.message?.content)) {
    if (row.type === "assistant" && block.type === "text" && block.text !== "") items.push(`text ${block.text}`);
    if (row.type === "assistant" && block.type === "tool_use") items.push(`call ${block.id}`);
    if (row.type === "user" && block.type === "tool_result") items.push(`result ${block.tool_use_id}`);
    if (block.type === "text" && isPrompt(row)) items.push(`prompt ${block.text}`);
  }
  return items;
}

// After an LHC compaction's boundary Claude Code appends the installed view:
// LHC's labeled bands and runtime notes, and messages the record already holds.
// A prompt the person typed or sent by claude -p carries an origin or a prompt source; an installed row has neither.
const isPersons = (row) => row.origin !== undefined || row.promptSource !== undefined;
const isInstalled = (row, item, seen) =>
  !isPersons(row) && (seen.has(item) || /^prompt \[(context · |runtime note\])/.test(item));

const expected = [];
const seen = new Set();
let isInstalling = false;
// Capture records neither a native summary as a prompt nor Claude Code's own synthetic messages (the refill breaker's).
// An installed view's row that carries a call stands for it: the original can sit behind the boundary.
const isSynthetic = (row) =>
  row.message?.model === "<synthetic>" && !blocksOf(row.message?.content).some((block) => block.type === "tool_use");
for (const row of rows.filter((r) => live.has(r.uuid) && r.isCompactSummary !== true && !isSynthetic(r))) {
  if (row.subtype === "compact_boundary") {
    isInstalling = true;
    continue;
  }
  const items = itemsOf(row);
  if (items.length === 0) continue;
  if (isInstalling && items.every((item) => isInstalled(row, item, seen))) continue;
  isInstalling = false;
  for (const item of items) {
    expected.push(item);
    seen.add(item);
  }
}

const recorded = [];
const exported = JSON.parse(readFileSync(exportFile, "utf8"));
// An exit mid-tool can drop the cut-off call and its result from the transcript after capture recorded both:
// the index in recorded of each call that closes a turn which closed aborted/interrupted.
const cutOffCalls = [];
for (const turn of exported.turns) {
  for (const message of turn.messages) {
    const content = message.blocks?.[0]?.content ?? {};
    if (message.kind === "assistant_text") recorded.push(`text ${content.text}`);
    if (message.kind === "tool_call") recorded.push(`call ${content.toolCallId}`);
    if (message.kind === "tool_result") recorded.push(`result ${content.toolCallId}`);
    if (message.kind === "user_prompt" && content.steer !== true) recorded.push(`prompt ${content.text}`);
  }
  const [last, beforeLast] = [turn.messages.at(-1), turn.messages.at(-2)];
  const id = beforeLast?.blocks?.[0]?.content?.toolCallId;
  if (
    turn.status !== "open" &&
    turn.outcome === "aborted" &&
    turn.outcomeReason === "interrupted" &&
    beforeLast?.kind === "tool_call" &&
    last?.kind === "tool_result" &&
    last.blocks?.[0]?.content?.toolCallId === id
  ) {
    cutOffCalls.push(recorded.length - 2);
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
const extras = [...have.keys()].filter((item) => !want.has(item));
// The transcript must also end that turn at the cut-off: after the last item it shares with the turn
// comes whatever the export records after the pair, or nothing.
const nthIndex = (items, item, n) => items.flatMap((x, i) => (x === item ? [i] : []))[n] ?? -1;
const followsInTranscript = (index) => {
  const last = recorded[index - 1];
  if (last === undefined) return expected[0] === recorded[index + 2];
  const at = nthIndex(expected, last, recorded.slice(0, index).filter((x) => x === last).length - 1);
  return at !== -1 && expected[at + 1] === recorded[index + 2];
};
const dropped = [];
for (const index of cutOffCalls) {
  const [call, result] = [recorded[index], recorded[index + 1]];
  if (have.get(call) === 1 && have.get(result) === 1 && !want.has(call) && !want.has(result) && followsInTranscript(index)) {
    dropped.push(call.slice("call ".length));
  }
}
for (const id of dropped) console.log(`dropped at exit ${id}: one call and result in a turn closed aborted/interrupted`);
for (const item of extras) {
  if (dropped.some((id) => item === `call ${id}` || item === `result ${id}`)) continue;
  console.log(`extra ${item.slice(0, 120)}`);
  failures++;
}
console.log(`transcript items ${expected.length}, thread items ${recorded.length}`);
console.log(`compare: ${failures === 0 ? "PASS" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
