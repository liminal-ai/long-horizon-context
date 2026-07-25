//! Ported from packages/lhc/src/turns/internal/derivations.ts.
//!
//! Turn-domain derivation reads. SQL literals REAL (private — TS module-local).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::{
    DependencyGap, Derivation, DerivationMetadata, DerivationReportEntry, DerivationState,
    RenderingPartKind, SubjectKind,
};
use crate::shared_tech::report::{RawReportRow, report_entry_from_row};
use crate::shared_tech::storage::{Db, SqlParam};
use crate::turns::ChunkDeriveDerivationType;
use crate::turns::TurnStatus;

use super::compose::{ComposeBlock, ComposeDerivationRow, ComposeMessage, compose_derivation_key};

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

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_optional_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn map_required_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        // Reject non-integer REAL/string (no `f as i64` truncate). Integer
        // SQLite INTEGER and valid integer strings keep as_i64 / parse.
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| panic!("column {key} not integer")),
        Some(Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

fn map_is_non_null(row: &Map<String, Value>, key: &str) -> bool {
    !matches!(row.get(key), None | Some(Value::Null))
}

fn parse_derivation_state(state: &str) -> DerivationState {
    match state {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("unknown derivation state from row: {other}"),
    }
}

fn parse_turn_status(status: &str) -> TurnStatus {
    match status {
        "open" => TurnStatus::Open,
        "closed" => TurnStatus::Closed,
        other => panic!("unknown turn status from row: {other}"),
    }
}

fn parse_rendering_part_kind(kind: &str) -> RenderingPartKind {
    match kind {
        "user_prompt" => RenderingPartKind::UserPrompt,
        "assistant_text" => RenderingPartKind::AssistantText,
        "assistant_thinking" => RenderingPartKind::AssistantThinking,
        "runtime_note" => RenderingPartKind::RuntimeNote,
        "model_change" => RenderingPartKind::ModelChange,
        "thinking_level_change" => RenderingPartKind::ThinkingLevelChange,
        "tool_call" => RenderingPartKind::ToolCall,
        "tool_result" => RenderingPartKind::ToolResult,
        other => panic!("unknown rendering part kind from row: {other}"),
    }
}

fn parse_subject_kind(kind: &str) -> SubjectKind {
    match kind {
        "message" => SubjectKind::Message,
        "turn" => SubjectKind::Turn,
        "chunk" => SubjectKind::Chunk,
        other => panic!("unknown subject kind from row: {other}"),
    }
}

pub fn read_turn_source(db: &Db, turn_id: &str) -> Option<TurnSource> {
    let row = db
        .prepare(SQL_READ_TURN_SOURCE)
        .get_params(&[SqlParam::from(turn_id)])?;
    Some(TurnSource {
        turn_id: turn_id.to_string(),
        status: parse_turn_status(&map_required_str(&row, "status")),
        deleted: map_is_non_null(&row, "deleted_at"),
    })
}

pub fn read_member_messages(db: &Db, turn_id: &str) -> Vec<ComposeMessage> {
    let messages = db
        .prepare(SQL_READ_MEMBER_MESSAGES)
        .all(&[SqlParam::from(turn_id)]);
    let block_stmt = db.prepare(SQL_READ_MESSAGE_BLOCKS);
    messages
        .into_iter()
        .map(|message| {
            let message_id = map_required_str(&message, "message_id");
            let kind = parse_rendering_part_kind(&map_required_str(&message, "kind"));
            let blocks = block_stmt
                .all(&[SqlParam::from(message_id.as_str())])
                .into_iter()
                .map(|block| {
                    let content_raw = map_required_str(&block, "content");
                    let content_value: Value = serde_json::from_str(&content_raw)
                        .unwrap_or_else(|err| panic!("message block content JSON: {err}"));
                    let content = match content_value {
                        Value::Object(map) => map,
                        other => panic!("message block content not object: {other}"),
                    };
                    ComposeBlock {
                        block_type: map_required_str(&block, "block_type"),
                        content,
                    }
                })
                .collect();
            ComposeMessage {
                message_id,
                kind,
                blocks,
            }
        })
        .collect()
}

/// TS `readMessageDerivationRows` — `Map` → [`IndexMap`].
pub fn read_message_derivation_rows(
    db: &Db,
    message_ids: &[String],
) -> IndexMap<String, ComposeDerivationRow> {
    let mut rows = IndexMap::new();
    if message_ids.is_empty() {
        return rows;
    }
    let placeholders = message_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "{SQL_READ_MESSAGE_DERIVATION_ROWS_PREFIX}{placeholders}{SQL_READ_MESSAGE_DERIVATION_ROWS_SUFFIX}"
    );
    let params: Vec<SqlParam> = message_ids
        .iter()
        .map(|id| SqlParam::from(id.as_str()))
        .collect();
    for row in db.prepare(&sql).all(&params) {
        let subject_id = map_required_str(&row, "subject_id");
        let derivation_type = map_required_str(&row, "derivation_type");
        let mut view = ComposeDerivationRow {
            state: parse_derivation_state(&map_required_str(&row, "state")),
            content: None,
            metadata: None,
            reason: None,
            source_version: map_required_i64(&row, "source_version"),
        };
        if let Some(content) = map_optional_str(&row, "content") {
            view.content = Some(content);
        }
        if let Some(reason) = map_optional_str(&row, "reason") {
            view.reason = Some(reason);
        }
        if let Some(metadata) = map_optional_str(&row, "metadata") {
            view.metadata = Some(
                serde_json::from_str::<DerivationMetadata>(&metadata)
                    .unwrap_or_else(|err| panic!("derivation metadata JSON: {err}")),
            );
        }
        rows.insert(compose_derivation_key(&subject_id, &derivation_type), view);
    }
    rows
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

pub fn read_member_projections(db: &Db, chunk_id: &str) -> Vec<MemberProjection> {
    db.prepare(SQL_READ_MEMBER_PROJECTIONS)
        .all(&[SqlParam::from(chunk_id)])
        .into_iter()
        .filter_map(|row| {
            if map_is_non_null(&row, "deleted_at") {
                return None;
            }
            let turn_id = map_required_str(&row, "turn_id");
            let source_corruption_reason = if !map_is_non_null(&row, "existing_turn_id") {
                Some(format!(
                    "canonical record corrupt: chunk {chunk_id} member {turn_id} references missing turn"
                ))
            } else {
                None
            };
            Some(MemberProjection {
                turn_id,
                state: map_optional_str(&row, "state"),
                content: map_optional_str(&row, "content"),
                assembly_state: map_optional_str(&row, "assembly_state"),
                assembly_content: map_optional_str(&row, "assembly_content"),
                rendering_state: map_optional_str(&row, "rendering_state"),
                rendering_content: map_optional_str(&row, "rendering_content"),
                source_corruption_reason,
            })
        })
        .collect()
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
    db: &Db,
    subject_kind: TurnOwnedSubjectKind,
) -> IndexMap<String, Vec<Derivation>> {
    let mut by_subject: IndexMap<String, Vec<Derivation>> = IndexMap::new();
    for row in db
        .prepare(SQL_READ_OWNED_DERIVATIONS)
        .all(&[SqlParam::from(subject_kind.as_str())])
    {
        let subject_id = map_required_str(&row, "subject_id");
        let mut record = Derivation {
            subject_kind: subject_kind.to_subject_kind(),
            subject_id: subject_id.clone(),
            derivation_type: map_required_str(&row, "derivation_type"),
            state: parse_derivation_state(&map_required_str(&row, "state")),
            content: None,
            reason: None,
            source_version: map_required_i64(&row, "source_version"),
            gaps: None,
            metadata: None,
            derived_at: None,
        };
        if let Some(content) = map_optional_str(&row, "content") {
            record.content = Some(content);
        }
        if let Some(reason) = map_optional_str(&row, "reason") {
            record.reason = Some(reason);
        }
        if let Some(metadata) = map_optional_str(&row, "metadata") {
            record.metadata = Some(
                serde_json::from_str::<DerivationMetadata>(&metadata)
                    .unwrap_or_else(|err| panic!("derivation metadata JSON: {err}")),
            );
        }
        if let Some(gaps) = map_optional_str(&row, "gaps") {
            record.gaps = Some(
                serde_json::from_str::<Vec<DependencyGap>>(&gaps)
                    .unwrap_or_else(|err| panic!("dependency gaps JSON: {err}")),
            );
        }
        if let Some(derived_at) = map_optional_str(&row, "derived_at") {
            record.derived_at = Some(derived_at);
        }
        by_subject.entry(subject_id).or_default().push(record);
    }
    by_subject
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

pub fn read_chunk_rows(db: &Db) -> Vec<ChunkReadRow> {
    let chunks = db.prepare(SQL_READ_CHUNK_ROWS).all(&[]);
    let member_stmt = db.prepare(SQL_READ_CHUNK_ROW_MEMBERS);
    chunks
        .into_iter()
        .map(|row| {
            let chunk_id = map_required_str(&row, "chunk_id");
            let member_turn_ids = member_stmt
                .all(&[SqlParam::from(chunk_id.as_str())])
                .into_iter()
                .map(|member| map_required_str(&member, "turn_id"))
                .collect();
            ChunkReadRow {
                chunk_id,
                chunk_order: map_required_i64(&row, "chunk_order"),
                status: parse_turn_status(&map_required_str(&row, "status")),
                accumulated_projected_tokens: map_required_i64(
                    &row,
                    "accumulated_projected_tokens",
                ),
                member_turn_ids,
            }
        })
        .collect()
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
    db: &Db,
    subject_kind: TurnOwnedSubjectKind,
    subject_id: &str,
    derivation: &str,
) -> Option<TurnDerivationRowView> {
    let row = db.prepare(SQL_READ_TURN_DERIVATION_ROW).get_params(&[
        SqlParam::from(subject_kind.as_str()),
        SqlParam::from(subject_id),
        SqlParam::from(derivation),
    ])?;
    let mut view = TurnDerivationRowView {
        state: parse_derivation_state(&map_required_str(&row, "state")),
        content: None,
        reason: None,
        source_version: map_required_i64(&row, "source_version"),
    };
    if let Some(content) = map_optional_str(&row, "content") {
        view.content = Some(content);
    }
    if let Some(reason) = map_optional_str(&row, "reason") {
        view.reason = Some(reason);
    }
    Some(view)
}

pub fn read_chunk_summary_derivation(
    db: &Db,
    chunk_id: &str,
    derivation_type: ChunkDeriveDerivationType,
) -> Option<TurnDerivationRowView> {
    let row = db.prepare(SQL_READ_CHUNK_SUMMARY_DERIVATION).get_params(&[
        SqlParam::from(chunk_id),
        SqlParam::from(derivation_type.as_str()),
    ])?;
    let mut view = TurnDerivationRowView {
        state: parse_derivation_state(&map_required_str(&row, "state")),
        content: None,
        reason: None,
        source_version: map_required_i64(&row, "source_version"),
    };
    if let Some(content) = map_optional_str(&row, "content") {
        view.content = Some(content);
    }
    if let Some(reason) = map_optional_str(&row, "reason") {
        view.reason = Some(reason);
    }
    Some(view)
}

/// TS `reportTurnDerivations` opts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnReportOptions {
    pub not_ready: Option<bool>,
    pub turn_id: Option<String>,
    pub chunk_id: Option<String>,
}

pub fn report_turn_derivations(db: &Db, opts: &TurnReportOptions) -> Vec<DerivationReportEntry> {
    let mut conditions = vec![SQL_REPORT_COND_SUBJECT_KIND_TURN_CHUNK.to_string()];
    let mut params: Vec<SqlParam> = Vec::new();
    let mut subject_filters: Vec<String> = Vec::new();
    if let Some(turn_id) = &opts.turn_id {
        subject_filters.push(SQL_REPORT_COND_TURN_SUBJECT.to_string());
        params.push(SqlParam::from(turn_id.as_str()));
    }
    if let Some(chunk_id) = &opts.chunk_id {
        subject_filters.push(SQL_REPORT_COND_CHUNK_SUBJECT.to_string());
        params.push(SqlParam::from(chunk_id.as_str()));
    }
    if !subject_filters.is_empty() {
        conditions.push(format!(
            "{}{}{}",
            SQL_REPORT_SUBJECT_FILTER_GROUP_PREFIX,
            subject_filters.join(SQL_REPORT_SUBJECT_FILTER_JOIN),
            SQL_REPORT_SUBJECT_FILTER_GROUP_SUFFIX
        ));
    }
    // notReady is exact set equality by construction: every state but ready.
    if opts.not_ready == Some(true) {
        conditions.push(SQL_REPORT_COND_NOT_READY.to_string());
    }
    let mut sql = String::from(SQL_REPORT_TURN_DERIVATIONS_SELECT_JOIN);
    sql.push_str(SQL_REPORT_WHERE_PREFIX);
    sql.push_str(&conditions.join(SQL_REPORT_COND_JOIN));
    sql.push_str(SQL_REPORT_TURN_DERIVATIONS_ORDER_BY);

    db.prepare(&sql)
        .all(&params)
        .into_iter()
        .map(|row| {
            let subject_kind = parse_subject_kind(&map_required_str(&row, "subject_kind"));
            let raw = RawReportRow {
                subject_id: map_required_str(&row, "subject_id"),
                derivation_type: map_required_str(&row, "derivation_type"),
                state: map_required_str(&row, "state"),
                content: map_optional_str(&row, "content"),
                reason: map_optional_str(&row, "reason"),
                metadata: map_optional_str(&row, "metadata"),
                source_version: map_required_i64(&row, "source_version"),
                gaps: map_optional_str(&row, "gaps"),
                derived_at: map_optional_str(&row, "derived_at"),
                queue_status: map_optional_str(&row, "queue_status"),
            };
            report_entry_from_row(subject_kind, &raw)
        })
        .collect()
}

pub fn chunk_exists(db: &Db, chunk_id: &str) -> bool {
    db.prepare(SQL_CHUNK_EXISTS)
        .get_params(&[SqlParam::from(chunk_id)])
        .is_some()
}

const _: usize = std::mem::size_of::<RawOwnedDerivationRow>();
