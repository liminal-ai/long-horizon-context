import { parseArgs } from "node:util";
import * as intakeStream from "../domains/intake-stream/index.js";
import * as messages from "../domains/messages/index.js";
import * as threads from "../domains/threads/index.js";
import * as turns from "../domains/turns/index.js";
import type { MessageEventInput } from "../domains/intake-stream/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import type { OpResult } from "../shared/errors.js";
import { renderCliError, renderResult, type CliResult } from "./render.js";

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
  lhc messages list (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc messages list-queued-work (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc turns list (--thread-id <id> | --file-path <p>) [--registry <r>]
  lhc turns list-queued-work (--thread-id <id> | --file-path <p>) [--registry <r>]

Every command prints the SDK result (value or error) as JSON and exits 0 on
success, 1 on failure. message-events reads an events JSON array on stdin.
`;

interface ParsedFlags {
  threadId?: string;
  filePath?: string;
  title?: string;
  registryPath?: string;
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
    case "messages list":
      return (
        requireThreadRef(flags, "messages list") ??
        renderResult(await messages.listMessages(threadRefFrom(flags)))
      );
    case "messages list-queued-work":
      return (
        requireThreadRef(flags, "messages list-queued-work") ??
        renderResult(await messages.listQueuedWork(threadRefFrom(flags)))
      );
    case "turns list":
      return (
        requireThreadRef(flags, "turns list") ??
        renderResult(await turns.listTurns(threadRefFrom(flags)))
      );
    case "turns list-queued-work":
      return (
        requireThreadRef(flags, "turns list-queued-work") ??
        renderResult(await turns.listQueuedWork(threadRefFrom(flags)))
      );
    default:
      return renderCliError(
        "caller_error",
        "unknown_command",
        `unknown command: ${key}; run lhc --help`,
      );
  }
}
