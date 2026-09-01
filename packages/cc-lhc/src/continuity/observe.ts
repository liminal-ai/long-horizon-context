/**
 * Evidence into the parent-owned store (LIM-145 AC-2.1).
 *
 * The rollout fold in `observation/async-work.ts` already decides what a line
 * means — a launch acknowledgement, progress, or matching terminal evidence.
 * This module follows that decision into SQLite so the parent holds one
 * durable record per launch across child replacements. It is not a second
 * fold: the fold emits, the store records.
 *
 * Labels are sanitized here, once: family noun, a bounded description for
 * non-shell families, and the task id. A background command's body, progress
 * text, environment, and output never reach the database.
 */

import {
  type AsyncWorkEvent,
  type AsyncWorkFamily,
  type AsyncWorkFold,
  type AsyncWorkTerminalOutcome,
  asyncWorkIdentity,
  createAsyncWorkFold,
  type OpenAsyncWork,
  observeAsyncWorkLine,
} from "../observation/async-work.js";
import type { RolloutLineItem } from "../rollout/types.js";
import type { ContinuityStore, TerminalOutcome } from "./store.js";

const FAMILY_NOUN: Record<AsyncWorkFamily, string> = {
  agent: "background agent",
  workflow: "workflow",
  background_shell: "background command",
  monitor: "monitor",
  scheduled_wakeup: "scheduled wakeup",
};

const MAX_LABEL_DESCRIPTION_CHARS = 64;
const MAX_LABEL_ID_CHARS = 32;

function plainAscii(text: string, maxChars: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  const ascii = [...flattened].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  return ascii.length <= maxChars ? ascii : `${ascii.slice(0, maxChars - 3)}...`;
}

/** Durable, sanitized label for one launch. Shell commands contribute only their family and id. */
export function continuityLabel(work: OpenAsyncWork): string {
  const parts = [FAMILY_NOUN[work.family]];
  if (work.family !== "background_shell" && work.description !== undefined && work.description !== "") {
    parts.push(`"${plainAscii(work.description, MAX_LABEL_DESCRIPTION_CHARS)}"`);
  }
  if (work.family !== "scheduled_wakeup") {
    const id = work.taskId !== undefined && work.taskId !== "" ? work.taskId : work.key;
    if (id !== "") parts.push(`(${plainAscii(id, MAX_LABEL_ID_CHARS)})`);
  }
  return parts.join(" ");
}

function terminalOutcome(outcome: AsyncWorkTerminalOutcome): TerminalOutcome {
  return outcome;
}

/** Record one accepted piece of fold evidence for the thread. */
export function applyAsyncWorkEvent(
  store: ContinuityStore,
  threadId: string,
  event: AsyncWorkEvent,
  nowMs: number,
): void {
  const launchId = asyncWorkIdentity(event.work);
  switch (event.kind) {
    case "launched":
      store.recordLaunch({
        threadId,
        launchId,
        family: event.work.family,
        label: continuityLabel(event.work),
        ...(event.work.taskId === undefined ? {} : { taskId: event.work.taskId }),
        ...(event.work.toolUseId === undefined ? {} : { toolUseId: event.work.toolUseId }),
        ...(event.work.scheduledForMs === undefined ? {} : { scheduledForMs: event.work.scheduledForMs }),
        ...(event.work.continuation === undefined ? {} : { continuation: event.work.continuation }),
        nowMs,
      });
      return;
    case "progress":
      store.recordProgress({
        threadId,
        launchId,
        ...(event.work.continuation === undefined ? {} : { continuation: event.work.continuation }),
        nowMs,
      });
      return;
    case "terminal":
      store.recordTerminal({
        threadId,
        launchId,
        outcome: terminalOutcome(event.outcome),
        evidence: event.evidence,
        nowMs,
      });
      return;
  }
}

export interface ContinuityObserver {
  /** The live fold, for the open-set readers that already exist. */
  readonly fold: AsyncWorkFold;
  /** Fold one rollout line; every accepted piece of evidence lands in the store. */
  observeLine(item: RolloutLineItem): void;
}

/** A fold whose evidence is recorded in the parent-owned store as it is read. */
export function createContinuityObserver(input: {
  store: ContinuityStore;
  threadId: string;
  nowFn?: () => number;
}): ContinuityObserver {
  const nowFn = input.nowFn ?? Date.now;
  const fold = createAsyncWorkFold((event) => applyAsyncWorkEvent(input.store, input.threadId, event, nowFn()));
  return {
    fold,
    observeLine(item) {
      observeAsyncWorkLine(item, fold);
    },
  };
}
