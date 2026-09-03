// Which wire messages carry usage on a fresh session's first turn? Runs N fresh sessions, prints every
// assistant / stream message_start with model, id, and usage, plus what the sidecar's meter would read.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextTokens, Sidecar, type Wire } from "./lib/sidecar.ts";
const LHC_HOME = process.env.T3CODE_LHC_HOME ?? join(import.meta.dir, "../../../../home/t3code-lhc");
const N = Number(process.env.N ?? 4);
for (let i = 1; i <= N; i++) {
  const cwd = mkdtempSync(join(tmpdir(), "usage-probe-"));
  const s = new Sidecar(`probe${i}`, LHC_HOME, true);
  s.send({ type: "start", options: { cwd, model: "claude-sonnet-5", pathToClaudeCodeExecutable: "claude", systemPrompt: "You are a careful agent.", settingSources: [], tools: ["Read"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, includePartialMessages: process.env.PARTIAL !== "0", env: process.env, ...(process.env.STRICT === "1" ? { strictMcpConfig: true, mcpServers: {} } : {}), sessionId: randomUUID(), settings: { autoCompactWindow: 300_000 } } });
  const t = await s.turn("Reply with just the word: ready");
  const t2 = await s.turn("Reply with just the word: again");
  console.log(`── session ${i}: turn 1 context ${t.context}, turn 2 context ${t2.context}, cwd ${cwd}`);
  for (const m of s.messages.filter((m) => m["type"] === "system" || m["type"] === "mcp_status" || String(m["type"]).includes("mcp") || String(m["type"]).includes("tools"))) {
    const tools = Array.isArray(m["tools"]) ? (m["tools"] as string[]) : null;
    console.log(`  ${m["type"]}/${m["subtype"] ?? ""} ${tools ? `tools=${tools.length} [${tools.filter((t) => t.startsWith("mcp__")).length} mcp]` : ""} mcp_servers=${JSON.stringify(m["mcp_servers"] ?? m["servers"] ?? "")} ${m["subtype"] === "init" ? `skills=${JSON.stringify((m["skills"] as unknown[] | undefined)?.length)} agents=${JSON.stringify((m["agents"] as unknown[] | undefined)?.length)} slash=${JSON.stringify((m["slash_commands"] as unknown[] | undefined)?.length)}` : ""}`);
  }
  for (const m of t.wire.concat(t2.wire)) {
    if (m["type"] === "assistant") {
      const inner = m["message"] as Wire;
      console.log(`  assistant model=${inner["model"]} id=${String(inner["id"]).slice(-8)} blocks=${(inner["content"] as Wire[]).map((b) => b["type"]).join("+")} parent=${m["parent_tool_use_id"]} usage=${JSON.stringify(inner["usage"])} → ${contextTokens(m)}`);
    }
  }
  await s.stop();
  const sid = String(t.wire.find((m) => m["type"] === "system")?.["session_id"]);
  const { readFileSync, existsSync } = await import("node:fs");
  const file = join(process.env.HOME!, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
  if (!existsSync(file)) { console.log(`  no transcript at ${file}`); continue; }
  if (process.env.JSONL !== "1") continue;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as Wire;
    const msg = e["message"] as Wire | undefined;
    const content = msg?.["content"];
    const size = JSON.stringify(content ?? e).length;
    const head = typeof content === "string" ? content.slice(0, 80) : Array.isArray(content) ? (content as Wire[]).map((b) => b["type"] === "text" ? `text:${String(b["text"]).slice(0, 80)}` : String(b["type"])).join("|") : JSON.stringify(e).slice(0, 80);
    console.log(`  jsonl ${String(e["type"]).padEnd(12)} ${String(size).padStart(7)} chars ${JSON.stringify(head)}`);
  }
}
process.exit(0);
