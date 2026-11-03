#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [work, turnsArg, linesArg] = process.argv.slice(2);
if (work === undefined || turnsArg === undefined) {
  console.error("usage: synth-transcript.mjs <work dir> <turns> [lines per result]");
  process.exit(2);
}
const turns = Number(turnsArg);
const lines = Number(linesArg ?? 190);
const sessionId = randomUUID();
const dir = join(homedir(), ".claude", "projects", work.replace(/[^A-Za-z0-9]/g, "-"));
const words = ["amber", "birch", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper"];
const start = Date.now() - turns * 60_000;
const rows = [];
let parent = null;
let clock = 0;
const push = (row) => {
  const uuid = randomUUID();
  rows.push({
    parentUuid: parent,
    isSidechain: false,
    ...row,
    uuid,
    timestamp: new Date(start + clock++ * 1000).toISOString(),
    userType: "external",
    entrypoint: "cli",
    cwd: work,
    sessionId,
    version: "2.1.317",
    gitBranch: "HEAD",
  });
  parent = uuid;
};
const assistant = (content) => ({
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
});
for (let t = 1; t <= turns; t++) {
  const file = `${work}/log-${t}.txt`;
  const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const body = Array.from({ length: lines }, (_, l) =>
    `${l + 1}\tline ${l}: ${Array.from({ length: 8 }, (_, k) => `${words[(l * 7 + k * 3 + t) % 10]}${(l * k + t) % 97}`).join(" ")}`,
  ).join("\n");
  push({ type: "user", message: { role: "user", content: `Turn ${t}: read ${file} and tell me its last line.` } });
  push(assistant([{ type: "tool_use", id, name: "Read", input: { file_path: file } }]));
  push({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: body }] } });
  push(assistant([{ type: "text", text: `Turn ${t}: the last line is line ${lines - 1}.` }]));
  push({ type: "system", subtype: "turn_duration", durationMs: 1000, isMeta: false });
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${sessionId}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
console.log(sessionId);
