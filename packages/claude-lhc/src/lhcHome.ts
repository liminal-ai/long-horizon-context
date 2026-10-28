import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type ThreadRef, threads } from "lhc";
import { createSummaryWorkerModelCall, summaryWorkerAssignments } from "./summaryWorker.js";

export const ALIAS_HOST = "t3code-lhc";

export function lhcHome(): string {
  const override = process.env.T3CODE_LHC_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(homedir(), ".t3code-lhc");
}

export function registryPath(home = lhcHome()): string {
  mkdirSync(home, { recursive: true });
  return join(home, "registry.sqlite");
}

export function newThreadFilePath(home = lhcHome()): string {
  const dir = join(home, "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

export function sessionAlias(sessionId: string): string {
  return `${ALIAS_HOST}:${sessionId}`;
}

export function threadRef(threadId: string, home = lhcHome()): ThreadRef {
  return { threadId, registryPath: registryPath(home) };
}

export interface LhcInstanceOptions {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  tokenFamily: string;
}

export function createLhc(options: LhcInstanceOptions): Lhc {
  if (process.env.T3CODE_LHC_NO_INFERENCE === "1") {
    return initLhc({
      mode: "background",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      tokenFamily: options.tokenFamily,
    });
  }
  return initLhc({
    mode: "background",
    inference: {
      call: createSummaryWorkerModelCall({ claudeBin: options.claudeBin, env: options.env }),
      assignments: summaryWorkerAssignments(),
      timeoutMs: 90_000,
    },
    tokenFamily: options.tokenFamily,
  });
}

export async function createThread(cwd: string, home = lhcHome()): Promise<string> {
  const created = await threads.newThread({
    filePath: newThreadFilePath(home),
    cwd,
    title: basename(cwd) || cwd,
    registryPath: registryPath(home),
  });
  if (!created.ok) throw new Error(`LHC thread creation failed: ${created.error.reason}`);
  return created.value.threadId;
}

export async function bindSession(threadId: string, sessionId: string, home = lhcHome()): Promise<void> {
  const bound = await threads.registerCurrentAlias({
    alias: sessionAlias(sessionId),
    threadId,
    registryPath: registryPath(home),
  });
  if (!bound.ok) throw new Error(`LHC alias registration failed: ${bound.error.reason}`);
}

export async function resolveSession(sessionId: string, home = lhcHome()): Promise<string | null> {
  const resolved = await threads.resolveAlias({ alias: sessionAlias(sessionId), registryPath: registryPath(home) });
  if (resolved.ok) return resolved.value.threadId;
  if (resolved.error.code === "alias_not_found") return null;
  throw new Error(`LHC registry read failed: ${resolved.error.reason}`);
}
