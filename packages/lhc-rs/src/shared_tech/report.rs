//! Ported from packages/lhc/src/shared-tech/report.ts. Phase 1 skeleton.
//!
//! The report row mapper shared by owner report queries. Each domain owns its
//! one-query join and derivation_type→kind mapping; the raw-row →
//! DerivationReportEntry mapping is owner-blind and lives here so owners cannot
//! drift on how state, metadata, gaps, and queue detail read back.

use super::derivation::{DerivationReportEntry, SubjectKind};

#[derive(Debug, Clone, PartialEq)]
pub struct RawReportRow {
    pub subject_id: String,
    pub derivation_type: String,
    pub state: String,
    pub content: Option<String>,
    pub reason: Option<String>,
    pub metadata: Option<String>,
    /// TS: number | bigint — coerce in Phase 2
    pub source_version: i64,
    pub gaps: Option<String>,
    pub derived_at: Option<String>,
    pub queue_status: Option<String>,
}

pub fn report_entry_from_row(
    _subject_kind: SubjectKind,
    _row: &RawReportRow,
) -> DerivationReportEntry {
    todo!("phase 2")
}
