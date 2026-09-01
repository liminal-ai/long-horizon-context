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
  streams: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
  deps: TasksCliDeps = {},
): Promise<number> {
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
