import {
  type GetSessionMessagesOptions,
  type GetSubagentMessagesOptions,
  getSessionMessages as readSessionMessages,
  getSubagentMessages as readSubagentMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { currentSession, resolveSession } from "./lhcHome.js";
import { nativeAgentSessions } from "./nativeSessionFile.js";
import { type LhcStore, type OperationEnv, parseSidecarOptions } from "./protocol.js";

export async function getSessionMessages(
  sessionId: string,
  options: GetSessionMessagesOptions & LhcStore & OperationEnv,
): Promise<SessionMessage[]> {
  const { lhc, env: _env, pathToClaudeCodeExecutable: _bin, ...read } = options;
  const current = await currentSession(sessionId, parseSidecarOptions(lhc).home);
  return readSessionMessages(current ?? sessionId, read);
}

export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options: GetSubagentMessagesOptions & LhcStore & OperationEnv,
): Promise<SessionMessage[]> {
  const { lhc, env, pathToClaudeCodeExecutable: _bin, ...read } = options;
  const { home } = parseSidecarOptions(lhc);
  const threadId = await resolveSession(sessionId, home);
  if (threadId === null) return readSubagentMessages(sessionId, agentId, read);
  for (const holder of await nativeAgentSessions(agentId, env)) {
    if ((await resolveSession(holder, home)) === threadId) return readSubagentMessages(holder, agentId, read);
  }
  return [];
}
