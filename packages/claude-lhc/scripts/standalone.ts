/**
 * Standalone proof, no t3code: drives the sidecar over its JSONL protocol.
 *   1. start a fresh session; one tool turn (read notes.txt → secret word)
 *   2. /compact → compact_boundary + result; LHC has a view; both session ids alias the thread
 *   3. stop the sidecar; start a new one with resume: <second session id>
 *   4. one no-tools turn that must recall the secret
 * Exit 0 on pass. T3CODE_LHC_HOME defaults to <builder dir>/home/t3code-lhc.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { initLhc, createDeterministicInferenceCallbacks, threads, type Lhc } from "lhc";
import type { DriverFrame, SidecarFrame } from "../src/protocol.ts";

const HERE = import.meta.dir;
const BIN = resolve(HERE, "../bin/claude-lhc");
const LHC_HOME = process.env.T3CODE_LHC_HOME ?? resolve(HERE, "../../../../home/t3code-lhc");
const SECRET = ["amber", "birch", "cedar", "fjord", "glade", "kestrel", "lagoon", "marble"][Math.floor(Math.random() * 8)]!;
const MODEL = process.env.MODEL ?? "claude-sonnet-5";
const cwd = mkdtempSync(join(tmpdir(), "claude-lhc-standalone-"));
writeFileSync(join(cwd, "notes.txt"), `the secret word is ${SECRET}\n`);
const log = (...parts: unknown[]) => console.error(`[standalone ${new Date().toISOString().slice(11, 19)}]`, ...parts);
function fail(reason: string): never { console.log(`RESULT: FAIL — ${reason}`); process.exit(1); }

class Sidecar {
  child: ChildProcess;
  messages: Array<Record<string, unknown>> = [];
  requests: Array<Record<string, unknown>> = [];
  error: string | null = null;
  exited: Promise<number | null>;
  #waiters: Array<() => void> = [];
  constructor(label: string) {
    this.child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, T3CODE_LHC_HOME: LHC_HOME } });
    this.exited = new Promise((r) => this.child.on("exit", (code) => { r(code); this.#notify(); }));
    this.child.stderr!.on("data", (c: Buffer) => process.stderr.write(c.toString().split("\n").filter(Boolean).map((l) => `  [${label}] ${l}\n`).join("")));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const frame = JSON.parse(line) as SidecarFrame;
      if (frame.type === "msg") {
        const m = frame.message as unknown as Record<string, unknown>;
        this.messages.push(m);
        const sub = typeof m["subtype"] === "string" ? `/${m["subtype"]}` : "";
        const detail = m["type"] === "assistant" ? JSON.stringify(((m["message"] as any).content as any[]).map((b) => b.type === "text" ? b.text : b.type)).slice(0, 160)
          : m["type"] === "result" ? `num_turns=${m["num_turns"]} ${JSON.stringify(m["result"]).slice(0, 120)}`
          : m["type"] === "system" && m["subtype"] === "compact_boundary" ? JSON.stringify(m["compact_metadata"]) : "";
        log(`  ← ${m["type"]}${sub} sid=${String(m["session_id"]).slice(0, 8)} ${detail}`);
      } else if (frame.type === "req") {
        this.requests.push(frame as unknown as Record<string, unknown>);
        // Approve everything (the smoke runs full-access; this exercises the wire anyway).
        this.send({ type: "res", id: frame.id, ok: true, value: frame.method === "canUseTool" ? { behavior: "allow", updatedInput: (frame.params as any).input } : {} });
      } else if (frame.type === "error") {
        this.error = frame.message;
      }
      this.#notify();
    });
  }
  #notify() { const w = this.#waiters; this.#waiters = []; for (const f of w) f(); }
  send(frame: DriverFrame) { this.child.stdin!.write(`${JSON.stringify(frame)}\n`); }
  async waitFor(pred: () => boolean, timeoutMs = 180_000, what = "condition"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (this.error) fail(`sidecar error: ${this.error}`);
      if (Date.now() > deadline) fail(`timeout waiting for ${what}`);
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 1000); });
    }
  }
  prompt(text: string) {
    this.send({ type: "user", message: { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" } as never });
  }
  async turn(text: string, timeoutMs = 180_000): Promise<{ text: string; tools: number; sessionId: string }> {
    const from = this.messages.length;
    this.prompt(text);
    await this.waitFor(() => this.messages.slice(from).some((m) => m["type"] === "result"), timeoutMs, `result for "${text.slice(0, 40)}"`);
    const slice = this.messages.slice(from);
    const result = slice.find((m) => m["type"] === "result")!;
    const assistant = slice.filter((m) => m["type"] === "assistant");
    const textOut = assistant.flatMap((m) => ((m["message"] as any).content as any[]).filter((b) => b.type === "text").map((b) => b.text)).join("\n");
    const tools = assistant.flatMap((m) => ((m["message"] as any).content as any[]).filter((b) => b.type === "tool_use")).length;
    return { text: textOut || String(result["result"] ?? ""), tools, sessionId: String(result["session_id"]) };
  }
  async stop(): Promise<void> { this.child.stdin!.end(); await Promise.race([this.exited, new Promise((r) => setTimeout(r, 8000))]); if (this.child.exitCode === null) this.child.kill("SIGKILL"); }
}

const baseOptions = (extra: Record<string, unknown>) => ({
  cwd, model: MODEL, pathToClaudeCodeExecutable: "claude",
  systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["user", "project", "local"],
  // "default" so tool approvals cross the wire as canUseTool requests (the script allows them);
  // PERMISSION_MODE=bypassPermissions mirrors the smoke client's full-access threads.
  permissionMode: process.env.PERMISSION_MODE ?? "default",
  ...(process.env.PERMISSION_MODE === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
  includePartialMessages: true,
  settings: { autoCompactWindow: 300000 }, env: process.env, additionalDirectories: [cwd], ...extra,
});

log("LHC home", LHC_HOME, "cwd", cwd, "secret", SECRET);
const first = randomUUID();
const a = new Sidecar("sidecar-1");
a.send({ type: "start", options: baseOptions({ sessionId: first }) });
// The SDK spawns the child when the first prompt is pulled, so system/init arrives with turn 1.
const t1 = await a.turn("Read notes.txt in this directory and tell me the secret word. Be brief.");
const initSid = String(a.messages.find((m) => m["subtype"] === "init")?.["session_id"]);
if (initSid !== first) fail(`init session ${initSid} != requested ${first}`);
log("✓ start: init with requested session id");
if (t1.tools < 1) fail("turn 1 used no tools");
if (!t1.text.toLowerCase().includes(SECRET)) fail(`turn 1 reply lacks secret: ${t1.text}`);
log(`✓ turn 1: ${t1.tools} tool call(s), reply has secret`);

const t2 = await a.turn("Create a file called answer.txt containing exactly the secret word, then confirm. Be brief.");
if (t2.tools < 1) fail("turn 2 used no tools");
log(`✓ turn 2: ${t2.tools} tool call(s); ${a.requests.length} approval request(s) answered over the wire`);

const beforeCompact = a.messages.length;
a.prompt("/compact");
await a.waitFor(() => a.messages.slice(beforeCompact).some((m) => m["type"] === "result"), 120_000, "/compact result");
const boundary = a.messages.slice(beforeCompact).find((m) => m["type"] === "system" && m["subtype"] === "compact_boundary");
if (!boundary) fail("no compact_boundary after /compact");
const second = String(boundary["session_id"]);
if (second === first) fail("compact did not mint a new session id");
log(`✓ /compact: boundary ${JSON.stringify(boundary["compact_metadata"])}, new session ${second.slice(0, 8)}`);
const t3 = await a.turn("Without using tools: what is the secret word? One word.");
if (!a.messages.some((m) => m["type"] === "system" && m["subtype"] === "init" && m["session_id"] === second)) fail("new generation never reported system/init");
if (!t3.text.toLowerCase().includes(SECRET)) fail(`post-compact turn lacks secret: ${t3.text}`);
if (t3.sessionId !== second) fail(`post-compact result carries ${t3.sessionId}, expected ${second}`);
log("✓ turn after compact remembers the secret, on the new session id");

// LHC side.
const registryPath = join(LHC_HOME, "registry.sqlite");
const lhc: Lhc = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
const r1 = await threads.resolveAlias({ alias: `t3code-lhc:${first}`, registryPath });
const r2 = await threads.resolveAlias({ alias: `t3code-lhc:${second}`, registryPath });
if (!r1.ok || !r2.ok) fail(`alias resolution failed: ${JSON.stringify([r1, r2])}`);
if (r1.value.threadId !== r2.value.threadId) fail("session ids resolve to different threads");
if (r2.value.currentAlias !== `t3code-lhc:${second}`) fail(`current alias is ${r2.value.currentAlias}`);
const threadRef = { threadId: r1.value.threadId, registryPath };
const view = await lhc.threadView.describe(threadRef);
if (!view.ok || view.value === null) fail(`no stored view after compact: ${JSON.stringify(view)}`);
const turns = await lhc.turns.listTurns(threadRef);
const events = await lhc.intakeStream.listEvents(threadRef);
if (!turns.ok || !events.ok) fail("LHC read failed");
const kinds = events.value.reduce<Record<string, number>>((acc, e) => { acc[e.eventKind] = (acc[e.eventKind] ?? 0) + 1; return acc; }, {});
log(`✓ LHC thread ${threadRef.threadId}: ${events.value.length} events ${JSON.stringify(kinds)}, ${turns.value.length} turns, view ${view.value.viewId} bands=${view.value.arrangement.map((a) => a.band).join(",") || "(none)"} compactPoint=${view.value.compactPoint}`);
if (!kinds["compact_continuation_marker"]) fail("no continuation marker recorded");
const evicted = turns.value.filter((t) => t.status === "closed" && t.memberMessageIds.length > 0 && t.closedAtEventOrder !== undefined && t.closedAtEventOrder <= view.value!.coveredFrom);
if (evicted.length > 0) fail(`compact evicted turns ${evicted.map((t) => t.turnId).join(",")} (covered from ${view.value.coveredFrom})`);
log(`✓ every closed turn is still represented (covered from ${view.value.coveredFrom}, compact point ${view.value.compactPoint})`);

await a.stop();
log("sidecar-1 stopped; restarting with resume");

const b = new Sidecar("sidecar-2");
b.send({ type: "start", options: baseOptions({ resume: second }) });
const t4 = await b.turn("Without using tools: what is the secret word, and what file did we create? Be brief.");
if (!t4.text.toLowerCase().includes(SECRET)) fail(`resumed turn lacks secret: ${t4.text}`);
if (!t4.text.toLowerCase().includes("answer.txt")) fail(`resumed turn lacks the file name: ${t4.text}`);
const third = String(b.messages.find((m) => m["subtype"] === "init")?.["session_id"]);
if (third === second || third === first || third === "undefined") fail(`resume did not mint a new generation (init sid ${third})`);
log(`✓ resumed as ${third.slice(0, 8)}; turn remembers secret and answer.txt`);
const r3 = await threads.resolveAlias({ alias: `t3code-lhc:${third}`, registryPath });
if (!r3.ok || r3.value.threadId !== threadRef.threadId) fail("resumed session id is not an alias of the thread");
await b.stop();
const finalEvents = await lhc.intakeStream.listEvents(threadRef);
console.log(JSON.stringify({ threadId: threadRef.threadId, sessions: [first, second, third], events: finalEvents.ok ? finalEvents.value.length : -1, cwd }, null, 2));
console.log("RESULT: PASS");
process.exit(0);
