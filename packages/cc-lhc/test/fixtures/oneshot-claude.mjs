#!/usr/bin/env node
// A minimal stand-in Claude Code for one-shot (`-p`) run() tests: it writes
// the prompt and a one-line answer to the session transcript cc-lhc points it
// at (`--session-id` starts one, `--resume` needs an existing one), and exits 0.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const resumed = flag("--resume");
const sessionId = resumed ?? flag("--session-id");
const valued = new Set(["--resume", "--session-id", "--model", "--effort", "--output-format", "--settings"]);
let prompt = "";
for (let i = 0; i < argv.length; i++) {
  if (valued.has(argv[i])) {
    i++;
    continue;
  }
  if (argv[i].startsWith("-")) continue;
  prompt = argv[i];
  break;
}
if (!argv.includes("-p") || sessionId === undefined || prompt === "") {
  process.stderr.write(`oneshot-claude: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const cwd = process.cwd();
const file = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"), `${sessionId}.jsonl`);
if (resumed !== undefined && !existsSync(file)) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
mkdirSync(dirname(file), { recursive: true });

const base = { isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.280" };
const userUuid = randomUUID();
const lines = [
  { ...base, type: "user", uuid: userUuid, parentUuid: null, timestamp: new Date().toISOString(), message: { role: "user", content: prompt } },
  {
    ...base,
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: userUuid,
    timestamp: new Date().toISOString(),
    requestId: `req_${randomUUID()}`,
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-standin",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    },
  },
];
appendFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
process.stdout.write("ok\n");
process.exit(0);
