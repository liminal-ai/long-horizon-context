import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { forkSession, type LhcQuery, type LhcQueryOptions, query } from "claude-lhc";

const work = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined) throw new Error("usage: consumer.ts <work dir>");
const cwd = join(work, "cwd");
const home = join(work, "lhc");
mkdirSync(cwd, { recursive: true });

const options = (extra: LhcQueryOptions = {}): LhcQueryOptions => ({
  cwd,
  model: process.env.MODEL ?? "claude-sonnet-5",
  pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  stderr: (line) => process.stderr.write(line),
  lhc: { home, compact: { trigger: 300_000, target: 180_000 } },
  ...extra,
});

class Input implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;

  push(text: string): void {
    this.#items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) yield next;
      else await new Promise<void>((wake) => (this.#wake = wake));
    }
  }
}

class Session {
  readonly input = new Input();
  readonly q: LhcQuery;

  constructor(extra: LhcQueryOptions = {}) {
    this.q = query({ prompt: this.input, options: options(extra) });
  }

  async turn(text: string): Promise<{ answer: string; lastAssistantUuid: string | undefined; seen: SDKMessage[] }> {
    this.input.push(text);
    const seen: SDKMessage[] = [];
    for (;;) {
      const next = await this.q.next();
      if (next.done) throw new Error(`the stream ended during "${text}"`);
      seen.push(next.value);
      if (next.value.type !== "result") continue;
      if (next.value.subtype !== "success" || next.value.is_error)
        throw new Error(`"${text}" failed: ${JSON.stringify(next.value)}`);
      const assistants = seen.filter((m) => m.type === "assistant" && m.parent_tool_use_id === null);
      return { answer: next.value.result, lastAssistantUuid: assistants.at(-1)?.uuid, seen };
    }
  }

  async close(): Promise<void> {
    this.q.close();
    for await (const _ of this.q);
  }
}

function step(name: string, ok: boolean, detail: string): void {
  console.log(`CONSUMER ${name}: ${ok ? "ok" : "FAIL"} ${detail}`);
  if (!ok) {
    console.log("CONSUMER: FAIL");
    process.exit(1);
  }
}

const tag = randomUUID().slice(0, 6).toUpperCase();
const first = `ALPHA-${tag}`;
const second = `BRAVO-${tag}`;
const ask = "List every secret word I asked you to remember, separated by spaces, or NONE. Reply with the words only.";
const sessionId = randomUUID();

const host = new Session({ sessionId });
const kept = await host.turn(`Remember the secret word ${first}. Reply with just OK.`);
step("start", kept.lastAssistantUuid !== undefined, `session ${sessionId} answered "${kept.answer.trim()}"`);
const anchor = kept.lastAssistantUuid as string;
const answered = await host.turn(`Remember the second secret word ${second}. Reply with just OK.`);
step("answer", answered.answer.length > 0, `"${answered.answer.trim()}"`);
const compacted = await host.turn("/compact");
const boundary = compacted.seen.find((m) => m.type === "system" && m.subtype === "compact_boundary");
step("compact", boundary !== undefined, `boundary in generation ${boundary?.session_id}`);
await host.close();
step("close", true, "the stream ended after close()");

const fork = await forkSession(sessionId, { upToMessageId: anchor, lhc: { home } });
const forked = new Session({ resume: fork.sessionId });
const fromFork = await forked.turn(ask);
await forked.close();
step(
  "fork",
  fromFork.answer.includes(first) && !fromFork.answer.includes(second),
  `forked at ${anchor} as ${fork.sessionId}, answered "${fromFork.answer.trim()}"`,
);

const restarted = new Session({ resume: sessionId });
const recall = await restarted.turn(ask);
await restarted.close();
step(
  "restart",
  recall.answer.includes(first) && recall.answer.includes(second),
  `the source resumed by its first session id after the fork, answered "${recall.answer.trim()}"`,
);

const rolledBack = new Session({ resume: sessionId, resumeSessionAt: anchor });
const afterRollback = await rolledBack.turn(ask);
await rolledBack.close();
step(
  "rollback",
  afterRollback.answer.includes(first) && !afterRollback.answer.includes(second),
  `rolled back to ${anchor}, answered "${afterRollback.answer.trim()}"`,
);

console.log("CONSUMER: PASS");
