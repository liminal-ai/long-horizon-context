import { parseArgs } from "node:util";
import * as intakeStream from "../domains/intake-stream/index.js";
import * as messages from "../domains/messages/index.js";
import * as threads from "../domains/threads/index.js";
import * as turns from "../domains/turns/index.js";
import type { MessageEventInput } from "../domains/intake-stream/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import type { OpResult } from "../shared/errors.js";
import { renderCliError, renderResult, type CliResult } from "./render.js";
import { runInspectHealth, runInspectOverview, runInspectView } from "./inspect.js";
import { runMessagesDelete, runMessagesEdit } from "./messages-mutate.js";
import { runMessagesList, runMessagesShow } from "./messages-read.js";
import { runTurnsDelete } from "./turns-mutate.js";
import {
  runMessagesReport,
  runMessagesRequeue,
  runTurnsReport,
  runTurnsRequeue,
  runWorkDrain,
} from "./work.js";
import { runViewCommand } from "./view.js";

// Stdin seam: in-process tests inject a reader; the binary reads the real
// process stdin. null means interactive (TTY) — distinct from empty input
// only in how it arises; both are refused with empty_stdin before any SDK
// call (the SDK itself can never return that code).
export type StdinReader = () => Promise<string | null>;

async function readProcessStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

function stdinCallerError(code: "empty_stdin" | "invalid_event", reason: string): OpResult<never> {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

const HELP = `lhc — Long Horizon Context CLI

Usage:
  lhc threads new-thread --file-path <p> [--title <t>] [--registry <r>]
  lhc threads resolve --thread-id <id> [--registry <r>]
  lhc threads list [--registry <r>]
  lhc intake-stream message-events (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc intake-stream list-events (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc messages list (--thread-id <id> | --file-path <p>) [--from <n>] [--to <n>]
                    [--limit <n>] [--include-deleted] [--registry <r>]
  lhc messages show (--thread-id <id> | --file-path <p>) --message-id <id> [--registry <r>]
  lhc messages list-queued-work (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc messages report (--thread-id <id> | --file-path <p>) [--not-ready] [--message-id <id>] [--registry <r>]
  lhc messages requeue (--thread-id <id> | --file-path <p>) --message-id <id> --form <form> [--registry <r>]
  lhc messages edit (--thread-id <id> | --file-path <p>) --message <id> --content <text> [--registry <r>]
  lhc messages delete (--thread-id <id> | --file-path <p>) --message <id> [--registry <r>]
  lhc turns list (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc turns list-chunks (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc turns list-queued-work (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc turns report (--thread-id <id> | --file-path <p>) [--not-ready] [--turn-id <id>] [--chunk-id <id>] [--registry <r>]
  lhc turns requeue (--thread-id <id> | --file-path <p>) --subject-kind (turn|chunk) --subject-id <id> --form <form> [--registry <r>]
  lhc turns delete (--thread-id <id> | --file-path <p>) --turn <id> [--registry <r>]
  lhc work drain (--thread-id <id> | --file-path <p>) [--max-items <n>] [--provider <name>] [--registry <r>]
  lhc view pull (--thread-id <id> | --file-path <p>) [--json] [--registry <r>]
  lhc view status (--thread-id <id> | --file-path <p>) [--json] [--registry <r>]
  lhc view compact (--thread-id <id> | --file-path <p>) [--profile <name>]
                   [--lower-bound <n>] [--full <n>] [--smooth <n>] [--detailed <n>] [--brief <n>]
                   [--no-sweep] [--json] [--registry <r>]
  lhc view sweep (--thread-id <id> | --file-path <p>) [--json] [--registry <r>]
  lhc view materialize (--thread-id <id> | --file-path <p>) --out <path> [--format pi-session] [--registry <r>]
  lhc inspect overview (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc inspect view     (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc inspect health   (--thread-id <id> | --file-path <p>) [--registry <r>]

Every command prints the SDK result (value or error) as JSON and exits 0 on
success, 1 on failure. message-events reads an events JSON array on stdin.
View commands need no provider; output is always JSON (--json accepted).
Two exceptions on success: view pull prints the message array itself, and
view materialize prints the written path; their failures stay structured.
`;

interface ParsedFlags {
  threadId?: string;
  filePath?: string;
  title?: string;
  registryPath?: string;
  maxItems?: string;
  provider?: string;
  notReady?: boolean;
  messageId?: string;
  turnId?: string;
  chunkId?: string;
  form?: string;
  subjectKind?: string;
  subjectId?: string;
  content?: string;
  from?: string;
  to?: string;
  limit?: string;
  includeDeleted?: boolean;
}

// strict parse rejects unknown/misspelled flags so they are named back to the
// caller, never silently dropped — the CLI boundary matching the SDK's
// closed-contract strictness. The failure is returned as data (not thrown) so
// runCli can render it as the structured usage error.
type ParseFlagsResult =
  | { ok: true; flags: ParsedFlags }
  | { ok: false; unknownFlag: string };

function parseFlags(args: readonly string[]): ParseFlagsResult {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        "thread-id": { type: "string" },
        "file-path": { type: "string" },
        title: { type: "string" },
        registry: { type: "string" },
        "max-items": { type: "string" },
        provider: { type: "string" },
        "not-ready": { type: "boolean" },
        "message-id": { type: "string" },
        "turn-id": { type: "string" },
        "chunk-id": { type: "string" },
        form: { type: "string" },
        "subject-kind": { type: "string" },
        "subject-id": { type: "string" },
        // `--message` / `--turn` are the mutation commands' spellings
        // (story/tech design); they parse into the same slots as
        // `--message-id` / `--turn-id`.
        message: { type: "string" },
        turn: { type: "string" },
        content: { type: "string" },
        // Epic 04 Story 1: the bounded-listing options (lhc messages list).
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "string" },
        "include-deleted": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // parseArgs names the offending option in single quotes (e.g. Unknown
    // option '--file-pth'); surface that token, falling back to the message.
    const named = /'([^']+)'/.exec(message);
    return { ok: false, unknownFlag: named?.[1] ?? message };
  }
  const flags: ParsedFlags = {};
  if (typeof values["thread-id"] === "string") flags.threadId = values["thread-id"];
  if (typeof values["file-path"] === "string") flags.filePath = values["file-path"];
  if (typeof values.title === "string") flags.title = values.title;
  if (typeof values.registry === "string") flags.registryPath = values.registry;
  if (typeof values["max-items"] === "string") flags.maxItems = values["max-items"];
  if (typeof values.provider === "string") flags.provider = values.provider;
  if (values["not-ready"] === true) flags.notReady = true;
  if (typeof values["message-id"] === "string") flags.messageId = values["message-id"];
  if (typeof values.message === "string") flags.messageId = values.message;
  if (typeof values.content === "string") flags.content = values.content;
  if (typeof values["turn-id"] === "string") flags.turnId = values["turn-id"];
  if (typeof values.turn === "string") flags.turnId = values.turn;
  if (typeof values["chunk-id"] === "string") flags.chunkId = values["chunk-id"];
  if (typeof values.form === "string") flags.form = values.form;
  if (typeof values["subject-kind"] === "string") flags.subjectKind = values["subject-kind"];
  if (typeof values["subject-id"] === "string") flags.subjectId = values["subject-id"];
  if (typeof values.from === "string") flags.from = values.from;
  if (typeof values.to === "string") flags.to = values.to;
  if (typeof values.limit === "string") flags.limit = values.limit;
  if (values["include-deleted"] === true) flags.includeDeleted = true;
  return { ok: true, flags };
}

// The read commands take a thread reference but no stdin; a missing reference
// is a usage error named before any SDK call, matching the intake commands.
function requireThreadRef(flags: ParsedFlags, command: string): CliResult | undefined {
  if (flags.threadId === undefined && flags.filePath === undefined) {
    return renderCliError(
      "caller_error",
      "missing_flag",
      `${command} requires --thread-id or --file-path`,
    );
  }
  return undefined;
}

function threadRefFrom(flags: ParsedFlags): ThreadRef {
  if (flags.threadId !== undefined) {
    return flags.registryPath !== undefined
      ? { threadId: flags.threadId, registryPath: flags.registryPath }
      : { threadId: flags.threadId };
  }
  return { filePath: flags.filePath ?? "" };
}

export async function runCli(
  argv: readonly string[],
  readStdin: StdinReader = readProcessStdin,
): Promise<CliResult> {
  if (argv.length === 0) {
    return renderCliError("caller_error", "unknown_command", "no command given; run lhc --help");
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, stdout: HELP, stderr: "" };
  }

  const [group, command, ...rest] = argv;
  // The view group parses its own flag surface (band overrides, --out,
  // --format) — routed before the shared parse so its flags never widen the
  // other commands' accepted set.
  if (group === "view") {
    return runViewCommand(command, rest);
  }
  const key = command === undefined ? group : `${group} ${command}`;
  const parsed = parseFlags(command === undefined ? [] : rest);
  if (!parsed.ok) {
    return renderCliError(
      "caller_error",
      "unknown_flag",
      `unknown flag: ${parsed.unknownFlag}; run lhc --help`,
    );
  }
  const flags = parsed.flags;

  switch (key) {
    case "threads new-thread": {
      // Guard here: an empty path reaching node:sqlite opens a temp database
      // instead of failing, so the adapter refuses before any SDK call.
      if (flags.filePath === undefined) {
        return renderCliError("caller_error", "missing_flag", "threads new-thread requires --file-path");
      }
      const input: Parameters<typeof threads.newThread>[0] = {
        filePath: flags.filePath,
      };
      if (flags.title !== undefined) input.title = flags.title;
      if (flags.registryPath !== undefined) input.registryPath = flags.registryPath;
      return renderResult(await threads.newThread(input));
    }
    case "threads resolve": {
      if (flags.threadId === undefined) {
        return renderCliError("caller_error", "missing_flag", "threads resolve requires --thread-id");
      }
      const input: Parameters<typeof threads.resolve>[0] = {
        threadId: flags.threadId,
      };
      if (flags.registryPath !== undefined) input.registryPath = flags.registryPath;
      return renderResult(await threads.resolve(input));
    }
    case "threads list": {
      return renderResult(
        await threads.listThreads(
          flags.registryPath !== undefined ? { registryPath: flags.registryPath } : undefined,
        ),
      );
    }
    case "intake-stream message-events": {
      if (flags.threadId === undefined && flags.filePath === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "intake-stream message-events requires --thread-id or --file-path",
        );
      }
      const text = await readStdin();
      if (text === null || text.trim() === "") {
        return renderResult(
          stdinCallerError(
            "empty_stdin",
            "message-events expects an events JSON array on stdin; stdin was a TTY or empty",
          ),
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return renderResult(
          stdinCallerError("invalid_event", `stdin is not valid JSON: ${detail}`),
        );
      }
      if (!Array.isArray(parsed)) {
        return renderResult(
          stdinCallerError("invalid_event", "stdin must be a JSON array of events"),
        );
      }
      return renderResult(
        await intakeStream.messageEvents(
          threadRefFrom(flags),
          parsed as readonly MessageEventInput[],
        ),
      );
    }
    case "intake-stream list-events": {
      if (flags.threadId === undefined && flags.filePath === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "intake-stream list-events requires --thread-id or --file-path",
        );
      }
      return renderResult(await intakeStream.listEvents(threadRefFrom(flags)));
    }
    case "messages list": {
      const missingRef = requireThreadRef(flags, "messages list");
      if (missingRef !== undefined) return missingRef;
      // Numeric flags convert here (the argv boundary); semantic bounds
      // checks (from > to, limit < 1) stay in the SDK so refusal JSON has
      // CLI/SDK parity.
      const listOpts: { from?: number; to?: number; limit?: number; includeDeleted?: boolean } =
        {};
      if (flags.includeDeleted === true) listOpts.includeDeleted = true;
      const numericFlags = [
        ["from", flags.from],
        ["to", flags.to],
        ["limit", flags.limit],
      ] as const;
      for (const [name, raw] of numericFlags) {
        if (raw === undefined) continue;
        const value = Number(raw);
        if (!Number.isInteger(value)) {
          return renderCliError(
            "caller_error",
            "missing_flag",
            `--${name} must be an integer, got ${raw}`,
          );
        }
        listOpts[name] = value;
      }
      return runMessagesList(threadRefFrom(flags), listOpts);
    }
    case "messages show": {
      const missingRef = requireThreadRef(flags, "messages show");
      if (missingRef !== undefined) return missingRef;
      if (flags.messageId === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "messages show requires --message-id",
        );
      }
      return runMessagesShow(threadRefFrom(flags), { messageId: flags.messageId });
    }
    case "messages list-queued-work":
      return (
        requireThreadRef(flags, "messages list-queued-work") ??
        renderResult(await messages.listQueuedWork(threadRefFrom(flags)))
      );
    case "messages report": {
      const missingRef = requireThreadRef(flags, "messages report");
      if (missingRef !== undefined) return missingRef;
      const reportFlags: { notReady?: boolean; messageId?: string } = {};
      if (flags.notReady === true) reportFlags.notReady = true;
      if (flags.messageId !== undefined) reportFlags.messageId = flags.messageId;
      return runMessagesReport(threadRefFrom(flags), reportFlags);
    }
    case "messages requeue": {
      const missingRef = requireThreadRef(flags, "messages requeue");
      if (missingRef !== undefined) return missingRef;
      if (flags.messageId === undefined || flags.form === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "messages requeue requires --message-id and --form",
        );
      }
      return runMessagesRequeue(threadRefFrom(flags), {
        messageId: flags.messageId,
        form: flags.form,
      });
    }
    case "messages edit": {
      const missingRef = requireThreadRef(flags, "messages edit");
      if (missingRef !== undefined) return missingRef;
      if (flags.messageId === undefined || flags.content === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "messages edit requires --message (or --message-id) and --content",
        );
      }
      return runMessagesEdit(threadRefFrom(flags), {
        messageId: flags.messageId,
        content: flags.content,
      });
    }
    case "messages delete": {
      const missingRef = requireThreadRef(flags, "messages delete");
      if (missingRef !== undefined) return missingRef;
      if (flags.messageId === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "messages delete requires --message (or --message-id)",
        );
      }
      return runMessagesDelete(threadRefFrom(flags), { messageId: flags.messageId });
    }
    case "turns list":
      return (
        requireThreadRef(flags, "turns list") ??
        renderResult(await turns.listTurns(threadRefFrom(flags)))
      );
    case "turns list-chunks":
      return (
        requireThreadRef(flags, "turns list-chunks") ??
        renderResult(await turns.listChunks(threadRefFrom(flags)))
      );
    case "turns list-queued-work":
      return (
        requireThreadRef(flags, "turns list-queued-work") ??
        renderResult(await turns.listQueuedWork(threadRefFrom(flags)))
      );
    case "turns report": {
      const missingRef = requireThreadRef(flags, "turns report");
      if (missingRef !== undefined) return missingRef;
      const reportFlags: { notReady?: boolean; turnId?: string; chunkId?: string } = {};
      if (flags.notReady === true) reportFlags.notReady = true;
      if (flags.turnId !== undefined) reportFlags.turnId = flags.turnId;
      if (flags.chunkId !== undefined) reportFlags.chunkId = flags.chunkId;
      return runTurnsReport(threadRefFrom(flags), reportFlags);
    }
    case "turns requeue": {
      const missingRef = requireThreadRef(flags, "turns requeue");
      if (missingRef !== undefined) return missingRef;
      if (
        flags.subjectKind === undefined ||
        flags.subjectId === undefined ||
        flags.form === undefined
      ) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "turns requeue requires --subject-kind, --subject-id, and --form",
        );
      }
      if (flags.subjectKind !== "turn" && flags.subjectKind !== "chunk") {
        return renderCliError(
          "caller_error",
          "missing_flag",
          `--subject-kind must be "turn" or "chunk", got ${flags.subjectKind}`,
        );
      }
      return runTurnsRequeue(threadRefFrom(flags), {
        subjectKind: flags.subjectKind,
        subjectId: flags.subjectId,
        form: flags.form,
      });
    }
    case "turns delete": {
      const missingRef = requireThreadRef(flags, "turns delete");
      if (missingRef !== undefined) return missingRef;
      if (flags.turnId === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "turns delete requires --turn (or --turn-id)",
        );
      }
      return runTurnsDelete(threadRefFrom(flags), { turnId: flags.turnId });
    }
    case "inspect overview":
      return (
        requireThreadRef(flags, "inspect overview") ??
        runInspectOverview(threadRefFrom(flags))
      );
    case "inspect health":
      return (
        requireThreadRef(flags, "inspect health") ?? runInspectHealth(threadRefFrom(flags))
      );
    case "inspect view":
      return (
        requireThreadRef(flags, "inspect view") ?? runInspectView(threadRefFrom(flags))
      );
    case "work drain": {
      const missingRef = requireThreadRef(flags, "work drain");
      if (missingRef !== undefined) return missingRef;
      const drainFlags: { provider?: string; maxItems?: number } = {};
      if (flags.provider !== undefined) drainFlags.provider = flags.provider;
      if (flags.maxItems !== undefined) {
        const maxItems = Number(flags.maxItems);
        if (!Number.isInteger(maxItems) || maxItems <= 0) {
          return renderCliError(
            "caller_error",
            "missing_flag",
            `--max-items must be a positive integer, got ${flags.maxItems}`,
          );
        }
        drainFlags.maxItems = maxItems;
      }
      return runWorkDrain(threadRefFrom(flags), drainFlags);
    }
    default:
      return renderCliError(
        "caller_error",
        "unknown_command",
        `unknown command: ${key}; run lhc --help`,
      );
  }
}
