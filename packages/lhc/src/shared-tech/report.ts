// The report row mapper shared by owner report queries. Each domain owns its
// one-query join and derivation_type→kind mapping; the raw-row →
// DerivationReportEntry mapping is owner-blind and lives here so owners cannot
// drift on how state, metadata, gaps, and queue detail read back.
import type {
  DependencyGap,
  DerivationMetadata,
  DerivationReportEntry,
  DerivationState,
  SubjectKind,
} from "./derivation.js";

export interface RawReportRow {
  subject_id: string;
  derivation_type: string;
  state: string;
  content: string | null;
  reason: string | null;
  metadata: string | null;
  source_version: number | bigint;
  gaps: string | null;
  derived_at: string | null;
  queue_status: string | null;
  queue_attempts: number | bigint | null;
  queue_last_error: string | null;
  queue_eligible_at: string | null;
}

export function reportEntryFromRow(subjectKind: SubjectKind, row: RawReportRow): DerivationReportEntry {
  const entry: DerivationReportEntry = {
    subjectKind,
    subjectId: row.subject_id,
    derivationType: row.derivation_type as string,
    state: row.state as DerivationState,
    sourceVersion: Number(row.source_version),
  };
  if (row.content !== null) entry.content = row.content;
  if (row.reason !== null) entry.reason = row.reason;
  if (row.metadata !== null) {
    entry.metadata = JSON.parse(row.metadata) as DerivationMetadata;
  }
  if (row.gaps !== null) entry.gaps = JSON.parse(row.gaps) as DependencyGap[];
  if (row.derived_at !== null) entry.derivedAt = row.derived_at;
  if (row.queue_status !== null) {
    entry.queue = {
      status: row.queue_status as "queued" | "claimed",
      attempts: Number(row.queue_attempts ?? 0),
    };
    if (row.queue_last_error !== null) entry.queue.lastError = row.queue_last_error;
    if (row.queue_eligible_at !== null) entry.queue.eligibleAt = row.queue_eligible_at;
  }
  return entry;
}
