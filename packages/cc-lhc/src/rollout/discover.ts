import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { attributeLineSession, rolloutPathForExpectedSession } from "./expected-session.js";
import type { RolloutLineItem } from "./types.js";

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

  const sameName = entries.filter((entry) => entry.isFile() && entry.name === `${expectedSessionId}.jsonl`);
  if (sameName.length > 1) {
    throw new SessionAttributionError(
      "ambiguous",
      `multiple candidates for session ${expectedSessionId} in ${projectDir}`,
    );
  }

  return filePath;
}

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
    }
    await sleep(pollMs);
  }
}

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
  }
}

export async function resolveContinueSessionId(cwd: string, deps: DiscoverDeps = {}): Promise<string | undefined> {
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
    } catch {}
  }
  return best?.sessionId;
}

export async function discoverSessionFile(_cwd: string, _startedAt: Date, _deps: DiscoverDeps = {}): Promise<string> {
  throw new SessionAttributionError(
    "missing",
    "discoverSessionFile (cwd-recency) removed; pass expectedSessionId to discoverExpectedSessionFile",
  );
}

export async function findSessionFileOnce(
  cwd: string,
  _startedAt: Date,
  deps: DiscoverDeps = {},
): Promise<string | null> {
  void cwd;
  void deps;
  throw new SessionAttributionError(
    "missing",
    "findSessionFileOnce (cwd-recency) removed; use findExpectedSessionFileOnce",
  );
}
