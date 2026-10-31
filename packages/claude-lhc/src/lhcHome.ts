import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type ThreadAliasResolution,
  type ThreadRef,
  threads,
} from "lhc";
import type { SessionInspection } from "./protocol.js";
import { createSummaryWorkerModelCall, summaryWorkerAssignments } from "./summaryWorker.js";

export const ALIAS_HOST = "t3code-lhc";

const registryFile = (home: string): string => join(home, "registry.sqlite");

export function registryPath(home: string): string {
  mkdirSync(home, { recursive: true });
  return registryFile(home);
}

export function newThreadFilePath(home: string): string {
  const dir = join(home, "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

export function sessionAlias(sessionId: string): string {
  return `${ALIAS_HOST}:${sessionId}`;
}

export function threadRef(threadId: string, home: string): ThreadRef {
  return { threadId, registryPath: registryPath(home) };
}

export interface LhcInstanceOptions {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  tokenFamily: string;
  mode?: "background" | "manual";
}

export function createLhc(options: LhcInstanceOptions): Lhc {
  const mode = options.mode ?? "background";
  if (process.env.CLAUDE_LHC_NO_INFERENCE === "1") {
    return initLhc({
      mode,
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      tokenFamily: options.tokenFamily,
    });
  }
  return initLhc({
    mode,
    inference: {
      call: createSummaryWorkerModelCall({ claudeBin: options.claudeBin, env: options.env }),
      assignments: summaryWorkerAssignments(),
      timeoutMs: 90_000,
    },
    tokenFamily: options.tokenFamily,
  });
}

export async function createThread(cwd: string, home: string): Promise<string> {
  const created = await threads.newThread({
    filePath: newThreadFilePath(home),
    cwd,
    title: basename(cwd) || cwd,
    registryPath: registryPath(home),
  });
  if (!created.ok) throw new Error(`LHC thread creation failed: ${created.error.reason}`);
  return created.value.threadId;
}

export async function bindSession(threadId: string, sessionId: string, home: string): Promise<void> {
  const bound = await threads.registerCurrentAlias({
    alias: sessionAlias(sessionId),
    threadId,
    registryPath: registryPath(home),
  });
  if (!bound.ok) throw new Error(`LHC alias registration failed: ${bound.error.reason}`);
}

async function lookupSession(sessionId: string, home: string): Promise<ThreadAliasResolution | null> {
  const resolved = await threads.resolveAlias({ alias: sessionAlias(sessionId), registryPath: registryFile(home) });
  if (resolved.ok) return resolved.value;
  if (resolved.error.code === "alias_not_found") return null;
  throw new Error(`LHC registry read failed: ${resolved.error.reason}`);
}

export async function resolveSession(sessionId: string, home: string): Promise<string | null> {
  return (await lookupSession(sessionId, home))?.threadId ?? null;
}

export async function inspectSession(sessionId: string, home: string): Promise<SessionInspection> {
  const found = await lookupSession(sessionId, home);
  if (found === null) return { kind: "unknown" };
  const current = found.currentAlias;
  const currentSessionId = current?.startsWith(`${ALIAS_HOST}:`) ? current.slice(ALIAS_HOST.length + 1) : sessionId;
  return { kind: "managed", threadId: found.threadId, currentSessionId };
}

export async function currentSession(sessionId: string, home: string): Promise<string | null> {
  const found = await inspectSession(sessionId, home);
  return found.kind === "managed" ? found.currentSessionId : null;
}
