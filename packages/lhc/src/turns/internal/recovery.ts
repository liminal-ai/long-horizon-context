import type { DatabaseSync } from "node:sqlite";
import type {
  DerivationMetadata,
  SubjectKind,
} from "../../shared-tech/index.js";
import { hasLiveItem, type WorkKind, type WorkSourceRef } from "../../shared-tech/work-queue/index.js";

function workTargetFor(
  subjectKind: SubjectKind,
  subjectId: string,
  derivationType: string,
): { kind: WorkKind; sourceRef: WorkSourceRef } | undefined {
  if (subjectKind === "message") {
    if (derivationType === "smoothed_prompt") {
      return { kind: "prompt_smoothing", sourceRef: { messageId: subjectId } };
    }
    if (derivationType === "tool_result_summary") {
      return { kind: "tool_result_summary", sourceRef: { messageId: subjectId } };
    }
  }
  if (subjectKind === "turn") {
    if (derivationType === "turn_rendering" || derivationType === "smooth_turn_compression") {
      return { kind: "turn_derivation", sourceRef: { turnId: subjectId } };
    }
  }
  if (
    subjectKind === "chunk" &&
    (derivationType === "chunk_summary_detailed" || derivationType === "chunk_summary_brief")
  ) {
    return { kind: derivationType, sourceRef: { chunkId: subjectId } };
  }
  return undefined;
}

export function hasLiveRecoveryWork(
  db: DatabaseSync,
  r: {
    subjectKind: SubjectKind;
    subjectId: string;
    derivationType: string;
    sourceVersion: number;
  },
): boolean {
  const target = workTargetFor(r.subjectKind, r.subjectId, r.derivationType);
  return target !== undefined && hasLiveItem(db, target.kind, target.sourceRef, r.sourceVersion);
}

export function recoverDerivation(
  db: DatabaseSync,
  r: {
    subjectKind: SubjectKind;
    subjectId: string;
    derivationType: string;
    content: string;
    metadata?: DerivationMetadata;
    sourceVersion: number;
    derivedAt: string;
  },
): { persisted: boolean } {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (hasLiveRecoveryWork(db, r)) {
      db.exec("COMMIT;");
      return { persisted: false };
    }
    const changed = db
      .prepare(
        `UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = ?,
             gaps = NULL, derived_at = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?
           AND source_version = ?
           AND state IN ('pending', 'failed')`,
      )
      .run(
        r.content,
        r.metadata === undefined ? null : JSON.stringify(r.metadata),
        r.derivedAt,
        r.subjectKind,
        r.subjectId,
        r.derivationType,
        r.sourceVersion,
      );
    db.exec("COMMIT;");
    return { persisted: Number(changed.changes) > 0 };
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}
