//! Ported from packages/lhc/src/messages/internal/derivations.ts.
//!
//! Message-domain derivation reads. `read_message_derivations` is live for list
//! attachment; remaining helpers stay Phase 2.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::shared_tech::derivation::{
    DependencyGap, Derivation, DerivationMetadata, DerivationReportEntry, DerivationState,
    SubjectKind,
};
use crate::shared_tech::storage::{Db, SqlParam};

// Private SQL literals (TS module-local). Fragment composition documented for Phase 2.
#[allow(dead_code)]
const SQL_SELECT_MESSAGE_KIND: &str = r#"SELECT kind FROM message WHERE message_id = ?"#;

#[allow(dead_code)]
const SQL_SELECT_MESSAGE_BLOCKS: &str = r#"SELECT block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"#;

/// Base SELECT for `readMessageDerivations` (TS). When `messageIds` is provided,
/// appends [`SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX`] + `?, ?, …`
/// + `)` then [`SQL_READ_MESSAGE_DERIVATIONS_ORDER_BY`].
const SQL_READ_MESSAGE_DERIVATIONS_BASE: &str = r#"SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = 'message'"#;

/// TS `idFilter` when messageIds is defined: ` AND subject_id IN (${placeholders})`.
const SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX: &str = r#" AND subject_id IN ("#;

/// TS trailing clause on readMessageDerivations.
const SQL_READ_MESSAGE_DERIVATIONS_ORDER_BY: &str = r#" ORDER BY subject_id, derivation_type"#;

#[allow(dead_code)]
const SQL_READ_MESSAGE_DERIVATION_ROW: &str = r#"SELECT state, reason, source_version FROM derivation
       WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?"#;

/// SELECT + LEFT JOIN for `reportMessageDerivations` (no WHERE — conditions
/// composed from fragments below). The derivation_type→kind CASE is the owner's
/// own queue-site mapping (MESSAGE_WORK_DERIVATIONS) inverted.
///
/// Phase 2 composition (TS):
///   SELECT…JOIN… + " WHERE " + conditions.join(" AND ")
///     + [`SQL_REPORT_MESSAGE_DERIVATIONS_ORDER_BY`]
/// where `conditions` always starts with [`SQL_REPORT_COND_SUBJECT_KIND_MESSAGE`]
/// and may append [`SQL_REPORT_COND_SUBJECT_ID`] / [`SQL_REPORT_COND_NOT_READY`].
/// Never present a literal `WHERE {conditions}` placeholder as SQL.
#[allow(dead_code)]
const SQL_REPORT_MESSAGE_DERIVATIONS_SELECT_JOIN: &str = r#"SELECT df.subject_id, df.derivation_type, df.state, df.content, df.reason, df.metadata,
              df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE df.derivation_type WHEN 'smoothed_prompt' THEN 'prompt_smoothing' ELSE df.derivation_type END
        AND json_extract(w.source_ref, '$.messageId') = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version"#;

#[allow(dead_code)]
const SQL_REPORT_COND_SUBJECT_KIND_MESSAGE: &str = r#"df.subject_kind = 'message'"#;
#[allow(dead_code)]
const SQL_REPORT_COND_SUBJECT_ID: &str = r#"df.subject_id = ?"#;
#[allow(dead_code)]
const SQL_REPORT_COND_NOT_READY: &str = r#"df.state <> 'ready'"#;
#[allow(dead_code)]
const SQL_REPORT_MESSAGE_DERIVATIONS_ORDER_BY: &str =
    r#" ORDER BY df.subject_id, df.derivation_type"#;

#[allow(dead_code)]
const SQL_FIND_PAIRED_BLOCK: &str = r#"SELECT b.content FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order LIMIT 1"#;

#[derive(Debug, Clone, PartialEq)]
pub struct MessageSourceBlock {
    pub block_type: String,
    pub content: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageSource {
    pub message_id: String,
    pub kind: String,
    pub blocks: Vec<MessageSourceBlock>,
}

pub fn read_message_source(_db: &Db, _message_id: &str) -> Option<MessageSource> {
    todo!("phase 2")
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
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or_else(|| panic!("column {key} not integer")),
        Some(Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

/// TS returns `Map<string, Derivation[]>` — insertion-ordered [`IndexMap`].
pub fn read_message_derivations(
    db: &Db,
    message_ids: Option<&[String]>,
) -> IndexMap<String, Vec<Derivation>> {
    let mut by_message = IndexMap::new();
    if let Some(ids) = message_ids {
        if ids.is_empty() {
            return by_message;
        }
    }

    let mut sql = String::from(SQL_READ_MESSAGE_DERIVATIONS_BASE);
    let mut params: Vec<SqlParam> = Vec::new();
    if let Some(ids) = message_ids {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        sql.push_str(SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX);
        sql.push_str(&placeholders);
        sql.push(')');
        params.extend(ids.iter().map(|id| SqlParam::from(id.as_str())));
    }
    sql.push_str(SQL_READ_MESSAGE_DERIVATIONS_ORDER_BY);

    for row in db.prepare(&sql).all(&params) {
        let subject_id = map_required_str(&row, "subject_id");
        let mut record = Derivation {
            subject_kind: SubjectKind::Message,
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
        by_message.entry(subject_id).or_default().push(record);
    }
    by_message
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageDerivationRowView {
    pub state: DerivationState,
    pub reason: Option<String>,
    pub source_version: i64,
}

pub fn read_message_derivation_row(
    _db: &Db,
    _message_id: &str,
    _derivation_type: &str,
) -> Option<MessageDerivationRowView> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageReportOptions {
    pub not_ready: Option<bool>,
    pub message_id: Option<String>,
}

pub fn report_message_derivations(
    _db: &Db,
    _opts: &MessageReportOptions,
) -> Vec<DerivationReportEntry> {
    todo!("phase 2")
}

/// Closed block types used by call-id pairing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairedBlockType {
    ToolCall,
    ToolResult,
}

impl PairedBlockType {
    pub fn as_str(self) -> &'static str {
        match self {
            PairedBlockType::ToolCall => "tool_call",
            PairedBlockType::ToolResult => "tool_result",
        }
    }
}

fn find_paired_block(
    _db: &Db,
    _block_type: PairedBlockType,
    _tool_call_id: &str,
) -> Option<Map<String, Value>> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairedToolResult {
    pub content: String,
    pub is_error: bool,
}

pub fn find_paired_tool_result(_db: &Db, _tool_call_id: &str) -> Option<PairedToolResult> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairedToolCall {
    pub tool_name: String,
    pub tool_input: Option<Map<String, Value>>,
}

pub fn find_paired_tool_call(_db: &Db, _tool_call_id: &str) -> Option<PairedToolCall> {
    todo!("phase 2")
}
