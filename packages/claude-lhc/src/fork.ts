import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  type ForkSessionOptions,
  type ForkSessionResult,
  getSessionInfo,
  renameSession,
} from "@anthropic-ai/claude-agent-sdk";
import { threads } from "lhc";
import {
  bindSession,
  createLhc,
  currentSession,
  newThreadFilePath,
  registryPath,
  resolveSession,
  threadRef,
} from "./lhcHome.js";
import { nativeSessionPath, writeProjectedSession } from "./nativeSessionFile.js";
import { FALLBACK_CLAUDE_CODE_VERSION, FALLBACK_PROJECTION_MODEL, projectView } from "./projection/project.js";
import { type LhcStore, type OperationEnv, parseSidecarOptions } from "./protocol.js";
import { appendRollback, resolveRollbackAnchor } from "./rollbackAnchor.js";
import { seedTokenFamilyFromStartModel } from "./token-family.js";

export async function forkSession(
  sessionId: string,
  options: ForkSessionOptions & LhcStore & OperationEnv,
): Promise<ForkSessionResult & { headMessageId?: string }> {
  const { home } = parseSidecarOptions(options.lhc);
  const sourceId = await resolveSession(sessionId, home);
  if (sourceId === null) throw new Error(`no LHC thread holds the Claude session ${sessionId}`);
  const source = threadRef(sourceId, home);
  const sourceCwd = (await threadCwd(sourceId, home)) ?? options.dir;
  if (sourceCwd === undefined) throw new Error(`LHC thread ${sourceId} has no cwd; pass dir`);
  const cwd = options.dir ?? sourceCwd;
  const env = options.env ?? process.env;
  const lhc = createLhc({
    mode: "manual",
    claudeBin: options.pathToClaudeCodeExecutable ?? "claude",
    env,
    tokenFamily: seedTokenFamilyFromStartModel(undefined).family,
  });

  const upTo = options.upToMessageId;
  const anchor =
    upTo === undefined
      ? null
      : await resolveRollbackAnchor({ lhc, thread: source, anchor: upTo, sessionId, cwd: sourceCwd, env });
  if (upTo !== undefined && anchor === null) throw new Error(`rollback anchor ${upTo} not found`);
  const title = options.title?.trim() ? options.title : await forkTitle(sessionId, home, sourceCwd);

  const copied = await threads.copyThread({
    source,
    filePath: newThreadFilePath(home),
    registryPath: registryPath(home),
    cwd,
    ...(options.title !== undefined ? { title: options.title } : {}),
  });
  if (!copied.ok) throw new Error(`LHC thread copy failed: ${copied.error.code}: ${copied.error.reason}`);
  const forkId = copied.value.threadId;
  const forkSessionId = randomUUID();
  try {
    const fork = threadRef(forkId, home);
    if (anchor !== null) await appendRollback(lhc, fork, anchor, `fork upToMessageId ${anchor.anchor}`);
    const drained = await lhc.work.drain(fork);
    if (!drained.ok) throw new Error(`LHC derivation drain failed: ${drained.error.reason}`);

    const view = await lhc.threadView.getSessionThreadView(fork);
    if (!view.ok) throw new Error(`LHC view read failed: ${view.error.reason}`);
    const entries = projectView(view.value, {
      sessionId: forkSessionId,
      cwd,
      version: FALLBACK_CLAUDE_CODE_VERSION,
      permissionMode: "default",
      model: FALLBACK_PROJECTION_MODEL,
    });
    if (entries.length > 0) {
      await writeProjectedSession({ sessionId: forkSessionId, cwd, entries, env });
      await renameSession(forkSessionId, title, { dir: cwd });
    }
    await bindSession(forkId, forkSessionId, home);
    const head = entries.at(-1)?.["uuid"];
    return typeof head === "string" ? { sessionId: forkSessionId, headMessageId: head } : { sessionId: forkSessionId };
  } catch (cause) {
    await threads.discardCopy({ threadId: forkId, registryPath: registryPath(home) });
    await rm(nativeSessionPath({ sessionId: forkSessionId, cwd, env }), { force: true });
    throw cause;
  }
}

async function forkTitle(sessionId: string, home: string, dir: string): Promise<string> {
  const current = (await currentSession(sessionId, home)) ?? sessionId;
  const info = await getSessionInfo(current, { dir });
  return `${info?.summary ?? "Forked session"} (fork)`;
}

async function threadCwd(threadId: string, home: string): Promise<string | undefined> {
  const info = await threads.resolve({ threadId, registryPath: registryPath(home) });
  if (!info.ok) throw new Error(`LHC registry read failed: ${info.error.reason}`);
  return info.value.cwd;
}
