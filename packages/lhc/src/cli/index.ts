import { parseArgs } from "node:util";
import * as intakeStream from "../domains/intake-stream/index.js";
import * as messages from "../domains/messages/index.js";
import * as threads from "../domains/threads/index.js";
import * as turns from "../domains/turns/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import { renderCliError, renderResult, type CliResult } from "./render.js";

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

function parseFlags(args: readonly string[]): ParsedFlags {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "thread-id": { type: "string" },
      "file-path": { type: "string" },
      title: { type: "string" },
      registry: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  const flags: ParsedFlags = {};
  if (typeof values["thread-id"] === "string") flags.threadId = values["thread-id"];
  if (typeof values["file-path"] === "string") flags.filePath = values["file-path"];
  if (typeof values.title === "string") flags.title = values.title;
  if (typeof values.registry === "string") flags.registryPath = values.registry;
  return flags;
}

function threadRefFrom(flags: ParsedFlags): ThreadRef {
  if (flags.threadId !== undefined) {
    return flags.registryPath !== undefined
      ? { threadId: flags.threadId, registryPath: flags.registryPath }
      : { threadId: flags.threadId };
  }
  return { filePath: flags.filePath ?? "" };
}

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  if (argv.length === 0) {
    return renderCliError("caller_error", "unknown_command", "no command given; run lhc --help");
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, stdout: HELP, stderr: "" };
  }

  const [group, command, ...rest] = argv;
  const key = command === undefined ? group : `${group} ${command}`;
  const flags = parseFlags(command === undefined ? [] : rest);

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
    case "intake-stream message-events":
      return renderResult(await intakeStream.messageEvents(threadRefFrom(flags), []));
    case "intake-stream list-events":
      return renderResult(await intakeStream.listEvents(threadRefFrom(flags)));
    case "messages list":
      return renderResult(await messages.listMessages(threadRefFrom(flags)));
    case "messages list-queued-work":
      return renderResult(await messages.listQueuedWork(threadRefFrom(flags)));
    case "turns list":
      return renderResult(await turns.listTurns(threadRefFrom(flags)));
    case "turns list-queued-work":
      return renderResult(await turns.listQueuedWork(threadRefFrom(flags)));
    default:
      return renderCliError(
        "caller_error",
        "unknown_command",
        `unknown command: ${key}; run lhc --help`,
      );
  }
}
