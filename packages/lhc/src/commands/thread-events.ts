import { readFileSync } from "node:fs";

import type { CliResult } from "./run.js";
import { ThreadEventStore, type ProjectedThreadRead } from "../thread-events/store.js";
import { ThreadEventValidationError, type PersistedThreadEvent } from "../thread-events/schema.js";

interface ParsedThreadEventArgs {
  positional: string[];
  options: Map<string, string | boolean>;
}

export async function runThreadEventsCommand(args: readonly string[]): Promise<CliResult> {
  const parsed = parseThreadEventArgs(args);
  const [command] = parsed.positional;
  const eventDbPath = stringOption(parsed, "event-db") ?? stringOption(parsed, "thread-db");
  if (!eventDbPath) {
    return { exitCode: 1, stdout: "", stderr: "lhc thread-events requires --event-db <path>.\n" };
  }

  const store = new ThreadEventStore({ eventDbPath });
  try {
    if (command === "create") {
      const clientThreadId = stringOption(parsed, "client-thread-id") ?? `lhc-cli-${Date.now()}`;
      const title = stringOption(parsed, "title");
      return jsonResult(await store.createThread(title === undefined ? { clientThreadId } : { clientThreadId, title }));
    }

    if (command === "append") {
      const filePath = stringOption(parsed, "file");
      if (!filePath) {
        throw new Error("lhc thread-events append requires --file <event.json>.");
      }
      const input = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return jsonResult(await appendFromCliInput(store, input, stringOption(parsed, "client-thread-id")));
    }

    if (command === "list") {
      const events = await store.list();
      return parsed.options.has("json") ? jsonResult(events) : ok(printThreadEvents(events));
    }

    if (command === "threads") {
      const threads = await store.listThreads();
      return parsed.options.has("json") ? jsonResult(threads) : ok(JSON.stringify(threads, null, 2) + "\n");
    }

    if (command === "read") {
      const clientThreadId = stringOption(parsed, "client-thread-id");
      if (!clientThreadId) {
        throw new Error("lhc thread-events read requires --client-thread-id <id>.");
      }
      const thread = await store.readThread(clientThreadId);
      if (!thread) {
        return { exitCode: 1, stdout: "", stderr: `Thread not found for clientThreadId: ${clientThreadId}\n` };
      }
      return parsed.options.has("json") ? jsonResult(thread) : ok(printThreadRead(thread));
    }

    return { exitCode: 1, stdout: THREAD_EVENTS_HELP_TEXT, stderr: `Unknown thread-events command: ${command ?? ""}\n` };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: formatThreadEventError(error) };
  } finally {
    store.close();
  }
}

function parseThreadEventArgs(argv: readonly string[]): ParsedThreadEventArgs {
  const positional: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    if (eqIndex >= 0) {
      options.set(withoutPrefix.slice(0, eqIndex), withoutPrefix.slice(eqIndex + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(withoutPrefix, next);
      i += 1;
    } else {
      options.set(withoutPrefix, true);
    }
  }

  return { positional, options };
}

async function appendFromCliInput(
  store: ThreadEventStore,
  input: unknown,
  clientThreadIdOption: string | undefined,
): Promise<unknown> {
  if (isObject(input) && typeof input.clientThreadId === "string" && Array.isArray(input.events)) {
    return await store.appendMany({ clientThreadId: input.clientThreadId, events: input.events as never[] });
  }

  if (Array.isArray(input)) {
    if (!clientThreadIdOption) {
      throw new Error("lhc thread-events append requires --client-thread-id <id> or clientThreadId in the input file.");
    }
    return await store.appendMany(clientThreadIdOption, input as never[]);
  }

  const clientThreadId = clientThreadIdOption ?? (isObject(input) && typeof input.clientThreadId === "string" ? input.clientThreadId : undefined);
  if (!clientThreadId) {
    throw new Error("lhc thread-events append requires --client-thread-id <id> or clientThreadId in the input file.");
  }

  const eventInput = isObject(input) && "clientThreadId" in input
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "clientThreadId"))
    : input;
  return await store.appendMany(clientThreadId, [eventInput as never]);
}

function stringOption(parsed: ParsedThreadEventArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function jsonResult(value: unknown): CliResult {
  return ok(`${JSON.stringify(value, null, 2)}\n`);
}

function printThreadEvents(events: readonly PersistedThreadEvent[]): string {
  if (events.length === 0) {
    return "No thread events.\n";
  }
  return `${events.map((event) => `${event.eventOrder}\t${event.eventKind}\t${event.threadId}`).join("\n")}\n`;
}

function printThreadRead(read: ProjectedThreadRead): string {
  if (read.messages.length === 0) {
    return `Thread ${read.thread.clientThreadId} has no projected messages.\n`;
  }
  return `${read.messages.map((message) => `${message.messageOrder}\t${message.messageKind}\t${message.blocks.length} block(s)`).join("\n")}\n`;
}

function formatThreadEventError(error: unknown): string {
  if (error instanceof ThreadEventValidationError || error instanceof Error) {
    return `${error.message}\n`;
  }
  return `${String(error)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const THREAD_EVENTS_HELP_TEXT = `lhc thread-events - Create, append, and inspect schema-backed thread events

USAGE
  lhc thread-events create --event-db <path> [--client-thread-id <id>] [--title "..."]
  lhc thread-events append --event-db <path> --client-thread-id <id> --file <event.json>
  lhc thread-events list --event-db <path> [--json]
  lhc thread-events threads --event-db <path> [--json]
  lhc thread-events read --event-db <path> --client-thread-id <id> [--json]
`;
