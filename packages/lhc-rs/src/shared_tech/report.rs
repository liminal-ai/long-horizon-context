//! Ported from packages/lhc/src/shared-tech/report.ts.
//!
//! The report row mapper shared by owner report queries. Each domain owns its
//! one-query join and derivation_type→kind mapping; the raw-row →
//! DerivationReportEntry mapping is owner-blind and lives here so owners cannot
//! drift on how state, metadata, gaps, and queue detail read back.

use super::derivation::{
    DependencyGap, DerivationMetadata, DerivationReportEntry, DerivationReportQueue,
    DerivationState, QueueStatus, SubjectKind,
};

#[derive(Debug, Clone, PartialEq)]
pub struct RawReportRow {
    pub subject_id: String,
    pub derivation_type: String,
    pub state: String,
    pub content: Option<String>,
    pub reason: Option<String>,
    pub metadata: Option<String>,
    /// TS: number | bigint — already coerced at the call site.
    pub source_version: i64,
    pub gaps: Option<String>,
    pub derived_at: Option<String>,
    pub queue_status: Option<String>,
}

fn parse_derivation_state(state: &str) -> DerivationState {
    match state {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("unknown derivation state from report row: {other}"),
    }
}

fn parse_queue_status(status: &str) -> QueueStatus {
    match status {
        "queued" => QueueStatus::Queued,
        "claimed" => QueueStatus::Claimed,
        other => panic!("unknown queue status from report row: {other}"),
    }
}

pub fn report_entry_from_row(
    subject_kind: SubjectKind,
    row: &RawReportRow,
) -> DerivationReportEntry {
    let mut entry = DerivationReportEntry {
        subject_kind,
        subject_id: row.subject_id.clone(),
        derivation_type: row.derivation_type.clone(),
        state: parse_derivation_state(&row.state),
        content: None,
        reason: None,
        source_version: row.source_version,
        gaps: None,
        metadata: None,
        derived_at: None,
        queue: None,
    };
    if let Some(content) = &row.content {
        entry.content = Some(content.clone());
    }
    if let Some(reason) = &row.reason {
        entry.reason = Some(reason.clone());
    }
    if let Some(metadata) = &row.metadata {
        entry.metadata = Some(
            serde_json::from_str::<DerivationMetadata>(metadata).expect("derivation metadata JSON"),
        );
    }
    if let Some(gaps) = &row.gaps {
        entry.gaps =
            Some(serde_json::from_str::<Vec<DependencyGap>>(gaps).expect("dependency gaps JSON"));
    }
    if let Some(derived_at) = &row.derived_at {
        entry.derived_at = Some(derived_at.clone());
    }
    if let Some(queue_status) = &row.queue_status {
        entry.queue = Some(DerivationReportQueue {
            status: parse_queue_status(queue_status),
        });
    }
    entry
}
