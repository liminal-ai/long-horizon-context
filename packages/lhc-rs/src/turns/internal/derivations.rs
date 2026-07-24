//! Ported from packages/lhc/src/turns/internal/derivations.ts. Phase 1 skeleton.
//!
//! Turn-domain derivation reads. SQL literals REAL (private — TS module-local);
//! bodies exact `todo!("phase 2")`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::{
    Derivation, DerivationReportEntry, DerivationState, SubjectKind,
};
use crate::shared_tech::storage::Db;
use crate::turns::ChunkDeriveDerivationType;
use crate::turns::TurnStatus;

use super::compose::{ComposeDerivationRow, ComposeMessage};

#[allow(dead_code)]
const SQL_READ_TURN_SOURCE: &str = r#"SELECT status, deleted_at FROM turns WHERE turn_id = ?"#;

#[allow(dead_code)]
const SQL_READ_MEMBER_MESSAGES: &str = r#"SELECT message_id, kind FROM message
       WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order"#;

#[allow(dead_code)]
const SQL_READ_MESSAGE_BLOCKS: &str = r#"SELECT block_type, content FROM message_block
     WHERE message_id = ? ORDER BY block_index"#;

/// Base SELECT for `readMessageDerivationRows` (TS). Phase 2 appends N `?`
/// placeholders then [`SQL_READ_MESSAGE_DERIVATION_ROWS_SUFFIX`].
#[allow(dead_code)]
const SQL_READ_MESSAGE_DERIVATION_ROWS_PREFIX: &str = r#"SELECT subject_id, derivation_type, state, content, reason, metadata, source_version
       FROM derivation
       WHERE subject_kind = 'message' AND subject_id IN ("#;

#[allow(dead_code)]
const SQL_READ_MESSAGE_DERIVATION_ROWS_SUFFIX: &str = r#")"#;

#[allow(dead_code)]
const SQL_READ_MEMBER_PROJECTIONS: &str = r#"SELECT cm.turn_id, t.turn_id AS existing_turn_id, t.deleted_at,
              df.state, df.content,
              af.state AS assembly_state, af.content AS assembly_content,
              rf.state AS rendering_state, rf.content AS rendering_content
       FROM chunk_member cm
       LEFT JOIN turns t ON t.turn_id = cm.turn_id
       LEFT JOIN derivation df ON df.subject_kind = 'turn'
         AND df.subject_id = cm.turn_id AND df.derivation_type = 'detailed_turn_compression'
       LEFT JOIN derivation af ON af.subject_kind = 'turn'
         AND af.subject_id = cm.turn_id AND af.derivation_type = 'pre_detailed_assembly'
       LEFT JOIN derivation rf ON rf.subject_kind = 'turn'
         AND rf.subject_id = cm.turn_id AND rf.derivation_type = 'turn_rendering'
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx"#;

#[allow(dead_code)]
const SQL_READ_OWNED_DERIVATIONS: &str = r#"SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = ?
       ORDER BY subject_id, derivation_type"#;

#[allow(dead_code)]
const SQL_READ_CHUNK_ROWS: &str = r#"SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
       FROM chunk ORDER BY chunk_order"#;

#[allow(dead_code)]
const SQL_READ_CHUNK_ROW_MEMBERS: &str = r#"SELECT cm.turn_id FROM chunk_member cm
     JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
     WHERE cm.chunk_id = ? ORDER BY cm.member_idx"#;

#[allow(dead_code)]
const SQL_READ_TURN_DERIVATION_ROW: &str = r#"SELECT state, content, reason, source_version FROM derivation
       WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?"#;

#[allow(dead_code)]
const SQL_READ_CHUNK_SUMMARY_DERIVATION: &str = r#"SELECT state, content, reason, source_version FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"#;

/// SELECT + LEFT JOIN for `reportTurnDerivations` (static head; no WHERE).
/// The derivation_type→kind CASE is the turns owner's own queue-site mapping.
///
/// Exact Phase 2 fragment inventory (TS template bytes; no `{conditions}` fake SQL):
/// - [`SQL_REPORT_TURN_DERIVATIONS_SELECT_JOIN`]
/// - [`SQL_REPORT_WHERE_PREFIX`] (`"\n       WHERE "`)
/// - conditions joined by [`SQL_REPORT_COND_JOIN`] (`" AND "`):
///   - always [`SQL_REPORT_COND_SUBJECT_KIND_TURN_CHUNK`]
///   - optional subject-filter group:
///     [`SQL_REPORT_SUBJECT_FILTER_GROUP_PREFIX`] + filters joined by
///     [`SQL_REPORT_SUBJECT_FILTER_JOIN`] (`" OR "`) +
///     [`SQL_REPORT_SUBJECT_FILTER_GROUP_SUFFIX`]
///     where each filter is [`SQL_REPORT_COND_TURN_SUBJECT`] /
///     [`SQL_REPORT_COND_CHUNK_SUBJECT`]
///   - optional [`SQL_REPORT_COND_NOT_READY`]
/// - [`SQL_REPORT_TURN_DERIVATIONS_ORDER_BY`]
///
/// Reconstructs base / turn-only / chunk-only / combined / notReady templates.
#[allow(dead_code)]
const SQL_REPORT_TURN_DERIVATIONS_SELECT_JOIN: &str = r#"SELECT df.subject_kind, df.subject_id, df.derivation_type, df.state, df.content, df.reason,
              df.metadata, df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE
          WHEN df.derivation_type IN ('turn_rendering', 'pre_detailed_assembly') THEN 'turn_derivation'
          WHEN df.derivation_type = 'detailed_turn_compression' THEN 'detailed_turn_compression'
          WHEN df.subject_kind = 'chunk' THEN df.derivation_type
          ELSE 'turn_derivation'
        END
        AND json_extract(
              w.source_ref,
              CASE WHEN df.subject_kind = 'turn' THEN '$.turnId' ELSE '$.chunkId' END
            ) = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version"#;

#[allow(dead_code)]
const SQL_REPORT_WHERE_PREFIX: &str = "\n       WHERE ";
#[allow(dead_code)]
const SQL_REPORT_COND_JOIN: &str = " AND ";
#[allow(dead_code)]
const SQL_REPORT_COND_SUBJECT_KIND_TURN_CHUNK: &str = r#"df.subject_kind IN ('turn', 'chunk')"#;
#[allow(dead_code)]
const SQL_REPORT_COND_TURN_SUBJECT: &str = r#"(df.subject_kind = 'turn' AND df.subject_id = ?)"#;
#[allow(dead_code)]
const SQL_REPORT_COND_CHUNK_SUBJECT: &str = r#"(df.subject_kind = 'chunk' AND df.subject_id = ?)"#;
#[allow(dead_code)]
const SQL_REPORT_SUBJECT_FILTER_GROUP_PREFIX: &str = "(";
#[allow(dead_code)]
const SQL_REPORT_SUBJECT_FILTER_GROUP_SUFFIX: &str = ")";
#[allow(dead_code)]
const SQL_REPORT_SUBJECT_FILTER_JOIN: &str = " OR ";
#[allow(dead_code)]
const SQL_REPORT_COND_NOT_READY: &str = r#"df.state <> 'ready'"#;
#[allow(dead_code)]
const SQL_REPORT_TURN_DERIVATIONS_ORDER_BY: &str =
    "\n       ORDER BY df.subject_kind DESC, df.subject_id, df.derivation_type";

#[allow(dead_code)]
const SQL_CHUNK_EXISTS: &str = r#"SELECT 1 FROM chunk WHERE chunk_id = ?"#;

/// TS `TurnSource`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSource {
    pub turn_id: String,
    pub status: TurnStatus,
    pub deleted: bool,
}

pub fn read_turn_source(_db: &Db, _turn_id: &str) -> Option<TurnSource> {
    todo!("phase 2")
}

pub fn read_member_messages(_db: &Db, _turn_id: &str) -> Vec<ComposeMessage> {
    todo!("phase 2")
}

/// TS `readMessageDerivationRows` — `Map` → [`IndexMap`].
pub fn read_message_derivation_rows(
    _db: &Db,
    _message_ids: &[String],
) -> IndexMap<String, ComposeDerivationRow> {
    todo!("phase 2")
}

/// TS `MemberProjection`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProjection {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assembly_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assembly_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendering_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendering_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_corruption_reason: Option<String>,
}

pub fn read_member_projections(_db: &Db, _chunk_id: &str) -> Vec<MemberProjection> {
    todo!("phase 2")
}

/// TS private `RawOwnedDerivationRow`.
#[derive(Debug, Clone, PartialEq)]
struct RawOwnedDerivationRow {
    subject_id: String,
    derivation_type: String,
    state: String,
    content: Option<String>,
    reason: Option<String>,
    metadata: Option<String>,
    source_version: i64,
    gaps: Option<String>,
    derived_at: Option<String>,
}

/// Closed subject vocabulary for `readOwnedDerivations` (`"turn" | "chunk"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOwnedSubjectKind {
    Turn,
    Chunk,
}

impl TurnOwnedSubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnOwnedSubjectKind::Turn => "turn",
            TurnOwnedSubjectKind::Chunk => "chunk",
        }
    }

    pub fn to_subject_kind(self) -> SubjectKind {
        match self {
            TurnOwnedSubjectKind::Turn => SubjectKind::Turn,
            TurnOwnedSubjectKind::Chunk => SubjectKind::Chunk,
        }
    }
}

/// TS `readOwnedDerivations` — `Map` → [`IndexMap`].
pub fn read_owned_derivations(
    _db: &Db,
    _subject_kind: TurnOwnedSubjectKind,
) -> IndexMap<String, Vec<Derivation>> {
    todo!("phase 2")
}

/// TS `ChunkReadRow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkReadRow {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub accumulated_projected_tokens: i64,
    pub member_turn_ids: Vec<String>,
}

pub fn read_chunk_rows(_db: &Db) -> Vec<ChunkReadRow> {
    todo!("phase 2")
}

/// TS `readTurnDerivationRow` view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDerivationRowView {
    pub state: DerivationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source_version: i64,
}

pub fn read_turn_derivation_row(
    _db: &Db,
    _subject_kind: TurnOwnedSubjectKind,
    _subject_id: &str,
    _derivation: &str,
) -> Option<TurnDerivationRowView> {
    todo!("phase 2")
}

pub fn read_chunk_summary_derivation(
    _db: &Db,
    _chunk_id: &str,
    _derivation_type: ChunkDeriveDerivationType,
) -> Option<TurnDerivationRowView> {
    todo!("phase 2")
}

/// TS `reportTurnDerivations` opts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnReportOptions {
    pub not_ready: Option<bool>,
    pub turn_id: Option<String>,
    pub chunk_id: Option<String>,
}

pub fn report_turn_derivations(_db: &Db, _opts: &TurnReportOptions) -> Vec<DerivationReportEntry> {
    todo!("phase 2")
}

pub fn chunk_exists(_db: &Db, _chunk_id: &str) -> bool {
    todo!("phase 2")
}

const _: usize = std::mem::size_of::<RawOwnedDerivationRow>();
