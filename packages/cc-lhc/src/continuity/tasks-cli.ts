/**
 * `cc-lhc tasks status|output|stop <launch id>` — the replacement session's
 * management surface for carried work (LIM-146 AC-2.6). Bound exactly like
 * retrieval: the wrapper's ready descriptor names the thread; argv never does.
 */

import { defaultLineageDbPath } from "../intake/paths.js";
import { defaultRolloutBindIo, type RolloutBindIo } from "../retrieval/rollout-bind.js";
import { bindReadyDescriptor, writeAll } from "../retrieval/service.js";
import type { DescriptorIo } from "../runtime/descriptor.js";
import { defaultDescriptorIo } from "../runtime/descriptor.js";
import { formatResultContext } from "./delivery.js";
import { DEFAULT_OUTPUT_MAX_BYTES, itemStatus, type ManagePorts, readItemOutput, stopItem } from "./manage.js";
import { type ContinuityStore, openContinuityStore } from "./store.js";

export const TASKS_USAGE = "usage: cc-lhc tasks status|output|stop <launch id> [--offset BYTES] [--max BYTES]";

export type TasksOp = "status" | "output" | "stop";

export interface ParsedTasksRequest {
  op: TasksOp;
  launchId: string;
  offset?: number;
  maxBytes?: number;
}

/** `cc-lhc tasks hook`: the UserPromptSubmit hook Claude runs (LIM-146). Payload on stdin, context on stdout. */
export function isTasksHookArgv(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "tasks" && argv[1] === "hook";
}

export interface TasksHookDeps {
  env?: NodeJS.ProcessEnv;
  descriptorIo?: DescriptorIo;
  rolloutBindIo?: RolloutBindIo;
  descriptorPath?: string;
  continuityDbPath?: string;
  openStore?: (path: string) => ContinuityStore;
}

export type TasksHookResult =
  /** Context to hand Claude; empty string means nothing pending — print nothing. */
  { ok: true; additionalContext: string; keys: string[] } | { ok: false; reason: string };

/**
 * Answer one UserPromptSubmit payload. Binds through the wrapper's descriptor
 * (the payload's own session id must match it); lists the bound thread's
 * pending results; never writes — running the hook is not delivery. Any
 * refusal yields no context and never blocks the prompt.
 */
export function executeTasksHook(payloadText: string, deps: TasksHookDeps = {}): TasksHookResult {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { ok: false, reason: "hook payload is not JSON" };
  }
  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "hook payload is not an object" };
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== "UserPromptSubmit") {
    return { ok: false, reason: `hook event ${JSON.stringify(p.hook_event_name ?? null)} is not UserPromptSubmit` };
  }
  const baseEnv = deps.env ?? process.env;
  const env =
    typeof p.session_id === "string" && p.session_id !== ""
      ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: p.session_id }
      : baseEnv;
  const bound = bindReadyDescriptor({
    env,
    descriptorIo: deps.descriptorIo ?? defaultDescriptorIo(),
    rolloutBindIo: deps.rolloutBindIo ?? defaultRolloutBindIo(),
    ...(deps.descriptorPath === undefined ? {} : { descriptorPath: deps.descriptorPath }),
  });
  if (!bound.ok) return { ok: false, reason: bound.reason };
  const threadId = bound.descriptor.threadId as string;
  const store = (deps.openStore ?? openContinuityStore)(deps.continuityDbPath ?? defaultLineageDbPath());
  try {
    const pending = store.listPendingResults(threadId);
    return { ok: true, additionalContext: formatResultContext(pending), keys: pending.map((r) => r.launchId) };
  } finally {
    store.close();
  }
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/** The hook's process contract: exit 0 always; JSON on stdout only when there is context; reasons on stderr. */
export async function runTasksHookCli(
  streams: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
  deps: TasksHookDeps = {},
): Promise<number> {
  const out = streams.stdout ?? process.stdout;
  const err = streams.stderr ?? process.stderr;
  let payload = "";
  try {
    payload = await readAll(streams.stdin ?? process.stdin);
  } catch (cause) {
    await writeAll(
      err,
      `cc-lhc tasks hook: stdin unreadable: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 0;
  }
  let result: TasksHookResult;
  try {
    result = executeTasksHook(payload, deps);
  } catch (cause) {
    result = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!result.ok) {
    await writeAll(err, `cc-lhc tasks hook: no results supplied: ${result.reason}\n`);
    return 0;
  }
  if (result.additionalContext === "") return 0;
  await writeAll(
    out,
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.additionalContext },
    })}\n`,
  );
  return 0;
}

export function parseTasksArgv(
  argv: readonly string[],
): { ok: true; request: ParsedTasksRequest } | { ok: false; reason: string } {
  const [head, opRaw, launchId, ...rest] = argv;
  if (head !== "tasks") return { ok: false, reason: "not a tasks command" };
  if (opRaw !== "status" && opRaw !== "output" && opRaw !== "stop") {
    return { ok: false, reason: `unknown tasks operation ${JSON.stringify(opRaw ?? "")}` };
  }
  if (launchId === undefined || launchId === "" || launchId.startsWith("--")) {
    return { ok: false, reason: "missing launch id" };
  }
  const request: ParsedTasksRequest = { op: opRaw, launchId };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== "--offset" && flag !== "--max") || opRaw !== "output") {
      return { ok: false, reason: `unexpected argument ${JSON.stringify(flag)}` };
    }
    if (value === undefined || !/^-?\d+$/.test(value)) return { ok: false, reason: `${flag} requires an integer` };
    if (flag === "--offset") request.offset = Number(value);
    else request.maxBytes = Number(value);
    i++;
  }
  return { ok: true, request };
}

export interface TasksCliDeps {
  env?: NodeJS.ProcessEnv;
  descriptorIo?: DescriptorIo;
  rolloutBindIo?: RolloutBindIo;
  descriptorPath?: string;
  /** The continuity database; the wrapper's lineage database by default. */
  continuityDbPath?: string;
  openStore?: (path: string) => ContinuityStore;
  manage?: ManagePorts;
}

export type TasksCliResult =
  | { ok: true; stdout: string; bytes?: Buffer }
  | { ok: false; reason: string; usage?: string; exitCode: 2 | 3 | 4 };

function line(label: string, value: string | number | null): string {
  return `${label}: ${value === null ? "none" : String(value)}`;
}

export function executeTasks(argv: readonly string[], deps: TasksCliDeps = {}): TasksCliResult {
  const parsed = parseTasksArgv(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, usage: TASKS_USAGE, exitCode: 2 };
  const request = parsed.request;
  const bound = bindReadyDescriptor({
    env: deps.env ?? process.env,
    descriptorIo: deps.descriptorIo ?? defaultDescriptorIo(),
    rolloutBindIo: deps.rolloutBindIo ?? defaultRolloutBindIo(),
    ...(deps.descriptorPath === undefined ? {} : { descriptorPath: deps.descriptorPath }),
  });
  if (!bound.ok) return bound;
  const threadId = bound.descriptor.threadId as string;
  const store = (deps.openStore ?? openContinuityStore)(deps.continuityDbPath ?? defaultLineageDbPath());
  try {
    const ports = deps.manage ?? {};
    switch (request.op) {
      case "status": {
        const result = itemStatus(store, threadId, request.launchId, ports);
        if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}`, exitCode: 4 };
        const s = result.status;
        return {
          ok: true,
          stdout: [
            line("launch id", s.launchId),
            line("family", s.family),
            line("label", s.label),
            line("state", s.state),
            line("carry mode", s.carryMode),
            ...(s.carryMode === null ? [line("tracking", "cleaned up; durable result only")] : []),
            line("generation", s.generation),
            line("operations", s.operations.join(", ") || "none"),
            line("identity", s.identity),
            line("process", s.process),
            line("terminal", s.terminal === null ? null : `${s.terminal.outcome} (${s.terminal.evidence})`),
          ].join("\n"),
        };
      }
      case "output": {
        const result = readItemOutput(
          store,
          threadId,
          request.launchId,
          {
            ...(request.offset === undefined ? {} : { offset: request.offset }),
            maxBytes: request.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
          },
          ports,
        );
        if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}`, exitCode: 4 };
        const header =
          `output ${request.launchId}: bytes ${result.offset}..${result.offset + result.bytes.length} of ${result.totalBytes}` +
          (result.nextOffset === null
            ? " (end)"
            : ` · next: cc-lhc tasks output ${request.launchId} --offset ${result.nextOffset}`);
        return { ok: true, stdout: header, bytes: result.bytes };
      }
      case "stop": {
        const result = stopItem(store, threadId, request.launchId, ports);
        if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}`, exitCode: 4 };
        return { ok: true, stdout: `stopped ${result.launchId} (pid ${result.pid}); recorded as stopped` };
      }
    }
  } finally {
    store.close();
  }
}

export async function runTasksCli(
  argv: readonly string[],
  streams: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
  deps: TasksCliDeps = {},
): Promise<number> {
  if (isTasksHookArgv(argv)) return runTasksHookCli(streams, deps);
  const out = streams.stdout ?? process.stdout;
  const err = streams.stderr ?? process.stderr;
  const result = executeTasks(argv, deps);
  if (!result.ok) {
    await writeAll(err, `cc-lhc: ${result.reason}\n`);
    if (result.usage !== undefined) await writeAll(err, `${result.usage}\n`);
    return result.exitCode;
  }
  await writeAll(out, `${result.stdout}\n`);
  if (result.bytes !== undefined && result.bytes.length > 0) {
    await writeAll(out, result.bytes.toString("utf8"));
    if (!result.bytes.toString("utf8").endsWith("\n")) await writeAll(out, "\n");
  }
  return 0;
}

export function isTasksArgv(argv: readonly string[]): boolean {
  return argv[0] === "tasks";
}
