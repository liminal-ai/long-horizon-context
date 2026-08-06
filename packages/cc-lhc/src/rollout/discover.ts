import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Encode cwd the way Claude Code names project dirs under ~/.claude/projects/. */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export interface DiscoverDeps {
  projectsRoot?: string;
  pollMs?: number;
  readdirFn?: (path: string) => Promise<Array<{ name: string; isFile: () => boolean }>>;
  statFn?: (path: string) => Promise<{ birthtimeMs: number; mtimeMs: number }>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 250;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function newestActiveJsonl(
  projectDir: string,
  startedAtMs: number,
  deps: Required<Pick<DiscoverDeps, "readdirFn" | "statFn">>,
): Promise<string | null> {
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await deps.readdirFn(projectDir);
  } catch {
    return null;
  }

  let bestPath: string | null = null;
  let bestMtime = -1;

  for (const entry of entries) {
    const name = String(entry.name);
    if (!entry.isFile() || !name.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, name);
    let fileStat: { birthtimeMs: number; mtimeMs: number };
    try {
      fileStat = await deps.statFn(filePath);
    } catch {
      continue;
    }

    const birthMs = fileStat.birthtimeMs;
    const mtimeMs = fileStat.mtimeMs;
    const activeSinceStart = birthMs >= startedAtMs || mtimeMs >= startedAtMs;
    if (!activeSinceStart) continue;

    if (mtimeMs > bestMtime) {
      bestMtime = mtimeMs;
      bestPath = filePath;
    }
  }

  return bestPath;
}

/** Poll until a session JSONL for `cwd` appears or becomes active after `startedAt`. */
export async function discoverSessionFile(cwd: string, startedAt: Date, deps: DiscoverDeps = {}): Promise<string> {
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  const startedAtMs = startedAt.getTime();
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<Array<{ name: string; isFile: () => boolean }>>);
  const statFn = deps.statFn ?? ((path: string) => stat(path));
  const sleep = deps.sleep ?? sleepDefault;
  const signal = deps.signal;

  for (;;) {
    if (signal?.aborted === true) {
      throw new Error("discoverSessionFile aborted");
    }
    const found = await newestActiveJsonl(projectDir, startedAtMs, { readdirFn, statFn });
    if (found !== null) return found;
    await sleep(pollMs);
  }
}

/** Test hook: one-shot scan without polling loop. */
export async function findSessionFileOnce(
  cwd: string,
  startedAt: Date,
  deps: DiscoverDeps = {},
): Promise<string | null> {
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  const readdirFn =
    deps.readdirFn ??
    ((path: string) =>
      readdir(path, { withFileTypes: true }) as Promise<Array<{ name: string; isFile: () => boolean }>>);
  const statFn = deps.statFn ?? ((path: string) => stat(path));
  return newestActiveJsonl(projectDir, startedAt.getTime(), { readdirFn, statFn });
}
