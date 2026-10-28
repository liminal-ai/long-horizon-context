import { type ExpectedSession, expectedSessionFromExplicitId } from "../rollout/expected-session.js";
import { acquireThreadOwner, type ThreadOwnerLease } from "../runtime/thread-owner.js";
import type { LineageDbDeps } from "./lineage-db.js";
import {
  bindLaunchThread,
  claudeSessionIdFromAlias,
  currentSessionAlias,
  reconcilePendingAcceptance,
  type UnacceptedSwapArtifact,
  unacceptedSwapArtifacts,
} from "./thread-alias.js";

export interface OpenLaunchThreadInput {
  expectedSession: ExpectedSession;
  registryPath: string;
  lineageDbPath: string;
  home?: string;
  lineageDeps?: LineageDbDeps;
  createThread: () => Promise<string>;
  log?: (message: string) => void;
}

export interface OpenLaunchThread {
  threadId: string;
  createdAtLaunch: boolean;
  lease: ThreadOwnerLease;
  expectedSession: ExpectedSession;
  correctedFrom?: string;
  discardedSwapArtifacts: UnacceptedSwapArtifact[];
  pendingAcceptanceNote?: string;
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

  const lease = acquireThreadOwner(bound.threadId, {
    ...(input.home === undefined ? {} : { home: input.home }),
    onReclaim: (reclaimed) =>
      log(
        `cc-lhc: reclaimed thread-owner lease for thread ${reclaimed.threadId} from dead owner ` +
          `pid ${reclaimed.deadPid} (${reclaimed.reason}); lease ${reclaimed.leasePath}`,
      ),
  });
  log(`cc-lhc owns thread ${bound.threadId} (lease ${lease.path})`);

  try {
    const currentAlias = await currentSessionAlias(bound.threadId, input.registryPath);
    const registryCurrentSessionId = currentAlias === null ? null : claudeSessionIdFromAlias(currentAlias);

    const pending = await reconcilePendingAcceptance({
      threadId: bound.threadId,
      registryCurrentSessionId,
      registryPath: input.registryPath,
      lineageDbPath: input.lineageDbPath,
      ...(input.lineageDeps === undefined ? {} : { lineageDeps: input.lineageDeps }),
      log,
    });
    const currentSessionId = pending.acceptedSessionId ?? registryCurrentSessionId;

    let expectedSession = input.expectedSession;
    let correctedFrom: string | undefined;
    if (currentSessionId !== null && currentSessionId !== input.expectedSession.sessionId) {
      correctedFrom = input.expectedSession.sessionId;
      expectedSession = expectedSessionFromExplicitId(currentSessionId, "current_alias");
      log(
        `cc-lhc: ${correctedFrom} is an older alias of thread ${bound.threadId}; ` +
          `landing on its current session ${currentSessionId}`,
      );
    } else if (currentAlias !== null && registryCurrentSessionId === null && pending.acceptedSessionId === null) {
      log(
        `cc-lhc: thread ${bound.threadId} currently belongs to another host (${currentAlias}); ` +
          `continuing on ${input.expectedSession.sessionId}`,
      );
    }

    const discardedSwapArtifacts = unacceptedSwapArtifacts({
      threadId: bound.threadId,
      currentSessionId,
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
      ...(pending.note === undefined ? {} : { pendingAcceptanceNote: pending.note }),
    };
  } catch (cause) {
    lease.release();
    throw cause;
  }
}
