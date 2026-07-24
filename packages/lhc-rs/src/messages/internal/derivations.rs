//! Ported from packages/lhc/src/messages/internal/derivations.ts. Phase 1 skeleton.
//!
//! Message-domain derivation reads. SQL literals REAL; behavior bodies
//! `todo!("phase 2")`.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::shared_tech::derivation::{Derivation, DerivationReportEntry, DerivationState};
use crate::shared_tech::storage::Db;

// Private SQL literals (TS module-local). Fragment composition documented for Phase 2.
#[allow(dead_code)]
const SQL_SELECT_MESSAGE_KIND: &str = r#"SELECT kind FROM message WHERE message_id = ?"#;

#[allow(dead_code)]
const SQL_SELECT_MESSAGE_BLOCKS: &str = r#"SELECT block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"#;

/// Base SELECT for `readMessageDerivations` (TS). When `messageIds` is provided,
/// Phase 2 appends [`SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX`] + `?, ?, …`
/// + `)` then [`SQL_READ_MESSAGE_DERIVATIONS_ORDER_BY`].
#[allow(dead_code)]
const SQL_READ_MESSAGE_DERIVATIONS_BASE: &str = r#"SELECT subject_id, derivation_type, state, content, reason, metadata,
              source_version, gaps, derived_at
       FROM derivation WHERE subject_kind = 'message'"#;

/// TS `idFilter` when messageIds is defined: ` AND subject_id IN (${placeholders})`.
/// Phase 2 joins this with N `?` placeholders and a closing `)`.
#[allow(dead_code)]
const SQL_READ_MESSAGE_DERIVATIONS_ID_FILTER_PREFIX: &str = r#" AND subject_id IN ("#;

/// TS trailing clause on readMessageDerivations.
#[allow(dead_code)]
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

struct RawDerivationRow {
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

/// TS returns `Map<string, Derivation[]>` — insertion-ordered [`IndexMap`].
pub fn read_message_derivations(
    _db: &Db,
    _message_ids: Option<&[String]>,
) -> IndexMap<String, Vec<Derivation>> {
    todo!("phase 2")
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
