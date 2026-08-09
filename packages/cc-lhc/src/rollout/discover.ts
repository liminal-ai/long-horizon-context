import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { attributeLineSession, rolloutPathForExpectedSession } from "./expected-session.js";
import type { RolloutLineItem } from "./types.js";

/** Encode cwd the way Claude Code names project dirs under ~/.claude/projects/. */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export interface DiscoverDeps {
  projectsRoot?: string;
  pollMs?: number;
  readdirFn?: (path: string) => Promise<Array<{ name: string; isFile: () => boolean }>>;
  statFn?: (path: string) => Promise<{ birthtimeMs: number; mtimeMs: number; size?: number }>;
  readFileFn?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 250;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SessionAttributionError extends Error {
  readonly code: "missing" | "conflict" | "ambiguous";

  constructor(code: SessionAttributionError["code"], message: string) {
    super(message);
    this.name = "SessionAttributionError";
    this.code = code;
  }
}

/**
 * Bind exactly one rollout whose filename is the expected session id.
 * Does not fall back to newest-by-mtime. Missing file returns null (caller polls).
 * Multiple files matching is impossible for a single id; ambiguity is checked
 * by scanning for conflicting non-null sessionId fields once the file exists.
 */
export async function findExpectedSessionFileOnce(
  cwd: string,
  expectedSessionId: string,
  deps: DiscoverDeps = {},
): Promise<string | null> {
  if (expectedSessionId === "") {
    throw new SessionAttributionError("missing", "expected session id is empty");
  }
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const filePath = rolloutPathForExpectedSession(projectsRoot, cwd, expectedSessionId);
  const statFn = deps.statFn ?? ((path: string) => stat(path));
  try {
    await statFn(filePath);
  } catch {
    return null;
  }

  // Refuse if another jsonl in the same project dir also claims this session id
  // in its name (should not happen) or if filename does not match basename.
  if (basename(filePath, ".jsonl") !== expectedSessionId) {
    throw new SessionAttributionError(
      "conflict",
      `rollout path basename does not match expected session id ${expectedSessionId}`,
    );
  }

  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<Array<{ name: string; isFile: () => boolean }>>);
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdirFn(projectDir);
  } catch {
    return filePath;
  }

  const sameName = entries.filter(
    (entry) => entry.isFile() && entry.name === `${expectedSessionId}.jsonl`,
  );
  if (sameName.length > 1) {
    throw new SessionAttributionError(
      "ambiguous",
      `multiple candidates for session ${expectedSessionId} in ${projectDir}`,
    );
  }

  return filePath;
}

/** Poll until the expected session file appears, or abort. */
export async function discoverExpectedSessionFile(
  cwd: string,
  expectedSessionId: string,
  deps: DiscoverDeps = {},
): Promise<string> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const sleep = deps.sleep ?? sleepDefault;
  const signal = deps.signal;

  for (;;) {
    if (signal?.aborted === true) {
      throw new Error("discoverExpectedSessionFile aborted");
    }
    try {
      const found = await findExpectedSessionFileOnce(cwd, expectedSessionId, deps);
      if (found !== null) return found;
    } catch (cause) {
      if (cause instanceof SessionAttributionError) throw cause;
      // transient stat errors — keep polling
    }
    await sleep(pollMs);
  }
}

/**
 * Validate that a known handoff path is attributable to the expected session.
 * Filename must match; optional first-line session fields must not conflict.
 */
export async function assertRolloutMatchesExpectedSession(
  rolloutPath: string,
  expectedSessionId: string,
  deps: Pick<DiscoverDeps, "readFileFn"> = {},
): Promise<void> {
  if (basename(rolloutPath, ".jsonl") !== expectedSessionId) {
    throw new SessionAttributionError(
      "conflict",
      `handoff path ${rolloutPath} does not match expected session ${expectedSessionId}`,
    );
  }
  if (deps.readFileFn === undefined) return;
  try {
    const content = await deps.readFileFn(rolloutPath);
    const first = content.split("\n").find((line) => line.trim() !== "");
    if (first === undefined) return;
    const item = JSON.parse(first) as RolloutLineItem;
    const attr = attributeLineSession(
      expectedSessionId,
      item.sessionId,
      typeof item.session_id === "string" ? item.session_id : undefined,
    );
    if (attr.conflict) {
      throw new SessionAttributionError(
        "conflict",
        `rollout line sessionId ${attr.observed} conflicts with expected ${expectedSessionId}`,
      );
    }
  } catch (cause) {
    if (cause instanceof SessionAttributionError) throw cause;
    // Unreadable/unparseable first line is not an attribution conflict here;
    // the watcher parse path will degrade if needed.
  }
}

/**
 * Resolve which session Claude's `--continue` would likely open: newest mtime
 * jsonl in the project dir. Used only to obtain an explicit id BEFORE launch,
 * never as a post-hoc capture binding heuristic.
 */
export async function resolveContinueSessionId(
  cwd: string,
  deps: DiscoverDeps = {},
): Promise<string | undefined> {
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<Array<{ name: string; isFile: () => boolean }>>);
  const statFn = deps.statFn ?? ((path: string) => stat(path));

  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdirFn(projectDir);
  } catch {
    return undefined;
  }

  let best: { sessionId: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    const name = String(entry.name);
    if (!entry.isFile() || !name.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, name);
    try {
      const fileStat = await statFn(filePath);
      const sessionId = basename(name, ".jsonl");
      if (best === undefined || fileStat.mtimeMs > best.mtimeMs) {
        best = { sessionId, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      // skip
    }
  }
  return best?.sessionId;
}

/** @deprecated cwd-recency discovery removed from the canonical path (Slice 1). */
export async function discoverSessionFile(
  _cwd: string,
  _startedAt: Date,
  _deps: DiscoverDeps = {},
): Promise<string> {
  throw new SessionAttributionError(
    "missing",
    "discoverSessionFile (cwd-recency) removed; pass expectedSessionId to discoverExpectedSessionFile",
  );
}

/** @deprecated use findExpectedSessionFileOnce */
export async function findSessionFileOnce(
  cwd: string,
  _startedAt: Date,
  deps: DiscoverDeps = {},
): Promise<string | null> {
  // Kept only so tests that still call it fail loudly unless they pass expected id via discoverDeps extension.
  void cwd;
  void deps;
  throw new SessionAttributionError(
    "missing",
    "findSessionFileOnce (cwd-recency) removed; use findExpectedSessionFileOnce",
  );
}
