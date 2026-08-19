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
use crate::shared_tech::report::{RawReportRow, report_entry_from_row};
use crate::shared_tech::storage::{Db, SqlParam};

// Private SQL literals (TS module-local). Fragment composition documented for Phase 2.
const SQL_SELECT_MESSAGE_KIND: &str = r#"SELECT kind FROM message WHERE message_id = ?"#;

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

/// TS batch width on readMessageDerivations: bound parameters per scoped read.
const DERIVATION_READ_BATCH_SIZE: usize = 400;

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
const SQL_REPORT_MESSAGE_DERIVATIONS_SELECT_JOIN: &str = r#"SELECT df.subject_id, df.derivation_type, df.state, df.content, df.reason, df.metadata,
              df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE df.derivation_type WHEN 'smoothed_prompt' THEN 'prompt_smoothing' ELSE df.derivation_type END
        AND json_extract(w.source_ref, '$.messageId') = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version"#;

const SQL_REPORT_COND_SUBJECT_KIND_MESSAGE: &str = r#"df.subject_kind = 'message'"#;
const SQL_REPORT_COND_SUBJECT_ID: &str = r#"df.subject_id = ?"#;
const SQL_REPORT_COND_NOT_READY: &str = r#"df.state <> 'ready'"#;
const SQL_REPORT_MESSAGE_DERIVATIONS_ORDER_BY: &str =
    r#" ORDER BY df.subject_id, df.derivation_type"#;

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

pub fn read_message_source(db: &Db, message_id: &str) -> Option<MessageSource> {
    let row = db
        .prepare(SQL_SELECT_MESSAGE_KIND)
        .get_params(&[SqlParam::from(message_id)])?;
    let kind = map_required_str(&row, "kind");
    let block_rows = db
        .prepare(SQL_SELECT_MESSAGE_BLOCKS)
        .all(&[SqlParam::from(message_id)]);
    let blocks = block_rows
        .into_iter()
        .map(|block| {
            let content_raw = map_required_str(&block, "content");
            let content_value: Value = serde_json::from_str(&content_raw)
                .unwrap_or_else(|err| panic!("message block content JSON: {err}"));
            let content = match content_value {
                Value::Object(map) => map,
                other => panic!("message block content not object: {other}"),
            };
            MessageSourceBlock {
                block_type: map_required_str(&block, "block_type"),
                content,
            }
        })
        .collect();
    Some(MessageSource {
        message_id: message_id.to_string(),
        kind,
        blocks,
    })
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

    // TS `[...new Set(messageIds)].sort()`: dedupe, then JS UTF-16 code-unit
    // order so the per-batch `ORDER BY subject_id` reads concatenate into one
    // globally subject_id-ordered stream, exactly as the single query did.
    let scoped_message_ids: Option<Vec<String>> = message_ids.map(|ids| {
        let mut unique: Vec<String> = ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<String>>()
            .into_iter()
            .collect();
        unique.sort_by(|a, b| crate::shared_tech::compact_continuation::js_string_cmp(a, b));
        unique
    });
    // SQLite's parameter ceiling varies by build; never bind a mature thread's
    // whole message set in one IN clause.
    const EMPTY_BATCH: &[String] = &[];
    let batches: Vec<&[String]> = match &scoped_message_ids {
        Some(ids) => ids.chunks(DERIVATION_READ_BATCH_SIZE).collect(),
        None => vec![EMPTY_BATCH],
    };

    let mut rows: Vec<Map<String, Value>> = Vec::new();
    for batch in batches {
        let mut sql = String::from(SQL_READ_MESSAGE_DERIVATIONS_BASE);
        let mut params: Vec<SqlParam> = Vec::new();
        if message_ids.is_some() {
            let placeholders = batch.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            sql.push_str(SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX);
            sql.push_str(&placeholders);
            sql.push(')');
            params.extend(batch.iter().map(|id| SqlParam::from(id.as_str())));
        }
        sql.push_str(SQL_READ_MESSAGE_DERIVATIONS_ORDER_BY);
        rows.extend(db.prepare(&sql).all(&params));
    }

    for row in rows {
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
    db: &Db,
    message_id: &str,
    derivation_type: &str,
) -> Option<MessageDerivationRowView> {
    let row = db
        .prepare(SQL_READ_MESSAGE_DERIVATION_ROW)
        .get_params(&[SqlParam::from(message_id), SqlParam::from(derivation_type)])?;
    let mut view = MessageDerivationRowView {
        state: parse_derivation_state(&map_required_str(&row, "state")),
        reason: None,
        source_version: map_required_i64(&row, "source_version"),
    };
    if let Some(reason) = map_optional_str(&row, "reason") {
        view.reason = Some(reason);
    }
    Some(view)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageReportOptions {
    pub not_ready: Option<bool>,
    pub message_id: Option<String>,
}

pub fn report_message_derivations(
    db: &Db,
    opts: &MessageReportOptions,
) -> Vec<DerivationReportEntry> {
    let mut conditions = vec![SQL_REPORT_COND_SUBJECT_KIND_MESSAGE.to_string()];
    let mut params: Vec<SqlParam> = Vec::new();
    if let Some(message_id) = &opts.message_id {
        conditions.push(SQL_REPORT_COND_SUBJECT_ID.to_string());
        params.push(SqlParam::from(message_id.as_str()));
    }
    // notReady is exact set equality by construction: every state but ready.
    if opts.not_ready == Some(true) {
        conditions.push(SQL_REPORT_COND_NOT_READY.to_string());
    }
    let mut sql = String::from(SQL_REPORT_MESSAGE_DERIVATIONS_SELECT_JOIN);
    sql.push_str(" WHERE ");
    sql.push_str(&conditions.join(" AND "));
    sql.push_str(SQL_REPORT_MESSAGE_DERIVATIONS_ORDER_BY);

    db.prepare(&sql)
        .all(&params)
        .into_iter()
        .map(|row| {
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
            report_entry_from_row(SubjectKind::Message, &raw)
        })
        .collect()
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
    db: &Db,
    block_type: PairedBlockType,
    tool_call_id: &str,
) -> Option<Map<String, Value>> {
    let row = db.prepare(SQL_FIND_PAIRED_BLOCK).get_params(&[
        SqlParam::from(block_type.as_str()),
        SqlParam::from(tool_call_id),
    ])?;
    let content_raw = map_required_str(&row, "content");
    let content_value: Value = serde_json::from_str(&content_raw)
        .unwrap_or_else(|err| panic!("paired block content JSON: {err}"));
    match content_value {
        Value::Object(map) => Some(map),
        other => panic!("paired block content not object: {other}"),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairedToolResult {
    pub content: String,
    pub is_error: bool,
}

pub fn find_paired_tool_result(db: &Db, tool_call_id: &str) -> Option<PairedToolResult> {
    let block = find_paired_block(db, PairedBlockType::ToolResult, tool_call_id)?;
    Some(PairedToolResult {
        content: match block.get("content") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        },
        is_error: block.get("isError") == Some(&Value::Bool(true)),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairedToolCall {
    pub tool_name: String,
    pub tool_input: Option<Map<String, Value>>,
}

pub fn find_paired_tool_call(db: &Db, tool_call_id: &str) -> Option<PairedToolCall> {
    let block = find_paired_block(db, PairedBlockType::ToolCall, tool_call_id)?;
    let tool_name = match block.get("toolName") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let tool_input = match block.get("arguments") {
        Some(Value::Object(map)) => Some(map.clone()),
        _ => None,
    };
    Some(PairedToolCall {
        tool_name,
        tool_input,
    })
}
