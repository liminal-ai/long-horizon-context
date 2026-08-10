// Selected-thread label backfill: rewrite stored turn_rendering derivations
// whose content predates stable <tN>/<mN> labels, by re-running the same pure
// composition retrieval's live fallback uses. No inference, no work items, no
// chunk placement, no floor writes, no canonical-record change — the only
// mutation is the turn_rendering row's content and derived_at. Source version
// is unchanged because the sources did not change; only the rendering recipe
// did.

import type { DatabaseSync } from "node:sqlite";

import { composeRenderingInput, composeStructuredTurnText } from "./compose.js";
import { readMemberMessages, readMessageDerivationRows, readTurnDerivationRow } from "./derivations.js";

export interface RenderingLabelBackfillReceipt {
  turnsExamined: number;
  /** Turn ids whose stored rendering was rewritten with labels. */
  relabeled: string[];
  alreadyLabeled: number;
  /** Not-ready/missing renderings are reported, never repaired here. */
  skipped: Array<{ turnId: string; reason: string }>;
  dryRun: boolean;
}

export function backfillRenderingLabelsInOpenDb(
  db: DatabaseSync,
  now: () => Date,
  dryRun: boolean,
): RenderingLabelBackfillReceipt {
  const closedTurns = db
    .prepare(
      `SELECT turn_id FROM turns
       WHERE status = 'closed' AND deleted_at IS NULL ORDER BY turn_order`,
    )
    .all() as unknown as Array<{ turn_id: string }>;

  const receipt: RenderingLabelBackfillReceipt = {
    turnsExamined: closedTurns.length,
    relabeled: [],
    alreadyLabeled: 0,
    skipped: [],
    dryRun,
  };
  const update = db.prepare(
    `UPDATE derivation SET content = ?, derived_at = ?
     WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'
       AND state = 'ready'`,
  );

  for (const { turn_id: turnId } of closedTurns) {
    const row = readTurnDerivationRow(db, "turn", turnId, "turn_rendering");
    if (row === undefined) {
      receipt.skipped.push({ turnId, reason: "rendering_missing" });
      continue;
    }
    if (row.state !== "ready") {
      receipt.skipped.push({ turnId, reason: `rendering_${row.state}` });
      continue;
    }
    // Same predicate retrieval uses to accept a stored rendering: the backfill
    // rewrites exactly the set retrieval would otherwise re-compose per pull.
    const content = row.content ?? "";
    if (content.startsWith(`<${turnId}>\n`) && content.endsWith(`\n</${turnId}>`)) {
      receipt.alreadyLabeled += 1;
      continue;
    }
    const messages = readMemberMessages(db, turnId);
    const derivations = readMessageDerivationRows(
      db,
      messages.map((message) => message.messageId),
    );
    const { parts } = composeRenderingInput(messages, derivations);
    const text = composeStructuredTurnText(parts, turnId);
    if (!dryRun) {
      update.run(text, now().toISOString(), turnId);
    }
    receipt.relabeled.push(turnId);
  }
  return receipt;
}
