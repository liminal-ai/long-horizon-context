/**
 * Where this host keeps its LHC state, and how the SDK instance is built.
 *
 * Host name: `t3code-lhc`. Home: `~/.t3code-lhc` (override `T3CODE_LHC_HOME`) holding
 * `registry.sqlite` and `threads/<uuid>.sqlite`. Aliases are host-qualified as
 * `t3code-lhc:<claude session id>`; every native Claude session id this sidecar has
 * run for a thread is an alias of that thread, and the latest is current.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, threads, type ThreadRef } from "lhc";
import { createClaudeCliModelCall, inferenceAssignments } from "./inference/claudeCli.ts";

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
  /** Claude executable used for `claude -p` derivation calls. */
  claudeBin: string;
  env: NodeJS.ProcessEnv;
}

/** Background mode so derivations drain while the thread idles; `T3CODE_LHC_NO_INFERENCE=1` swaps in deterministic callbacks. */
export function createLhc(options: LhcInstanceOptions): Lhc {
  if (process.env.T3CODE_LHC_NO_INFERENCE === "1") {
    return initLhc({ mode: "background", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  }
  return initLhc({
    mode: "background",
    inference: {
      call: createClaudeCliModelCall({ binary: options.claudeBin, env: options.env }),
      assignments: inferenceAssignments(),
      timeoutMs: 90_000,
    },
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

/** Binds a native session id to a thread and makes it the thread's current alias. */
export async function bindSession(threadId: string, sessionId: string, home = lhcHome()): Promise<void> {
  const bound = await threads.registerCurrentAlias({
    alias: sessionAlias(sessionId),
    threadId,
    registryPath: registryPath(home),
  });
  if (!bound.ok) throw new Error(`LHC alias registration failed: ${bound.error.reason}`);
}

/** The thread a native session id belongs to, or null when no thread has held it. */
export async function resolveSession(sessionId: string, home = lhcHome()): Promise<string | null> {
  const resolved = await threads.resolveAlias({ alias: sessionAlias(sessionId), registryPath: registryPath(home) });
  if (resolved.ok) return resolved.value.threadId;
  if (resolved.error.code === "alias_not_found") return null;
  throw new Error(`LHC registry read failed: ${resolved.error.reason}`);
}
