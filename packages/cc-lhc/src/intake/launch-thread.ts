/**
 * The thread a launch takes ownership of, and the session it lands on.
 *
 * R15's launch flow, in order:
 *   alias → registry resolve → thread id → THREAD-keyed owner lock →
 *   re-read current(threadId) under the lock → land on that session.
 *
 * The pre-lock resolve authorizes the lock key and nothing else. Between it
 * and the lock, the wrapper that held the thread can accept a swap and move
 * the current pointer, so the pointer is always read again under the lock —
 * after any acceptance the previous owner recorded but could not write into
 * the registry has been reconciled there.
 *
 * The lease is this wrapper's claim on the thread from the moment it is taken.
 * Everything after that runs inside it, so any failure releases it rather than
 * stranding the thread behind a dead owner's lock.
 */

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
  /** Truthful line when a recorded acceptance could not reach the registry. */
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

  const lease = acquireThreadOwner(bound.threadId, input.home === undefined ? {} : { home: input.home });
  log(`cc-lhc owns thread ${bound.threadId} (lease ${lease.path})`);

  try {
    const currentAlias = await currentSessionAlias(bound.threadId, input.registryPath);
    const registryCurrentSessionId = currentAlias === null ? null : claudeSessionIdFromAlias(currentAlias);

    // A swap the previous lifetime observed accepted but could not write into
    // the registry is reconciled here, against the pointer just read under this
    // lock and before any session is chosen — otherwise the pointer would still
    // name the superseded session and the live replacement would read as an
    // unaccepted artifact. It repairs only the predecessor it observed, so a
    // pointer that moved on since is never dragged backwards.
    const pending = await reconcilePendingAcceptance({
      threadId: bound.threadId,
      registryCurrentSessionId,
      registryPath: input.registryPath,
      lineageDbPath: input.lineageDbPath,
      ...(input.lineageDeps === undefined ? {} : { lineageDeps: input.lineageDeps }),
      log,
    });
    // An acceptance this host recorded outranks a pointer that has not caught
    // up to it; once reconciliation advanced the registry the two agree.
    const currentSessionId = pending.acceptedSessionId ?? registryCurrentSessionId;

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
    // The lease is only ever handed to a caller that can release it. Anything
    // that fails before the return gives it back here, so a thread is never
    // left owned by a launch that never started.
    lease.release();
    throw cause;
  }
}
