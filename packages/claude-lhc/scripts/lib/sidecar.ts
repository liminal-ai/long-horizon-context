// Drives one claude-lhc sidecar over its JSONL protocol (shared by the standalone proofs).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { DriverFrame, SidecarFrame } from "../../src/protocol.ts";

export const BIN = resolve(import.meta.dir, "../../bin/claude-lhc");
export type Wire = Record<string, unknown>;

export function fail(reason: string): never { console.log(`RESULT: FAIL — ${reason}`); process.exit(1); }
export const log = (...parts: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 23)}]`, ...parts);

/** input + cache creation + cache read of an assistant message's usage: the provider's context reading. */
export function contextTokens(m: Wire): number | undefined {
  const usage = (m["message"] as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (usage === undefined) return undefined;
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const nested = usage["cache_creation"] as Record<string, unknown> | undefined;
  const created = n("cache_creation_input_tokens") || (nested ? Object.values(nested).filter((v): v is number => typeof v === "number").reduce((a, b) => a + b, 0) : 0);
  const total = n("input_tokens") + created + n("cache_read_input_tokens");
  return total > 0 ? total : undefined;
}

export function describe(m: Wire): string {
  const sub = typeof m["subtype"] === "string" ? `/${m["subtype"]}` : "";
  const sid = String(m["session_id"]).slice(0, 8);
  if (m["type"] === "assistant") {
    const msgId = String((m["message"] as { id?: string }).id ?? "").slice(-6);
    const blocks = ((m["message"] as { content: Wire[] }).content).map((b) => b["type"] === "text" ? `text:${JSON.stringify(String(b["text"]).slice(0, 60))}` : b["type"] === "tool_use" ? `tool_use:${b["name"]}(${JSON.stringify(b["input"]).slice(0, 60)}) ${String(b["id"]).slice(-6)}` : String(b["type"]));
    const ctx = contextTokens(m);
    return `assistant sid=${sid} msg=${msgId} ${blocks.join(" | ")}${ctx !== undefined ? ` ctx=${ctx}` : ""}`;
  }
  if (m["type"] === "user") {
    const content = (m["message"] as { content: unknown }).content;
    const blocks = Array.isArray(content) ? (content as Wire[]).map((b) => b["type"] === "tool_result" ? `tool_result ${String(b["tool_use_id"]).slice(-6)}${b["is_error"] ? " ERROR" : ""} (${JSON.stringify(b["content"]).length} chars)` : String(b["type"])) : [JSON.stringify(content).slice(0, 60)];
    return `user sid=${sid} ${blocks.join(" | ")}`;
  }
  if (m["type"] === "result") return `result${sub} sid=${sid} terminal=${String(m["terminal_reason"])} is_error=${String(m["is_error"])} ${JSON.stringify(m["result"]).slice(0, 100)}`;
  if (m["type"] === "system" && m["subtype"] === "compact_boundary") return `system/compact_boundary sid=${sid} ${JSON.stringify(m["compact_metadata"])}`;
  if (m["type"] === "system" && m["subtype"] === "status") return `system/status sid=${sid} status=${String(m["status"])}${m["compact_result"] ? ` compact_result=${m["compact_result"]}` : ""}`;
  return `${String(m["type"])}${sub} sid=${sid}`;
}

export class Sidecar {
  child: ChildProcess;
  messages: Wire[] = [];
  /** Arrival time of each message, ms since epoch (parallel to `messages`). */
  arrivedAt: number[] = [];
  requests: Wire[] = [];
  stderr: string[] = [];
  error: string | null = null;
  exited: Promise<number | null>;
  #waiters: Array<() => void> = [];
  constructor(label: string, lhcHome: string, quiet = false) {
    this.child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, T3CODE_LHC_HOME: lhcHome } });
    this.exited = new Promise((r) => this.child.on("exit", (code) => { r(code); this.#notify(); }));
    createInterface({ input: this.child.stderr! }).on("line", (line) => {
      this.stderr.push(line);
      if (!quiet) process.stderr.write(`  [${label}] ${line}\n`);
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const frame = JSON.parse(line) as SidecarFrame;
      if (frame.type === "msg") {
        const m = frame.message as unknown as Wire;
        this.messages.push(m);
        this.arrivedAt.push(Date.now());
        if (!quiet && m["type"] !== "stream_event") log(`  ← ${describe(m)}`);
      } else if (frame.type === "req") {
        this.requests.push(frame as unknown as Wire);
        this.send({ type: "res", id: frame.id, ok: true, value: frame.method === "canUseTool" ? { behavior: "allow", updatedInput: (frame.params as { input: unknown }).input } : {} });
      } else if (frame.type === "error") {
        this.error = frame.message;
      }
      this.#notify();
    });
  }
  #notify() { const w = this.#waiters; this.#waiters = []; for (const f of w) f(); }
  send(frame: DriverFrame) { this.child.stdin!.write(`${JSON.stringify(frame)}\n`); }
  async waitFor(pred: () => boolean, timeoutMs = 240_000, what = "condition"): Promise<void> {
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
  /** Sends a prompt and waits for the next `result`; returns the wire slice for the turn. */
  async turn(text: string, timeoutMs = 240_000): Promise<{ text: string; wire: Wire[]; result: Wire; context: number }> {
    const from = this.messages.length;
    this.prompt(text);
    await this.waitFor(() => this.messages.slice(from).some((m) => m["type"] === "result"), timeoutMs, `result for "${text.slice(0, 40)}"`);
    const wire = this.messages.slice(from).filter((m) => m["type"] !== "stream_event");
    const result = wire.find((m) => m["type"] === "result")!;
    const assistant = wire.filter((m) => m["type"] === "assistant");
    const textOut = assistant.flatMap((m) => ((m["message"] as { content: Wire[] }).content).filter((b) => b["type"] === "text").map((b) => String(b["text"]))).join("\n");
    const context = assistant.map(contextTokens).filter((n): n is number => n !== undefined).at(-1) ?? 0;
    return { text: textOut || String(result["result"] ?? ""), wire, result, context };
  }
  async stop(): Promise<void> { this.child.stdin!.end(); await Promise.race([this.exited, new Promise((r) => setTimeout(r, 8000))]); if (this.child.exitCode === null) this.child.kill("SIGKILL"); }
}
