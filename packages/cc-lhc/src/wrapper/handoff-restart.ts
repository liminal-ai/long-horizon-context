/**
 * LIM-80 Slice 3B2: pure restart decision core for the ORDERED input-journal chain.
 *
 * A restart-continued handoff no longer inspects a single journal: it walks the
 * whole chain — the original 3B1 journal FIRST, then every respawn-prepared
 * generation journal in append order (findings 3/8). This module owns the pure
 * aggregation from per-segment read results to one chain-level disposition:
 *
 *  - `repairable`  a segment is unreadable / binding-or-ancestry mismatch / a legacy
 *                  row without an origin attempt id — never trusted, stays open. The
 *                  failing segment is identified (finding 5).
 *  - `blocked`     a segment is `delivering` — the send ambiguity; NEVER auto-replay.
 *                  The exact delivering segment is identified (finding 5).
 *  - `deliver`     no ambiguity and some pending bytes remain to deliver in chain order.
 *  - `settled`     no ambiguity and nothing pending — every byte is already delivered.
 *  - `empty`       there are no journal segments at all (a post-commit attempt with no
 *                  journal: bytes can never be inferred absent — the caller stays open).
 *
 * Byte accounting (finding 8) carries the sum of ALREADY-delivered bytes; the caller
 * adds newly-delivered bytes and reports the total in the terminal outcome. Pure:
 * no I/O, no process state. The caller reads the segments and applies the decision.
 */

/** One segment's read result, reduced to the facts the disposition needs. `label`
 * identifies the segment (e.g. its journal path) for operator artifacts. */
export type ChainSegmentState =
  | { ok: true; label: string; state: "pending" | "delivering" | "delivered"; bytes: number }
  | { ok: false; label: string; reason: string };

export type ChainDisposition =
  | { kind: "empty" }
  | { kind: "repairable"; reason: string; segment: string }
  | { kind: "blocked"; deliveredBytes: number; segment: string }
  | { kind: "deliver"; deliveredBytes: number; pendingBytes: number }
  | { kind: "settled"; deliveredBytes: number };

/**
 * Aggregate the ordered per-segment states into one chain disposition. The FIRST
 * unreadable/mismatched segment makes the chain repairable; any `delivering`
 * segment blocks (indeterminate, never auto-replayed) and is identified; otherwise
 * pending bytes are deliverable and everything else is already settled.
 */
export function chainDisposition(segments: readonly ChainSegmentState[]): ChainDisposition {
  if (segments.length === 0) return { kind: "empty" };
  let delivered = 0;
  let pending = 0;
  let blockingSegment: string | null = null;
  for (const s of segments) {
    if (!s.ok) return { kind: "repairable", reason: `${s.label}: ${s.reason}`, segment: s.label };
    if (s.state === "delivering") {
      if (blockingSegment === null) blockingSegment = s.label;
    } else if (s.state === "delivered") delivered += s.bytes;
    else pending += s.bytes;
  }
  if (blockingSegment !== null) return { kind: "blocked", deliveredBytes: delivered, segment: blockingSegment };
  if (pending > 0) return { kind: "deliver", deliveredBytes: delivered, pendingBytes: pending };
  return { kind: "settled", deliveredBytes: delivered };
}
