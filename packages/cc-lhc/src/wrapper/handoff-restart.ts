/**
 * LIM-80 Slice 3B2: pure restart-handoff decision helpers.
 *
 * On restart, an interrupted handoff attempt (old_child_exited / replacement_ready
 * / lineage_recorded / descriptor_published) is reconciled from durable facts. The
 * governor planner (recovery.ts) already maps stage + observations to an action;
 * these helpers add the two decisions the planner does not own:
 *
 *  1. What to do with the durable input journal (findings 7-8): pending bytes may
 *     be delivered EXACTLY ONCE and only to a proven-live target; `delivering` is
 *     the send ambiguity and is NEVER replayed automatically; `delivered` never
 *     replays; unreadable/mismatch/corrupt is repairable, not terminal; a legacy
 *     attempt with no journal keeps old safe behavior and never infers bytes.
 *  2. Whether a terminal success is allowed (finding 9): only when the rebuilt
 *     child/session is current + capture-ready, the rollout is verified, and the
 *     journal is delivered or has zero pending bytes. A `delivering` journal can
 *     never terminalize as success automatically.
 *
 * Pure: no I/O, no process state. The caller observes and applies.
 */

import type { InputJournalReadResult } from "./input-journal.js";

/**
 * What the restart executor should do with the journal before terminalizing.
 * `bytes`/`byteCount` are metadata only — bytes never enter logs or SQLite.
 */
export type JournalDisposition =
  /** Legacy attempt (no journal artifact): preserve old behavior, never infer bytes. */
  | { kind: "no_journal" }
  /** Journal exists, pending, zero bytes: nothing to deliver; safe to terminalize. */
  | { kind: "no_bytes" }
  /** Pending with bytes: deliver EXACTLY ONCE to a proven-live target, then terminalize. */
  | { kind: "deliver"; byteCount: number }
  /** `delivering`: send ambiguity — NEVER replay; keep open, write an operator artifact. */
  | { kind: "blocked_indeterminate"; byteCount: number }
  /** `delivered`: never replay; continue metadata/terminal reconciliation. */
  | { kind: "delivered" }
  /** unreadable / binding mismatch / corrupt grammar: repairable/open, not terminal. */
  | { kind: "open_repairable"; reason: string };

/**
 * Decide the journal disposition. `read` is `null` when the attempt carries no
 * journal path artifact (legacy). Otherwise it is the strict readInputJournal
 * result (already binding-checked by the caller).
 */
export function planJournalDisposition(read: InputJournalReadResult | null): JournalDisposition {
  if (read === null) return { kind: "no_journal" };
  if (!read.ok) return { kind: "open_repairable", reason: read.reason };
  switch (read.state) {
    case "delivered":
      return { kind: "delivered" };
    case "delivering":
      return { kind: "blocked_indeterminate", byteCount: read.chunks.length };
    default:
      // pending
      return read.chunks.length === 0 ? { kind: "no_bytes" } : { kind: "deliver", byteCount: read.chunks.length };
  }
}

/** Facts a restart terminal decision needs, all observed NOW (never stale claim). */
export interface RestartTerminalFacts {
  /** Current wrapper child's EXACT identity equals the ACTIVE replacement generation. */
  currentChildIsExactActive: boolean;
  /** Current session === rebuiltSessionId, same thread, capture ready (session ownership). */
  rebuiltSessionCurrent: boolean;
  /**
   * A DIFFERENT recorded replacement identity (a prior generation or the original
   * replacementChild) is live or indeterminate. Never terminalize past a live
   * foreign replacement — a second same-session child could exist (finding 1).
   */
  foreignReplacementLiveOrIndeterminate: boolean;
  /** The reserved rebuilt rollout re-verified (whole-file identity/hash) NOW. */
  rolloutVerified: boolean;
  /** Journal disposition from planJournalDisposition. */
  journal: JournalDisposition;
}

export type RestartTerminalDecision =
  /** Deliver the pending journal bytes to the proven-live child, then terminalize success. */
  | { kind: "deliver_then_success" }
  /** No pending bytes (delivered / no_bytes / no_journal): terminalize success directly. */
  | { kind: "success" }
  /** `delivering` ambiguity: never auto-terminalize; keep open + operator artifact. */
  | { kind: "blocked"; reason: string }
  /** Proofs not yet met (child/rollout/journal repairable): leave open with bounded retry. */
  | { kind: "open"; reason: string };

/**
 * Terminal-success gate for a restart-continued handoff (findings 1, 8). Success
 * is allowed ONLY when: no other recorded replacement identity is live/
 * indeterminate; the current session is the rebuilt session on the same thread
 * with capture ready; the current child's EXACT identity is the active replacement
 * generation; the rollout re-verified NOW; and the journal is delivered or has zero
 * pending bytes. `delivering` blocks; a repairable journal leaves it open.
 */
export function planRestartTerminal(f: RestartTerminalFacts): RestartTerminalDecision {
  if (f.foreignReplacementLiveOrIndeterminate) {
    return { kind: "open", reason: "a different recorded replacement identity is live/indeterminate" };
  }
  if (!f.rebuiltSessionCurrent) {
    return { kind: "open", reason: "current session is not the rebuilt session / capture not ready" };
  }
  if (!f.currentChildIsExactActive) {
    return { kind: "open", reason: "current child is not the exact active replacement identity" };
  }
  if (!f.rolloutVerified) {
    return { kind: "open", reason: "rebuilt rollout not re-verified" };
  }
  switch (f.journal.kind) {
    case "blocked_indeterminate":
      return {
        kind: "blocked",
        reason: `input delivery is indeterminate (delivering, ${f.journal.byteCount} byte(s)); never auto-replay`,
      };
    case "open_repairable":
      return { kind: "open", reason: `input journal repairable: ${f.journal.reason}` };
    case "no_journal":
      // A post-commit attempt with NO journal cannot prove its post-commit bytes
      // were absent (finding 6): stay open for operator resolution, never infer.
      return { kind: "open", reason: "no input journal for a post-commit attempt; cannot infer bytes were absent" };
    case "deliver":
      return { kind: "deliver_then_success" };
    default:
      // no_bytes / delivered: nothing to deliver.
      return { kind: "success" };
  }
}
