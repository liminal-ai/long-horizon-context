// Spike 1: SDK 0.3.170 under bun driving the box's claude; fresh session, one tool turn.
// Prints every wire message type and the transcript file the CLI wrote.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cwd = mkdtempSync(join(tmpdir(), "claude-lhc-spike-"));
writeFileSync(join(cwd, "notes.txt"), "the secret word is walnut\n");
const sessionId = randomUUID();
async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Read notes.txt and tell me the secret word. Be brief." }] }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
}
const q = query({
  prompt: prompt(),
  options: {
    cwd, sessionId, pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
    model: "claude-sonnet-5", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["user", "project", "local"],
    includePartialMessages: false,
    env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
  },
});
for await (const m of q) {
  const sub = (m as any).subtype ? `/${(m as any).subtype}` : "";
  const extra = m.type === "assistant" ? JSON.stringify((m as any).message.content.map((b: any) => b.type)) + " usage=" + JSON.stringify((m as any).message.usage) : m.type === "user" ? JSON.stringify((m as any).message.content).slice(0, 120) : m.type === "result" ? `num_turns=${(m as any).num_turns} usage=${JSON.stringify((m as any).usage)} result=${JSON.stringify((m as any).result).slice(0,80)}` : "";
  console.log(`[wire] ${m.type}${sub} sid=${(m as any).session_id} ${extra}`);
  if (m.type === "result") { q.close(); break; }
}
console.log("cwd", cwd, "session", sessionId);
const projects = join(process.env.HOME!, ".claude", "projects");
for (const dir of readdirSync(projects)) {
  const f = join(projects, dir, `${sessionId}.jsonl`);
  try { const lines = readFileSync(f, "utf8").trim().split("\n"); console.log("transcript", f, lines.length, "lines"); for (const l of lines) { const o = JSON.parse(l); console.log("  ", o.type, o.uuid ?? "", o.parentUuid ?? "", Object.keys(o).join(",")); } writeFileSync("/tmp/claude-lhc-spike1.jsonl", lines.join("\n")); } catch {}
}
