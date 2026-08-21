// Turn/chunk shaping shared by both execution plans. Structure is bounded by
// turn and chunk counts, so both plans read it the same way and the walk sees
// the same placeable set either way: a tombstoned turn is a legitimate
// reference target, not damage, and a record the walk cannot place is skipped
// and reported, never refused.
//
// Skip order is part of the shape: orphaned messages are reported before
// dangling chunk members, matching the order the record is read in.
import type { SkippedRecord } from "../../shared-tech/index.js";
import type * as turnsDomain from "../../turns/index.js";
import type { SelectionChunk, SelectionTurn } from "./select.js";

export interface ShapedTurns {
  turns: SelectionTurn[];
  /** Every turn row, tombstoned included — the referential universe. */
  turnIds: Set<string>;
  liveTurnIds: Set<string>;
}

export function shapeTurns(structure: turnsDomain.TurnChunkStructure): ShapedTurns {
  // A tombstoned turn is a legitimate reference target, not damage; the
  // selection walk itself sees live turns only.
  const turnIds = new Set(structure.turns.map((row) => row.turnId));
  const turns: SelectionTurn[] = structure.turns
    .filter((row) => !row.deleted)
    .map((row) => ({
      turnId: row.turnId,
      turnOrder: row.turnOrder,
      status: row.status,
      openedAt: row.openedAtEventOrder,
      closedAt: row.closedAtEventOrder,
    }));
  return { turns, turnIds, liveTurnIds: new Set(turns.map((turn) => turn.turnId)) };
}

export interface ShapedChunks {
  chunks: SelectionChunk[];
  /** Derived chunks whose stored members are all legitimate tombstoned turns. */
  emptyChunkIds: string[];
}

/** Appends its dangling-member findings to `skippedRecords` in chunk order. */
export function shapeChunks(
  structure: turnsDomain.TurnChunkStructure,
  shaped: ShapedTurns,
  skippedRecords: SkippedRecord[],
): ShapedChunks {
  const emptyChunkIds: string[] = [];
  const chunks: SelectionChunk[] = structure.chunks.flatMap((row) => {
    const memberTurnIds: string[] = [];
    let dangling = false;
    for (const memberTurnId of row.memberTurnIds) {
      if (!shaped.turnIds.has(memberTurnId)) {
        dangling = true;
        skippedRecords.push({
          kind: "dangling_chunk_member",
          chunkId: row.chunkId,
          turnId: memberTurnId,
          reason: `chunk ${row.chunkId} has a member pointing at turn ${memberTurnId}, which has no turn row`,
        });
        continue;
      }
      memberTurnIds.push(memberTurnId);
    }
    if (!memberTurnIds.some((turnId) => shaped.liveTurnIds.has(turnId))) {
      // The empty-chunk drop is for chunks whose members are all legitimate
      // tombstoned turns. A chunk carrying a dangling member is left on disk
      // untouched — skipped from selection, never removed.
      if (!dangling) emptyChunkIds.push(row.chunkId);
      return [];
    }
    return [
      {
        chunkId: row.chunkId,
        chunkOrder: row.chunkOrder,
        status: row.status,
        memberTurnIds,
      },
    ];
  });
  return { chunks, emptyChunkIds };
}

export function orphanedMessageSkip(messageId: string, turnId: string): SkippedRecord {
  return {
    kind: "orphaned_message",
    messageId,
    turnId,
    reason: `message ${messageId} points at turn ${turnId}, which is not a live turn`,
  };
}
