import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const cwd = mkdtempSync(join(tmpdir(), "claude-lhc-spike-"));
writeFileSync(join(cwd, "notes.txt"), "the secret word is walnut\n");
const sessionId = randomUUID();
async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "Read notes.txt and tell me the secret word. Be brief." }],
    },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}
const q = query({
  prompt: prompt(),
  options: {
    cwd,
    sessionId,
    pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
    model: "claude-sonnet-5",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    includePartialMessages: false,
    env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
  },
});
for await (const m of q) {
  const sub = "subtype" in m && m.subtype ? `/${m.subtype}` : "";
  const extra =
    m.type === "assistant"
      ? JSON.stringify(m.message.content.map((b) => b.type)) + " usage=" + JSON.stringify(m.message.usage)
      : m.type === "user"
        ? JSON.stringify(m.message.content).slice(0, 120)
        : m.type === "result"
          ? `num_turns=${m.num_turns} usage=${JSON.stringify(m.usage)} result=${JSON.stringify("result" in m ? m.result : undefined).slice(0, 80)}`
          : "";
  console.log(`[wire] ${m.type}${sub} sid=${"session_id" in m ? m.session_id : undefined} ${extra}`);
  if (m.type === "result") {
    q.close();
    break;
  }
}
console.log("cwd", cwd, "session", sessionId);
const projects = join(process.env.HOME!, ".claude", "projects");
for (const dir of readdirSync(projects)) {
  const f = join(projects, dir, `${sessionId}.jsonl`);
  try {
    const lines = readFileSync(f, "utf8").trim().split("\n");
    console.log("transcript", f, lines.length, "lines");
    for (const l of lines) {
      const o = JSON.parse(l);
      console.log("  ", o.type, o.uuid ?? "", o.parentUuid ?? "", Object.keys(o).join(","));
    }
    writeFileSync("/tmp/claude-lhc-spike1.jsonl", lines.join("\n"));
  } catch {}
}
