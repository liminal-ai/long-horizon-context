import { readFile } from "node:fs/promises";

export interface RolloutEnvelope {
  sessionId: string;
  cwd: string;
  originator: string;
  cliVersion: string;
}

export interface EnvelopeDeps {
  readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse the first rollout JSONL line when it is a `session_meta` record. */
export function parseSessionMetaLine(line: string): RolloutEnvelope | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "session_meta") return null;

  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;

  const sessionId = asString(fields.session_id) ?? asString(fields.id);
  const cwd = asString(fields.cwd);
  // originator/cli_version are display metadata; identity and cwd are the
  // fields discovery decisions ride on, so only those are required.
  const originator = asString(fields.originator) ?? "";
  const cliVersion = asString(fields.cli_version) ?? "";

  if (sessionId === undefined || cwd === undefined) {
    return null;
  }

  return { sessionId, cwd, originator, cliVersion };
}

/** Read a rollout file's first line and parse `session_meta` envelope fields. */
export async function readRolloutEnvelope(
  filePath: string,
  deps: EnvelopeDeps = {},
): Promise<RolloutEnvelope | null> {
  const readFileFn = deps.readFileFn ?? ((path, encoding) => readFile(path, encoding));
  let content: string;
  try {
    content = await readFileFn(filePath, "utf8");
  } catch {
    return null;
  }

  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  return parseSessionMetaLine(firstLine);
}
