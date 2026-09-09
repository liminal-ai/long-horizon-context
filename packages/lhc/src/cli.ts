// `lhc`: the SDK's thin command line. Verbs map one-to-one onto threads-domain
// operations; the only logic here is flag parsing, instance construction for
// verbs that derive, and the exit code. One line on stdout on success, one
// line on stderr on failure. Exit 0 ok, 2 refused (a caller error the
// scriptable caller can act on), 1 anything else.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initLhc, type Lhc, threads } from "./sdk.js";
import type { ErrorResult, OpResult } from "./shared-tech/index.js";
import { claudeCliInferenceAssignments, createClaudeCliModelCall } from "./shared-tech/inference-claude-cli.js";
import { FORK_HOSTS, type ForkCompactChoice, type ForkHost, generateThreadIdForCli } from "./threads/fork.js";

const HELP = `usage: lhc thread <verb> [flags]

verbs
  copy    --source-home H --source-thread-id ID --home H2 [--new-id ID | --keep-id] [--file-name NAME] [--cwd DIR] [--title T] [--allow-mid-turn]
  bind    --home H --thread-id ID --host HOST --session-id SID
  note    --home H --thread-id ID --from SOURCE_ID [--source-home H0] [--seat NAME]
  health  --home H --thread-id ID [--json]
  repair  --home H --thread-id ID [--limit N] [--rounds N] [--claude-bin PATH]
  export  --home H --thread-id ID [--out FILE]
  fork    --source-home H --source-thread-id ID --source-host HOST0 --home H2 --host HOST [--session-id SID] [--new-id ID] [--cwd DIR] [--title T] [--seat NAME]
          [--no-repair] [--limit N] [--rounds N] [--compact | --no-compact] [--compact-target TOKENS] [--claude-bin PATH]

hosts: ${FORK_HOSTS.join(", ")}. A home is <dir>/registry.sqlite plus <dir>/threads/.
--source-file PATH may replace --source-home/--source-thread-id. Exit 0 ok, 2 refused, 1 error.
fork order: copy, identity note, repair, compact, bind. It compacts under the "handoff" profile when the
source and target hosts use different providers; --compact forces it, --no-compact suppresses it.
codex-lhc keys the record by its rollout uuid (--new-id and --session-id are one value, minted when absent).
`;

const REFUSAL_CODES = new Set([
  "mid_turn",
  "path_exists",
  "thread_exists",
  "thread_not_found",
  "alias_bound_to_other_thread",
  "file_bound_host",
  "invalid_thread_alias",
  "compact_refused",
]);

class CliRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Flags = Map<string, string | true>;

function parse(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { positional, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function need(flags: Flags, key: string): string {
  const value = str(flags, key);
  if (value === undefined) throw new CliRefusal("usage", `--${key} is required`);
  return value;
}

function num(flags: Flags, key: string): number | undefined {
  const value = str(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliRefusal("usage", `--${key} must be a positive integer`);
  return parsed;
}

function registryOf(home: string): string {
  return join(home, "registry.sqlite");
}

function threadsDirOf(home: string): string {
  return join(home, "threads");
}

function unwrap<T>(result: OpResult<T>): T {
  if (result.ok) return result.value;
  throw new CliRefusal(result.error.code, result.error.reason);
}

function sourceRef(flags: Flags): threads.ThreadRef {
  const file = str(flags, "source-file");
  if (file !== undefined) return { filePath: file };
  return { threadId: need(flags, "source-thread-id"), registryPath: registryOf(need(flags, "source-home")) };
}

function targetRef(flags: Flags): threads.ThreadRef {
  return { threadId: need(flags, "thread-id"), registryPath: registryOf(need(flags, "home")) };
}

function hostOf(flags: Flags, key = "host"): ForkHost {
  const host = need(flags, key);
  if (!(FORK_HOSTS as readonly string[]).includes(host)) {
    throw new CliRefusal("usage", `--${key} must be one of ${FORK_HOSTS.join(", ")}`);
  }
  return host as ForkHost;
}

function compactChoice(flags: Flags): ForkCompactChoice {
  const force = flags.get("compact") === true;
  const suppress = flags.get("no-compact") === true;
  if (force && suppress) throw new CliRefusal("usage", "--compact and --no-compact are exclusive");
  return force ? "always" : suppress ? "never" : "auto";
}

function instance(flags: Flags): Lhc {
  const binary = str(flags, "claude-bin") ?? process.env.LHC_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
  return initLhc({
    mode: "manual",
    inference: {
      call: createClaudeCliModelCall({ binary, env: process.env }),
      assignments: claudeCliInferenceAssignments(),
      timeoutMs: 90_000,
    },
  });
}

async function copy(flags: Flags): Promise<string> {
  const home = need(flags, "home");
  const keep = flags.get("keep-id") === true;
  const newId = str(flags, "new-id") ?? (keep ? undefined : generateThreadIdForCli());
  const threadId = keep ? undefined : newId;
  const fileName = str(flags, "file-name") ?? `${threadId ?? "adopted"}.sqlite`;
  const input: threads.CopyThreadInput = {
    source: sourceRef(flags),
    filePath: join(threadsDirOf(home), fileName),
    registryPath: registryOf(home),
    requireIdle: flags.get("allow-mid-turn") !== true,
  };
  if (keep) input.keepThreadId = true;
  else if (threadId !== undefined) input.newThreadId = threadId;
  const cwd = str(flags, "cwd");
  const title = str(flags, "title");
  if (cwd !== undefined) input.cwd = cwd;
  if (title !== undefined) input.title = title;
  const receipt = unwrap(await threads.copyThread(input));
  return `${receipt.threadId} ${receipt.filePath}`;
}

async function bind(flags: Flags): Promise<string> {
  const input: threads.BindHostInput = {
    threadId: need(flags, "thread-id"),
    registryPath: registryOf(need(flags, "home")),
    host: hostOf(flags),
  };
  const sessionId = str(flags, "session-id");
  if (sessionId !== undefined) input.sessionId = sessionId;
  const binding = unwrap(await threads.bindHost(input));
  return binding.kind === "alias" ? binding.alias : binding.kind;
}

async function note(flags: Flags): Promise<string> {
  const input: threads.IdentityNoteInput = { ref: targetRef(flags), sourceThreadId: need(flags, "from") };
  const sourceHome = str(flags, "source-home");
  const seat = str(flags, "seat");
  if (sourceHome !== undefined) input.sourceHome = sourceHome;
  if (seat !== undefined) input.seat = seat;
  const receipt = unwrap(await threads.writeIdentityNote(input));
  return `${receipt.messageId} ${receipt.text}`;
}

async function healthLine(flags: Flags): Promise<string> {
  const { inspect } = await import("./sdk.js");
  const report = unwrap(await inspect.health(targetRef(flags)));
  if (flags.get("json") === true) return JSON.stringify(report);
  const totals = report.owners.reduce(
    (sum, owner) => ({
      ready: sum.ready + owner.counts.ready,
      pending: sum.pending + owner.counts.pending,
      failed: sum.failed + owner.counts.failed,
      blocked: sum.blocked + owner.counts.blocked,
    }),
    { ready: 0, pending: 0, failed: 0, blocked: 0 },
  );
  return `ready=${totals.ready} pending=${totals.pending} failed=${totals.failed} blocked=${totals.blocked} repairable=${report.repairPreview.length}`;
}

async function repair(flags: Flags, sdk: Lhc, ref: threads.ThreadRef): Promise<threads.RepairReceipt> {
  const input: threads.RepairInput = { ref };
  const limit = num(flags, "limit");
  if (limit !== undefined) input.limit = limit;
  const rounds = num(flags, "rounds");
  if (rounds !== undefined) input.rounds = rounds;
  return unwrap(await sdk.threads.repairDerivations(input));
}

// Counts on stdout; the per-subject reasons go to stderr so a scripted caller
// can act on the line and a human can still see why a repair did not land.
function repairLine(receipt: threads.RepairReceipt): string {
  for (const error of receipt.errors) {
    process.stderr.write(`repair ${error.subjectKind} ${error.subjectId}: ${error.code}: ${error.reason}\n`);
  }
  const repaired = receipt.turns.repaired + receipt.chunks.repaired;
  const failed = receipt.turns.failed + receipt.chunks.failed;
  const deferred = receipt.turns.deferred + receipt.chunks.deferred;
  return `repaired=${repaired} failed=${failed} deferred=${deferred} remaining=${receipt.remainingFailures}`;
}

async function exportLine(flags: Flags): Promise<string> {
  const history = unwrap(await threads.exportHistory(targetRef(flags)));
  const out = str(flags, "out");
  const json = JSON.stringify(history);
  if (out === undefined) return json;
  writeFileSync(out, `${json}\n`);
  return `${out} turns=${history.turns.length}`;
}

async function fork(flags: Flags): Promise<string> {
  const home = need(flags, "home");
  const host = hostOf(flags);
  const sourceHost = hostOf(flags, "source-host");
  const choice = compactChoice(flags);
  const given: { newId?: string; sessionId?: string } = {};
  const newId = str(flags, "new-id");
  const sessionFlag = str(flags, "session-id");
  if (newId !== undefined) given.newId = newId;
  if (sessionFlag !== undefined) given.sessionId = sessionFlag;
  const threadId = unwrap(threads.forkThreadId(host, given));
  const sessionId = sessionFlag ?? (host === "codex-lhc" ? threadId : undefined);
  const binding = unwrap(threads.hostBinding(host, sessionId));
  const fileName = binding.kind === "file" ? binding.fileName : `${threadId}.sqlite`;
  const source = sourceRef(flags);
  const copyInput: threads.CopyThreadInput = {
    source,
    filePath: join(threadsDirOf(home), fileName),
    registryPath: registryOf(home),
    newThreadId: threadId,
  };
  const cwd = str(flags, "cwd");
  const title = str(flags, "title");
  if (cwd !== undefined) copyInput.cwd = cwd;
  if (title !== undefined) copyInput.title = title;
  const copied = unwrap(await threads.copyThread(copyInput));
  const ref: threads.ThreadRef = { threadId: copied.threadId, registryPath: registryOf(home) };

  const noteInput: threads.IdentityNoteInput = { ref, sourceThreadId: copied.sourceThreadId };
  const sourceHome = str(flags, "source-home");
  const seat = str(flags, "seat");
  if (sourceHome !== undefined) noteInput.sourceHome = sourceHome;
  if (seat !== undefined) noteInput.seat = seat;
  unwrap(await threads.writeIdentityNote(noteInput));

  let sdk: Lhc | undefined;
  const sdkOnce = (): Lhc => {
    sdk ??= instance(flags);
    return sdk;
  };
  let repairText = "repaired=0 failed=0 deferred=0 remaining=skipped";
  if (flags.get("no-repair") !== true) {
    repairText = repairLine(await repair(flags, sdkOnce(), ref));
  }

  // Cross-provider: the copy's closed turns become text bands before any host
  // can find it, so no host renders another harness's tool blocks.
  const plan = threads.forkCompactPlan(sourceHost, host, choice);
  let compactText = `compact=skipped (${plan.reason})`;
  if (plan.compact) {
    const opts = threads.handoffCompactOptions(num(flags, "compact-target"));
    const preview = unwrap(await sdkOnce().threadView.previewCompact(ref, opts));
    if (preview.kind === "error") throw new CliRefusal("compact_refused", preview.reason);
    const receipt = unwrap(await sdkOnce().threadView.compact(ref, opts));
    compactText = `compact=${receipt.totalTokens} (${plan.reason})`;
  }

  if (binding.kind === "alias") {
    const bindInput: threads.BindHostInput = { threadId: copied.threadId, registryPath: registryOf(home), host };
    if (sessionId !== undefined) bindInput.sessionId = sessionId;
    unwrap(await threads.bindHost(bindInput));
  }
  const bound = binding.kind === "alias" ? binding.alias : binding.kind === "file" ? binding.fileName : "none";
  return `${copied.threadId} ${copied.filePath} ${bound} ${repairText} ${compactText}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  if (positional.length === 0 || flags.has("help") || positional[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (positional[0] !== "thread") throw new CliRefusal("usage", `unknown command ${positional[0]}`);
    let line: string;
    switch (positional[1]) {
      case "copy":
        line = await copy(flags);
        break;
      case "bind":
        line = await bind(flags);
        break;
      case "note":
        line = await note(flags);
        break;
      case "health":
        line = await healthLine(flags);
        break;
      case "repair":
        line = repairLine(await repair(flags, instance(flags), targetRef(flags)));
        break;
      case "export":
        line = await exportLine(flags);
        break;
      case "fork":
        line = await fork(flags);
        break;
      default:
        throw new CliRefusal("usage", `unknown verb ${positional[1] ?? "(none)"}; see lhc --help`);
    }
    process.stdout.write(`${line}\n`);
    return 0;
  } catch (cause) {
    if (cause instanceof CliRefusal) {
      process.stderr.write(`${cause.code}: ${cause.message}\n`);
      return REFUSAL_CODES.has(cause.code) ? 2 : 1;
    }
    const error = cause as Partial<ErrorResult> & { message?: string };
    process.stderr.write(`error: ${error.message ?? String(cause)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && /(^|\/)(cli\.(js|ts)|lhc)$/.test(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
