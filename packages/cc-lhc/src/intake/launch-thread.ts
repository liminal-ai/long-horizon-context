/**
 * The thread a launch takes ownership of, and the session it lands on.
 *
 * R15's launch flow, in order:
 *   alias → registry resolve → thread id → THREAD-keyed owner lock →
 *   re-read current(threadId) under the lock → land on that session.
 *
 * The pre-lock resolve authorizes the lock key and nothing else. Between it
 * and the lock, the wrapper that held the thread can accept a swap and move
 * the current pointer, so the pointer is always read again under the lock.
 */

import { type ExpectedSession, expectedSessionFromExplicitId } from "../rollout/expected-session.js";
import { acquireThreadOwner, type ThreadOwnerLease } from "../runtime/thread-owner.js";
import type { LineageDbDeps } from "./lineage-db.js";
import {
  bindLaunchThread,
  claudeSessionIdFromAlias,
  currentSessionAlias,
  type UnacceptedSwapArtifact,
  unacceptedSwapArtifacts,
} from "./thread-alias.js";

export interface OpenLaunchThreadInput {
  /** The session this launch asked for; may be any alias of the thread. */
  expectedSession: ExpectedSession;
  registryPath: string;
  lineageDbPath: string;
  /** cc-lhc state root holding the owners directory. */
  home?: string;
  lineageDeps?: LineageDbDeps;
  createThread: () => Promise<string>;
  log?: (message: string) => void;
}

export interface OpenLaunchThread {
  threadId: string;
  /** True when this launch brought the thread into being. */
  createdAtLaunch: boolean;
  lease: ThreadOwnerLease;
  /** The session to actually run — the thread's current one when it has one. */
  expectedSession: ExpectedSession;
  /** Set when the launch alias was an older session of this thread. */
  correctedFrom?: string;
  /** Rebuilt sessions reserved by an interrupted swap and never accepted. */
  discardedSwapArtifacts: UnacceptedSwapArtifact[];
}

export async function openLaunchThread(input: OpenLaunchThreadInput): Promise<OpenLaunchThread> {
  const log = input.log ?? (() => {});

  const bound = await bindLaunchThread({
    sessionId: input.expectedSession.sessionId,
    registryPath: input.registryPath,
    lineageDbPath: input.lineageDbPath,
    ...(input.lineageDeps === undefined ? {} : { lineageDeps: input.lineageDeps }),
    log,
    createThread: input.createThread,
  });

  const lease = acquireThreadOwner(bound.threadId, input.home === undefined ? {} : { home: input.home });
  log(`cc-lhc owns thread ${bound.threadId} (lease ${lease.path})`);

  const currentAlias = await currentSessionAlias(bound.threadId, input.registryPath);
  const currentSessionId = currentAlias === null ? null : claudeSessionIdFromAlias(currentAlias);

  let expectedSession = input.expectedSession;
  let correctedFrom: string | undefined;
  if (currentSessionId !== null && currentSessionId !== input.expectedSession.sessionId) {
    // An older alias of this thread. Not an error — it resolves forward.
    correctedFrom = input.expectedSession.sessionId;
    expectedSession = expectedSessionFromExplicitId(currentSessionId, "current_alias");
    log(
      `cc-lhc: ${correctedFrom} is an older alias of thread ${bound.threadId}; ` +
        `landing on its current session ${currentSessionId}`,
    );
  } else if (currentAlias !== null && currentSessionId === null) {
    log(
      `cc-lhc: thread ${bound.threadId} currently belongs to another host (${currentAlias}); ` +
        `continuing on ${input.expectedSession.sessionId}`,
    );
  }

  const discardedSwapArtifacts = unacceptedSwapArtifacts({
    threadId: bound.threadId,
    currentAlias,
    lineageDbPath: input.lineageDbPath,
    ...(input.lineageDeps === undefined ? {} : { lineageDeps: input.lineageDeps }),
  });
  for (const artifact of discardedSwapArtifacts) {
    log(
      `cc-lhc: rebuilt session ${artifact.sessionId} (reserved ${artifact.updatedAt}) was never accepted ` +
        `for thread ${bound.threadId}; discarded from launch selection`,
    );
  }

  return {
    threadId: bound.threadId,
    createdAtLaunch: bound.createdAtLaunch,
    lease,
    expectedSession,
    ...(correctedFrom === undefined ? {} : { correctedFrom }),
    discardedSwapArtifacts,
  };
}
