import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readRolloutEnvelope } from "./envelope.js";

export interface DiscoverResult {
  path: string;
  sessionId: string;
}

export interface DiscoverDeps {
  codexHome?: string;
  /**
   * Only attach to a rollout whose session_meta cwd matches. Codex writes all
   * sessions into one global date-dir tree, so without this filter a busier
   * concurrent session from another workspace can win the newest-mtime race
   * and the wrapper captures a stranger's conversation.
   */
  expectedCwd?: string | undefined;
  pollMs?: number;
  readdirFn?: (path: string) => Promise<Array<{ name: string; isFile: () => boolean }>>;
  statFn?: (path: string) => Promise<{ birthtimeMs: number; mtimeMs: number }>;
  readEnvelopeFn?: typeof readRolloutEnvelope;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Strict codex rollout filename: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl */
export const ROLLOUT_FILENAME_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

const DEFAULT_POLL_MS = 250;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Extract the session uuid suffix from a codex rollout filename. */
export function parseRolloutFilename(name: string): string | null {
  const match = ROLLOUT_FILENAME_RE.exec(name);
  return match?.[1] ?? null;
}

function sessionsDateDir(codexHome: string, date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(codexHome, "sessions", String(year), month, day);
}

function yesterday(date: Date): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() - 1);
  return copy;
}

function dateDirsForNow(codexHome: string, now: Date): [string, string] {
  return [sessionsDateDir(codexHome, now), sessionsDateDir(codexHome, yesterday(now))];
}

async function newestQualifyingRollout(
  dateDirs: string[],
  startedAtMs: number,
  deps: Required<Pick<DiscoverDeps, "readdirFn" | "statFn" | "readEnvelopeFn">> & {
    expectedCwd: string | undefined;
  },
): Promise<DiscoverResult | null> {
  const candidates: Array<{ result: DiscoverResult; mtimeMs: number }> = [];

  for (const dir of dateDirs) {
    let entries: Array<{ name: string; isFile: () => boolean }>;
    try {
      entries = await deps.readdirFn(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      if (!entry.isFile()) continue;

      const sessionId = parseRolloutFilename(name);
      if (sessionId === null) continue;

      const filePath = join(dir, name);
      let fileStat: { birthtimeMs: number; mtimeMs: number };
      try {
        fileStat = await deps.statFn(filePath);
      } catch {
        continue;
      }

      const activeSinceStart =
        fileStat.birthtimeMs >= startedAtMs || fileStat.mtimeMs >= startedAtMs;
      if (!activeSinceStart) continue;

      candidates.push({ result: { path: filePath, sessionId }, mtimeMs: fileStat.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    if (deps.expectedCwd !== undefined) {
      // A session_meta first line may not be flushed yet on a brand-new file;
      // treat unreadable as non-matching and let the next poll retry it.
      const envelope = await deps.readEnvelopeFn(candidate.result.path);
      if (envelope === null || envelope.cwd !== deps.expectedCwd) continue;
    }
    return candidate.result;
  }

  return null;
}

/** Poll until a codex rollout file appears or becomes active after `startedAt`. */
export async function discoverSessionFile(
  startedAt: Date,
  deps: DiscoverDeps = {},
): Promise<DiscoverResult> {
  const codexHome = deps.codexHome ?? join(homedir(), ".codex");
  const startedAtMs = startedAt.getTime();
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<
        Array<{ name: string; isFile: () => boolean }>
      >);
  const statFn = deps.statFn ?? ((path: string) => stat(path));
  const readEnvelopeFn = deps.readEnvelopeFn ?? readRolloutEnvelope;
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal;

  for (;;) {
    if (signal?.aborted === true) {
      throw new Error("discoverSessionFile aborted");
    }

    const found = await newestQualifyingRollout(dateDirsForNow(codexHome, now()), startedAtMs, {
      readdirFn,
      statFn,
      readEnvelopeFn,
      expectedCwd: deps.expectedCwd,
    });
    if (found !== null) return found;

    await sleep(pollMs);
  }
}

/** Test hook: one-shot scan without polling loop. */
export async function findSessionFileOnce(
  startedAt: Date,
  deps: DiscoverDeps = {},
): Promise<DiscoverResult | null> {
  const codexHome = deps.codexHome ?? join(homedir(), ".codex");
  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<
        Array<{ name: string; isFile: () => boolean }>
      >);
  const statFn = deps.statFn ?? ((path: string) => stat(path));
  const readEnvelopeFn = deps.readEnvelopeFn ?? readRolloutEnvelope;
  const now = deps.now ?? (() => new Date());

  return newestQualifyingRollout(
    dateDirsForNow(codexHome, now()),
    startedAt.getTime(),
    { readdirFn, statFn, readEnvelopeFn, expectedCwd: deps.expectedCwd },
  );
}
