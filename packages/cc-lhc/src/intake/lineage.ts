import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { OpResult, ThreadRef } from "lhc";

import { encodeProjectPath } from "../rollout/discover.js";
import {
  createReplayDedupeState,
  mergeSignatures,
  type ReplayDedupeState,
} from "./replay-dedupe.js";

export const LINEAGE_VERSION = 1;

export interface LineageSessionEntry {
  threadId: string;
  updatedAt: string;
}

export interface LineageFile {
  version: number;
  sessions: Record<string, LineageSessionEntry>;
  signatures: Record<string, string[]>;
}

export interface LineageDeps {
  readFileFn?: typeof readFile;
  writeFileFn?: typeof writeFile;
  renameFn?: typeof rename;
  mkdirFn?: typeof mkdir;
  accessFn?: typeof access;
  readdirFn?: typeof readdir;
  statFn?: typeof stat;
  tempPathFn?: (mapPath: string) => string;
  nowFn?: () => Date;
}

const defaultDeps = (): Required<LineageDeps> => ({
  readFileFn: readFile,
  writeFileFn: writeFile,
  renameFn: rename,
  mkdirFn: mkdir,
  accessFn: access,
  readdirFn: readdir,
  statFn: stat,
  tempPathFn: lineageTempPath,
  nowFn: () => new Date(),
});

let lineageTempCounter = 0;

export function defaultLineagePath(): string {
  return join(homedir(), ".lhc", "cc-sessions.json");
}

export function lineageTempPath(mapPath: string): string {
  lineageTempCounter += 1;
  return `${mapPath}.tmp.${String(process.pid)}.${String(Date.now())}.${String(lineageTempCounter)}`;
}

export function emptyLineageFile(): LineageFile {
  return { version: LINEAGE_VERSION, sessions: {}, signatures: {} };
}

function isENOENT(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

export function lineageWriteFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `[cc-lhc] lineage write failed (continuing): ${message}`;
}

export async function safeRecordSessionThread(
  mapPath: string,
  sessionId: string,
  threadId: string,
  logError: (message: string) => void,
  deps: LineageDeps = {},
): Promise<void> {
  try {
    await recordSessionThread(mapPath, sessionId, threadId, deps);
  } catch (cause) {
    logError(lineageWriteFailureMessage(cause));
  }
}

export async function safeAppendThreadSignatures(
  mapPath: string,
  threadId: string,
  added: readonly string[],
  logError: (message: string) => void,
  deps: LineageDeps = {},
): Promise<void> {
  try {
    await appendThreadSignatures(mapPath, threadId, added, deps);
  } catch (cause) {
    logError(lineageWriteFailureMessage(cause));
  }
}

export async function loadLineageFile(mapPath: string, deps: LineageDeps = {}): Promise<LineageFile> {
  const { readFileFn, renameFn } = { ...defaultDeps(), ...deps };
  try {
    const raw = await readFileFn(mapPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LineageFile>;
    if (parsed.version !== LINEAGE_VERSION || typeof parsed.sessions !== "object" || parsed.sessions === null) {
      throw new Error("lineage version or sessions invalid");
    }
    return {
      version: LINEAGE_VERSION,
      sessions: parsed.sessions,
      signatures: typeof parsed.signatures === "object" && parsed.signatures !== null ? parsed.signatures : {},
    };
  } catch (cause) {
    if (isENOENT(cause)) return emptyLineageFile();
    try {
      await renameFn(mapPath, `${mapPath}.corrupt-${String(Date.now())}`);
    } catch {
      // best effort
    }
    return emptyLineageFile();
  }
}

export async function saveLineageFile(mapPath: string, file: LineageFile, deps: LineageDeps = {}): Promise<void> {
  const { mkdirFn, writeFileFn, renameFn, tempPathFn } = { ...defaultDeps(), ...deps };
  await mkdirFn(dirname(mapPath), { recursive: true });
  const tempPath = tempPathFn(mapPath);
  const serialized = JSON.stringify(file, null, 2);
  JSON.parse(serialized);
  await writeFileFn(tempPath, serialized, "utf8");
  await renameFn(tempPath, mapPath);
}

export function lookupThreadForSession(file: LineageFile, sessionId: string): string | undefined {
  return file.sessions[sessionId]?.threadId;
}

export function newestSessionEntry(file: LineageFile): { sessionId: string; entry: LineageSessionEntry } | undefined {
  let best: { sessionId: string; entry: LineageSessionEntry } | undefined;
  for (const [sessionId, entry] of Object.entries(file.sessions)) {
    if (best === undefined || entry.updatedAt > best.entry.updatedAt) {
      best = { sessionId, entry };
    }
  }
  return best;
}

export async function newestJsonlSessionId(
  projectsRoot: string,
  cwd: string,
  deps: LineageDeps = {},
): Promise<string | undefined> {
  const { readdirFn, statFn } = { ...defaultDeps(), ...deps };
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  let names: string[];
  try {
    names = await readdirFn(projectDir);
  } catch (cause) {
    if (isENOENT(cause)) return undefined;
    throw cause;
  }

  let best: { sessionId: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, name);
    try {
      const fileStat = await statFn(filePath);
      const sessionId = basename(name, ".jsonl");
      if (best === undefined || fileStat.mtimeMs > best.mtimeMs) {
        best = { sessionId, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      // skip unreadable
    }
  }
  return best?.sessionId;
}

export async function tryContinueThreadFromNewestSession(
  file: LineageFile,
  cwd: string,
  projectsRoot: string,
  deps: LineageDeps = {},
): Promise<{ sessionId: string; threadId: string } | undefined> {
  const newest = newestSessionEntry(file);
  if (newest === undefined) return undefined;
  const newestJsonl = await newestJsonlSessionId(projectsRoot, cwd, deps);
  if (newestJsonl === undefined || newestJsonl !== newest.sessionId) return undefined;
  return { sessionId: newest.sessionId, threadId: newest.entry.threadId };
}

export async function recordSessionThread(
  mapPath: string,
  sessionId: string,
  threadId: string,
  deps: LineageDeps = {},
): Promise<void> {
  const { nowFn } = { ...defaultDeps(), ...deps };
  const file = await loadLineageFile(mapPath, deps);
  file.sessions[sessionId] = { threadId, updatedAt: nowFn().toISOString() };
  await saveLineageFile(mapPath, file, deps);
}

export async function appendThreadSignatures(
  mapPath: string,
  threadId: string,
  added: readonly string[],
  deps: LineageDeps = {},
): Promise<void> {
  if (added.length === 0) return;
  const file = await loadLineageFile(mapPath, deps);
  const existing = file.signatures[threadId] ?? [];
  file.signatures[threadId] = mergeSignatures(existing, added);
  await saveLineageFile(mapPath, file, deps);
}

export function threadSignatures(file: LineageFile, threadId: string): string[] {
  return file.signatures[threadId] ?? [];
}

export interface ResolveCaptureThreadInput {
  sessionId: string;
  cwd: string;
  resumeSessionId?: string;
  continueFlag?: boolean;
  registryPath?: string;
  lineagePath?: string;
  projectsRoot?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  lineageDeps?: LineageDeps;
  createThreadFn: (cwd: string, registryPath?: string) => Promise<OpResult<ThreadRef>>;
}

export interface ResolveCaptureThreadResult {
  threadRef: ThreadRef;
  isExistingThread: boolean;
  dedupeState: ReplayDedupeState;
  persistSignatures: (signatures: string[]) => Promise<void>;
}

export async function resolveCaptureThread(input: ResolveCaptureThreadInput): Promise<ResolveCaptureThreadResult> {
  const mapPath = input.lineagePath ?? defaultLineagePath();
  const log = input.log ?? (() => {});
  const logError = input.logError ?? (() => {});
  const file = await loadLineageFile(mapPath, input.lineageDeps);

  let threadId: string | undefined = lookupThreadForSession(file, input.sessionId);
  let isExistingThread = threadId !== undefined;

  if (threadId === undefined && input.resumeSessionId !== undefined) {
    const fromResume = lookupThreadForSession(file, input.resumeSessionId);
    if (fromResume !== undefined) {
      threadId = fromResume;
      isExistingThread = true;
    }
  }

  if (threadId === undefined && input.continueFlag === true && input.projectsRoot !== undefined) {
    const continued = await tryContinueThreadFromNewestSession(file, input.cwd, input.projectsRoot, input.lineageDeps);
    if (continued !== undefined) {
      threadId = continued.threadId;
      isExistingThread = true;
    }
  }

  if (threadId !== undefined) {
    log(`cc-lhc: continuing thread ${threadId} for session ${input.sessionId}`);
    await safeRecordSessionThread(mapPath, input.sessionId, threadId, logError, input.lineageDeps);
    const signatures = threadSignatures(file, threadId);
    const threadRef: ThreadRef =
      input.registryPath === undefined ? { threadId } : { threadId, registryPath: input.registryPath };
    return {
      threadRef,
      isExistingThread,
      dedupeState: createReplayDedupeState(isExistingThread, signatures),
      persistSignatures: async (added) => {
        await safeAppendThreadSignatures(mapPath, threadId!, added, logError, input.lineageDeps);
      },
    };
  }

  const created = await input.createThreadFn(input.cwd, input.registryPath);
  if (!created.ok) {
    throw new Error(`cc-lhc thread create failed: ${created.error.reason}`);
  }
  const newThreadId = "threadId" in created.value ? created.value.threadId : "";
  if (newThreadId === "") {
    throw new Error("cc-lhc thread create failed: missing threadId");
  }
  await safeRecordSessionThread(mapPath, input.sessionId, newThreadId, logError, input.lineageDeps);
  return {
    threadRef: created.value,
    isExistingThread: false,
    dedupeState: createReplayDedupeState(false, []),
    persistSignatures: async (added) => {
      await safeAppendThreadSignatures(mapPath, newThreadId, added, logError, input.lineageDeps);
    },
  };
}
