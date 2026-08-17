import { access, copyFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodeProjectPath } from "./discover.js";

export const SESSIONS_INDEX_UNREADABLE_MESSAGE = "sessions-index.json unreadable; not touching it; session unchanged";

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
}

export interface AppendIndexInput {
  projectDir: string;
  sessionId: string;
  sessionFilePath: string;
  firstPrompt: string;
  messageCount: number;
  projectPath: string;
}

export interface RolloutWriteDeps {
  mkdirFn?: typeof mkdir;
  openFn?: typeof open;
  readFileFn?: typeof readFile;
  writeFileFn?: typeof writeFile;
  copyFileFn?: typeof copyFile;
  renameFn?: typeof rename;
  statFn?: typeof stat;
  accessFn?: typeof access;
  tempPathFn?: (indexPath: string) => string;
}

const defaultDeps = (): Required<RolloutWriteDeps> => ({
  mkdirFn: mkdir,
  openFn: open,
  readFileFn: readFile,
  writeFileFn: writeFile,
  copyFileFn: copyFile,
  renameFn: rename,
  statFn: stat,
  accessFn: access,
  tempPathFn: sessionsIndexTempPath,
});

function isENOENT(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

let sessionsIndexTempCounter = 0;

export function sessionsIndexTempPath(indexPath: string): string {
  sessionsIndexTempCounter += 1;
  return `${indexPath}.tmp.${String(process.pid)}.${String(Date.now())}.${String(sessionsIndexTempCounter)}`;
}

export async function writeRolloutFileFsync(
  filePath: string,
  content: string,
  deps: RolloutWriteDeps = {},
): Promise<void> {
  const { mkdirFn, openFn } = { ...defaultDeps(), ...deps };
  await mkdirFn(dirname(filePath), { recursive: true });
  const handle = await openFn(filePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function loadSessionsIndexForAppend(
  projectDir: string,
  deps: RolloutWriteDeps = {},
): Promise<{ index: SessionsIndex; indexPath: string; backupPath: string }> {
  const { readFileFn, copyFileFn, accessFn } = { ...defaultDeps(), ...deps };
  const indexPath = join(projectDir, "sessions-index.json");
  const backupPath = `${indexPath}.bak`;

  let existingContent: string;
  try {
    existingContent = await readFileFn(indexPath, "utf8");
  } catch (cause) {
    if (isENOENT(cause)) {
      return { index: { version: 1, entries: [] }, indexPath, backupPath };
    }
    throw cause;
  }

  let index: SessionsIndex;
  try {
    index = JSON.parse(existingContent) as SessionsIndex;
  } catch {
    throw new Error(SESSIONS_INDEX_UNREADABLE_MESSAGE);
  }

  let backupExists = false;
  try {
    await accessFn(backupPath);
    backupExists = true;
  } catch {
    backupExists = false;
  }
  if (!backupExists) {
    await copyFileFn(indexPath, backupPath);
  }

  return { index, indexPath, backupPath };
}

export async function readSessionsIndex(projectDir: string, deps: RolloutWriteDeps = {}): Promise<SessionsIndex> {
  const loaded = await loadSessionsIndexForAppend(projectDir, deps);
  return loaded.index;
}

export function projectPathFromIndex(index: SessionsIndex, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  for (const entry of index.entries) {
    if (entry.projectPath === cwd || encodeProjectPath(entry.projectPath) === encoded) {
      return entry.projectPath;
    }
  }
  return cwd;
}

export async function appendSessionsIndexEntry(input: AppendIndexInput, deps: RolloutWriteDeps = {}): Promise<void> {
  const { writeFileFn, renameFn, statFn, tempPathFn } = { ...defaultDeps(), ...deps };
  const loaded = await loadSessionsIndexForAppend(input.projectDir, deps);
  const index = loaded.index;
  const indexPath = loaded.indexPath;
  const tempPath = tempPathFn(indexPath);

  let fileMtime = Date.now();
  try {
    const fileStat = await statFn(input.sessionFilePath);
    fileMtime = fileStat.mtimeMs;
  } catch {
    // keep now
  }

  const now = new Date().toISOString();
  const firstPrompt = input.firstPrompt.slice(0, 100);
  // Idempotent by session id: a retry (crash after file fsync, before or
  // after the index rename) must never append a duplicate or a conflicting
  // entry. Same session id + same path → refresh in place; same id but a
  // different path is a correlation error and fails closed.
  const existingIndex = index.entries.findIndex((entry) => entry.sessionId === input.sessionId);
  const existing = existingIndex >= 0 ? index.entries[existingIndex] : undefined;
  if (existing !== undefined && existing.fullPath !== input.sessionFilePath) {
    throw new Error(
      `sessions-index.json already lists session ${input.sessionId} at ${existing.fullPath}; refusing to repoint it to ${input.sessionFilePath}`,
    );
  }
  const newEntry: SessionsIndexEntry = {
    sessionId: input.sessionId,
    fullPath: input.sessionFilePath,
    fileMtime,
    firstPrompt,
    summary: `LHC rebuild: ${firstPrompt.slice(0, 50)}${firstPrompt.length > 50 ? "..." : ""}`,
    messageCount: input.messageCount,
    created: existing?.created ?? now,
    modified: now,
    projectPath: input.projectPath,
    isSidechain: false,
  };
  if (existing === undefined) {
    index.entries.push(newEntry);
  } else {
    index.entries[existingIndex] = newEntry;
  }

  const serialized = JSON.stringify(index, null, 2);
  JSON.parse(serialized);
  await writeFileFn(tempPath, serialized, "utf8");
  await renameFn(tempPath, indexPath);
}

export function rolloutPathForSession(projectsRoot: string, cwd: string, sessionId: string): string {
  return join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
}
