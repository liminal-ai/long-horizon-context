// Spike 2: resume an unknown session id from a hand-built projection.
//   MODE=store  -> Options.sessionStore.load() serves the projection
//   MODE=file   -> projection written to CLAUDE_CONFIG_DIR/projects/<enc cwd>/<N>.jsonl
// Checks: load() consulted? synthetic assistant frame after trailing user line? memory of the secret?
import { query, type SDKUserMessage, type SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mode = process.env.MODE ?? "store";
const cwd = mkdtempSync(join(tmpdir(), "claude-lhc-spike2-"));
const N = randomUUID();
const now = new Date().toISOString();
const env = { cwd, version: "2.1.259", userType: "external", entrypoint: "sdk-ts", gitBranch: "", isSidechain: false, sessionId: N };
let parent: string | null = null;
const lines: Record<string, unknown>[] = [];
function user(content: unknown, extra: Record<string, unknown> = {}) {
  const uuid = randomUUID();
  lines.push({ parentUuid: parent, ...env, type: "user", message: { role: "user", content }, uuid, timestamp: now, ...extra });
  parent = uuid;
}
function assistant(blocks: unknown[], stop: string) {
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  for (const [i, b] of blocks.entries()) {
    const uuid = randomUUID();
    lines.push({ parentUuid: parent, ...env, type: "assistant", apiBlockIndex: i, requestId: `req_${randomUUID().replace(/-/g,"")}`, message: { model: "claude-sonnet-5", id, type: "message", role: "assistant", content: [b], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, uuid, timestamp: now });
    parent = uuid;
  }
}
user("[context · smooth]\n<t1>user asked to set up the project. assistant created README.md and confirmed.</t1>", { permissionMode: "bypassPermissions", promptSource: "sdk" });
user([{ type: "text", text: "Read notes.txt and tell me the secret word. Be brief." }], { permissionMode: "bypassPermissions", promptSource: "sdk" });
assistant([{ type: "tool_use", id: "toolu_spike2a", name: "Read", input: { file_path: join(cwd, "notes.txt") } }], "tool_use");
user([{ tool_use_id: "toolu_spike2a", type: "tool_result", content: "1\tthe secret word is walnut\n2\t" }]);
assistant([{ type: "text", text: "The secret word is **walnut**." }], "end_turn");
user("[compact continuation] cause=context_compacted_task_in_progress action=continue_existing_task newUserRequest=false waitForUser=false continuationTurnId=t3", { permissionMode: "bypassPermissions", promptSource: "sdk" });

let loadCalls = 0; const appended: string[] = [];
const store: SessionStore = {
  async append(key, entries) { for (const e of entries) appended.push(`${key.sessionId.slice(0,8)}${key.subpath ? "/" + key.subpath : ""}:${e.type}`); },
  async load(key) { loadCalls++; console.log("[store.load]", key); return key.sessionId === N ? (lines as any) : null; },
};
if (mode === "file") {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(process.env.HOME!, ".claude", "projects", enc); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${N}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log("wrote", join(dir, `${N}.jsonl`));
}
async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Without using any tools: what was the secret word, and what did we do before that?" }] }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
}
const q = query({ prompt: prompt(), options: {
  cwd, resume: N, pathToClaudeCodeExecutable: "claude", model: "claude-sonnet-5",
  permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
  systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["user", "project", "local"],
  ...(mode === "store" ? { sessionStore: store, sessionStoreFlush: "eager" as const } : {}),
  env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
}});
for await (const m of q) {
  const sub = (m as any).subtype ? `/${(m as any).subtype}` : "";
  const extra = m.type === "assistant" ? JSON.stringify((m as any).message.content).slice(0, 300) + " model=" + (m as any).message.model : m.type === "result" ? `num_turns=${(m as any).num_turns} result=${JSON.stringify((m as any).result).slice(0, 300)}` : m.type === "user" ? JSON.stringify((m as any).message.content).slice(0, 200) + (m as any).isSynthetic : "";
  console.log(`[wire] ${m.type}${sub} sid=${(m as any).session_id?.slice(0,8)} ${extra}`);
  if (m.type === "result") { q.close(); break; }
}
console.log("loadCalls", loadCalls, "appended", appended.length, appended.slice(0, 12));
