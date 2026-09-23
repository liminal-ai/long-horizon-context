/**
 * Settling carried subagents and relaunched Monitors (beads 7uo, gorilla F4).
 *
 * Neither family can close from the replacement's rollout: a carried
 * subagent's old host is paused or gone, so it never finishes and no task
 * notice ever arrives; a relaunched Monitor is the parent's own detached
 * process, so Claude never learns of it. Both settle here, at the one seam
 * that already runs on the next real prompt (`cc-lhc tasks hook`):
 *
 *  - subagent: its saved transcript is read once. A final assistant message
 *    (last conversational record, `end_turn`/`stop_sequence`, no `tool_use`,
 *    not a synthetic API error) closes the item `completed` and its text is
 *    kept as a CC-LHC-owned copy (served by `cc-lhc tasks output <key>`);
 *    anything else — no final message, unreadable, unknown shape — closes it
 *    `killed` with the SendMessage resume notice. The old host is never kept
 *    running for it.
 *  - Monitor: every line it wrote to its relaunch output is offered once as an
 *    event (delivered when the rollout shows it, advancing a byte offset); the
 *    item closes `completed` once its recorded exact process identity is
 *    kernel-proven gone. An indeterminate probe, or no recorded identity,
 *    decides nothing.
 *  - session end: the wrapper stops every still-live relaunched Monitor of
 *    its thread, identity-gated, and records it `stopped`.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import { RESULT_COPY_MAX_BYTES, resultCopyPath } from "./cleanup.js";
import { MAX_DETAIL_CHARS, type MonitorEventLine } from "./delivery.js";
import { type ManagePorts, readItemOutput, signalRelaunched } from "./manage.js";
import type { CarriedResult, ContinuityItem, ContinuityStore } from "./store.js";

/** The continuity directory beside a lineage database (the wrapper's `monitorOutputDir`). */
export function continuityDirOf(dbPath: string): string {
  return join(dirname(dbPath), "continuity");
}

/** The notice a carried subagent without a final result is delivered with. */
export function interruptedNotice(agentId: string): string {
  return `subagent ${agentId} was interrupted by the compaction; resume it with SendMessage(${agentId})`;
}

const INTERRUPTED_PREFIX = "subagent ";
const FINAL_EVIDENCE = "final result in the saved subagent transcript";
/** Transcripts larger than this are read from their tail only; the final message is at the end. */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
/** One event read window; a line longer than this is delivered in window-sized pieces. */
export const EVENT_READ_BYTES = 64 * 1024;

export type AgentFinalResult = { kind: "final"; text: string } | { kind: "none"; reason: string };

/** Up to the last `TRANSCRIPT_TAIL_BYTES` of a file, starting at a line boundary; null when unreadable. */
export function readTranscriptTail(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

/**
 * The final result of a Claude Code 2.1.x subagent transcript
 * (`<sessionDir>/subagents/agent-<id>.jsonl`): one JSON record per line; an
 * assistant API message is split across consecutive `assistant` records
 * sharing `message.id`, the last carrying `message.stop_reason`. The agent
 * finished only when the last `user`/`assistant` record is such a closing
 * record with stop reason `end_turn` (or `stop_sequence`), no `tool_use`
 * block, and is not a synthetic API-error message. Everything else — a
 * trailing tool call or tool result, a torn last line, an unknown shape — is
 * no final result. Never throws.
 */
export function parseAgentFinalResult(text: string | null): AgentFinalResult {
  if (text === null) return { kind: "none", reason: "transcript unreadable" };
  const conversation: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { kind: "none", reason: "transcript record unparseable" };
    }
    const r = record(value);
    if (r === null) return { kind: "none", reason: "transcript record is not an object" };
    if (r.type === "user" || r.type === "assistant") conversation.push(r);
  }
  const last = conversation.at(-1);
  if (last === undefined) return { kind: "none", reason: "no conversational record" };
  if (last.type !== "assistant") return { kind: "none", reason: "last record is not an assistant message" };
  const message = record(last.message);
  if (message === null) return { kind: "none", reason: "assistant record has no message" };
  if (message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence") {
    return {
      kind: "none",
      reason: `last assistant message stop reason ${JSON.stringify(message.stop_reason ?? null)}`,
    };
  }
  if (last.isApiErrorMessage === true || message.model === "<synthetic>") {
    return { kind: "none", reason: "last assistant message is a synthetic error" };
  }
  // The final API message: the trailing assistant records sharing its id.
  const blocks: Array<Record<string, unknown>> = [last];
  if (typeof message.id === "string") {
    for (let i = conversation.length - 2; i >= 0; i--) {
      const r = conversation[i]!;
      if (r.type !== "assistant" || record(r.message)?.id !== message.id) break;
      blocks.unshift(r);
    }
  }
  for (const r of blocks) {
    const content = record(r.message)?.content;
    if (Array.isArray(content) && content.some((b) => record(b)?.type === "tool_use")) {
      return { kind: "none", reason: "last assistant message calls a tool" };
    }
  }
  return { kind: "final", text: blocks.flatMap((r) => textOf(record(r.message)?.content)).join("\n\n") };
}

/** Write the subagent's final text as a CC-LHC-owned copy (0600, fsynced, renamed into place). */
export function writeResultText(
  target: string,
  text: string,
  maxBytes: number = RESULT_COPY_MAX_BYTES,
): { bytes: number; truncated: boolean } {
  const all = Buffer.from(text, "utf8");
  const bytes = all.subarray(0, Math.min(all.length, maxBytes));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  const fd = openSync(temp, "w", 0o600);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, target);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
    throw cause;
  }
  return { bytes: bytes.length, truncated: all.length > bytes.length };
}

export interface SettleCarriedDeps {
  /** Where owned copies live (`continuityDirOf(dbPath)`). */
  continuityDir: string;
  readTranscript?: (path: string) => string | null;
  writeText?: (target: string, text: string) => { bytes: number; truncated: boolean };
  probeIdentity?: ProbeProcessIdentity;
  nowMs?: () => number;
}

export interface SettleCarriedReport {
  agents: Array<{ launchId: string; outcome: "completed" | "killed"; reason?: string }>;
  monitorsExited: string[];
}

function carriedAndHandedOver(store: ContinuityStore, item: ContinuityItem): boolean {
  if (item.state === "terminal" || item.generation === 0) return false;
  // Only once the replacement is live and the handoff generation closed.
  return store.getGeneration(item.threadId, item.generation)?.state === "closed";
}

type ProcessFate = "live" | "gone" | "indeterminate";

function processFate(
  probe: ProbeProcessIdentity,
  proc: { pid: number; bootId: string; starttime: string },
): ProcessFate {
  const probed = probe(proc.pid);
  if (!probed.ok) return probed.code === "not_found" ? "gone" : "indeterminate";
  return probed.identity.bootId === proc.bootId && probed.identity.starttime === proc.starttime ? "live" : "gone";
}

/**
 * Settle the thread's carried subagents and exited relaunched Monitors. Runs
 * from the next-prompt hook; each item closes at most once (terminal is
 * absorbing), so the resulting durable result is delivered exactly once.
 */
export function settleCarriedWork(
  store: ContinuityStore,
  threadId: string,
  deps: SettleCarriedDeps,
): SettleCarriedReport {
  const report: SettleCarriedReport = { agents: [], monitorsExited: [] };
  const now = deps.nowMs ?? Date.now;
  const readTranscript = deps.readTranscript ?? readTranscriptTail;
  const writeText = deps.writeText ?? writeResultText;
  const probe = deps.probeIdentity ?? probeProcessIdentityNative;
  for (const item of store.listItems(threadId)) {
    if (!carriedAndHandedOver(store, item)) continue;
    if (item.family === "agent") {
      const identity = item.verifiedIdentity;
      if (identity?.kind !== "agent_transcript") continue;
      let final: AgentFinalResult;
      try {
        final = parseAgentFinalResult(readTranscript(identity.path));
      } catch (cause) {
        final = { kind: "none", reason: cause instanceof Error ? cause.message : String(cause) };
      }
      if (final.kind === "final") {
        const target = resultCopyPath(deps.continuityDir, item.launchId);
        let copy: { bytes: number; truncated: boolean } | null = null;
        try {
          copy = writeText(target, final.text);
        } catch {
          copy = null;
        }
        const closed = store.recordTerminal({
          threadId,
          launchId: item.launchId,
          outcome: "completed",
          evidence: FINAL_EVIDENCE,
          nowMs: now(),
        });
        if (closed?.applied === true && copy !== null) {
          store.setResultArtifact({
            threadId,
            launchId: item.launchId,
            artifact: { kind: "owned_copy", path: target, ...copy },
          });
        } else if (copy !== null) {
          try {
            unlinkSync(target);
          } catch {
            // best effort: our own file
          }
        }
        if (closed?.applied === true) report.agents.push({ launchId: item.launchId, outcome: "completed" });
        continue;
      }
      const closed = store.recordTerminal({
        threadId,
        launchId: item.launchId,
        outcome: "killed",
        evidence: interruptedNotice(identity.agentId),
        nowMs: now(),
      });
      if (closed?.applied === true) {
        report.agents.push({ launchId: item.launchId, outcome: "killed", reason: final.reason });
      }
      continue;
    }
    if (item.family === "monitor" && item.state === "active" && item.relaunch?.process != null) {
      const proc = item.relaunch.process;
      if (processFate(probe, proc) !== "gone") continue;
      const closed = store.recordTerminal({
        threadId,
        launchId: item.launchId,
        outcome: "completed",
        evidence: `relaunched monitor process exited (pid ${proc.pid}); exit status not observed`,
        nowMs: now(),
      });
      if (closed?.applied === true) report.monitorsExited.push(item.launchId);
    }
  }
  return report;
}

/** Read up to `maxBytes` of an owned copy; null when unreadable. */
function readHead(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The detail line a pending subagent result is delivered with: the bounded
 * start of its saved final text plus where the full text is, or its
 * interrupted notice. Other families carry no detail.
 */
export function carriedResultDetails(
  results: readonly CarriedResult[],
  readText: (path: string, maxBytes: number) => string | null = readHead,
): Map<string, string> {
  const details = new Map<string, string>();
  for (const r of results) {
    if (r.family !== "agent") continue;
    if (r.outcome === "completed" && r.artifact?.kind === "owned_copy") {
      const head = readText(r.artifact.path, MAX_DETAIL_CHARS * 4);
      const flat = head === null ? null : head.replace(/\s+/g, " ").trim();
      const room = MAX_DETAIL_CHARS - 80;
      if (head === null || flat === null) {
        details.set(r.launchId, `final result saved; read it with: cc-lhc tasks output ${r.launchId}`);
      } else {
        const cut = flat.length > room || Buffer.byteLength(head, "utf8") < r.artifact.bytes || r.artifact.truncated;
        details.set(
          r.launchId,
          `final result: ${cut ? `${flat.slice(0, room)}~` : flat === "" ? "(no text)" : flat}` +
            (cut ? ` (full text: cc-lhc tasks output ${r.launchId})` : ""),
        );
      }
      continue;
    }
    if (r.evidence.startsWith(INTERRUPTED_PREFIX)) details.set(r.launchId, r.evidence);
  }
  return details;
}

/**
 * Undelivered lines of every relaunched Monitor's output, from its delivered
 * offset, re-verified through the item's recorded output identity (`output`).
 * A trailing unterminated line is offered only once the Monitor is terminal
 * (no more of it can come); a window with no newline at all is offered whole
 * so one very long line can never stall delivery.
 */
export function pendingMonitorEvents(
  store: ContinuityStore,
  threadId: string,
  ports: ManagePorts = {},
  maxEvents = Number.POSITIVE_INFINITY,
): MonitorEventLine[] {
  const events: MonitorEventLine[] = [];
  for (const item of store.listItems(threadId)) {
    if (events.length >= maxEvents) break;
    if (item.family !== "monitor" || item.relaunch === null) continue;
    let offset = store.deliveredEventOffset(threadId, item.launchId);
    while (events.length < maxEvents) {
      const read = readItemOutput(store, threadId, item.launchId, { offset, maxBytes: EVENT_READ_BYTES }, ports);
      if (!read.ok || read.bytes.length === 0) break;
      const chunk = read.bytes;
      const eof = read.nextOffset === null;
      let pos = 0;
      const take = (end: number): void => {
        const text = chunk
          .subarray(pos, end)
          .toString("utf8")
          .replace(/\r?\n$/, "");
        pos = end;
        if (text.trim() !== "") {
          events.push({ launchId: item.launchId, label: item.label, text, endOffset: read.offset + end });
        }
      };
      for (let nl = chunk.indexOf(0x0a); nl >= 0 && events.length < maxEvents; nl = chunk.indexOf(0x0a, pos)) {
        take(nl + 1);
      }
      if (events.length < maxEvents && pos < chunk.length) {
        const windowWithoutNewline = !eof && pos === 0;
        const finalTail = eof && item.state === "terminal";
        if (windowWithoutNewline || finalTail) take(chunk.length);
      }
      if (pos === 0 || eof) break;
      offset = read.offset + pos;
    }
  }
  return events;
}

export interface StopMonitorsReport {
  stopped: Array<{ launchId: string; pid: number }>;
  alreadyExited: string[];
  kept: Array<{ launchId: string; reason: string }>;
}

/**
 * Session end: a relaunched Monitor is the parent's own detached process and
 * must not outlive the session. Each still-active one is signalled only while
 * its live identity matches the record exactly, then recorded `stopped`; one
 * already gone is recorded as exited; an indeterminate probe or a failed
 * signal changes nothing.
 */
export function stopRelaunchedMonitors(
  store: ContinuityStore,
  threadId: string,
  ports: ManagePorts & { log?: (message: string) => void } = {},
): StopMonitorsReport {
  const report: StopMonitorsReport = { stopped: [], alreadyExited: [], kept: [] };
  const probe = ports.probeIdentity ?? probeProcessIdentityNative;
  const signal = ports.signal ?? signalRelaunched;
  const now = ports.nowMs ?? Date.now;
  for (const item of store.listItems(threadId)) {
    if (item.family !== "monitor" || item.state !== "active" || item.relaunch?.process == null) continue;
    const proc = item.relaunch.process;
    const fate = processFate(probe, proc);
    if (fate === "indeterminate") {
      report.kept.push({ launchId: item.launchId, reason: `pid ${proc.pid} identity indeterminate; not signalled` });
      ports.log?.(`cc-lhc continuity: relaunched monitor ${item.launchId} pid ${proc.pid} indeterminate; not stopped`);
      continue;
    }
    if (fate === "gone") {
      store.recordTerminal({
        threadId,
        launchId: item.launchId,
        outcome: "completed",
        evidence: `relaunched monitor process exited (pid ${proc.pid}); exit status not observed`,
        nowMs: now(),
      });
      report.alreadyExited.push(item.launchId);
      continue;
    }
    const signalled = signal(proc.pid, ports.platform ?? process.platform);
    if (!signalled.ok) {
      report.kept.push({ launchId: item.launchId, reason: signalled.reason });
      ports.log?.(
        `cc-lhc continuity: relaunched monitor ${item.launchId} pid ${proc.pid} not stopped: ${signalled.reason}`,
      );
      continue;
    }
    store.recordTerminal({
      threadId,
      launchId: item.launchId,
      outcome: "stopped",
      evidence: `stopped at session end (pid ${proc.pid})`,
      nowMs: now(),
    });
    report.stopped.push({ launchId: item.launchId, pid: proc.pid });
    ports.log?.(`cc-lhc continuity: relaunched monitor ${item.launchId} pid ${proc.pid} stopped at session end`);
  }
  return report;
}
