//! Ported from packages/lhc/src/messages/internal/store.ts.
//!
//! Message and block row operations. Writes run on the caller's handle inside
//! the batch transaction; reads run on a fresh handle per operation.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::messages::{Block, BlockType, MessageKind, MessageRecord};
use crate::shared_tech::derivation::Derivation;
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::storage::{Db, SqlParam};

const SQL_INSERT_MESSAGE: &str = r#"INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)"#;

const SQL_INSERT_MESSAGE_BLOCK: &str = r#"INSERT INTO message_block (message_id, block_index, block_type, content)
     VALUES (?, ?, ?, ?)"#;

#[allow(dead_code)]
const SQL_READ_MUTABLE_MESSAGE: &str = r#"SELECT m.message_id, m.kind, m.turn_id, m.source_event_order,
              t.status AS turn_status,
              NOT EXISTS (
                SELECT 1 FROM message prior
                WHERE prior.turn_id = m.turn_id
                  AND prior.deleted_at IS NULL
                  AND prior.source_event_order < m.source_event_order
              ) AS is_first_member
       FROM message m LEFT JOIN turns t ON t.turn_id = m.turn_id
       WHERE m.message_id = ? AND m.deleted_at IS NULL"#;

#[allow(dead_code)]
const SQL_MARK_MESSAGE_DELETED: &str = r#"UPDATE message SET deleted_at = ? WHERE message_id = ?"#;

#[allow(dead_code)]
const SQL_SELECT_BLOCKS_FOR_EDIT: &str = r#"SELECT block_index, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"#;

#[allow(dead_code)]
const SQL_UPDATE_MESSAGE_BLOCK: &str =
    r#"UPDATE message_block SET content = ? WHERE message_id = ? AND block_index = ?"#;

#[allow(dead_code)]
const SQL_UPDATE_TOKEN_ESTIMATE: &str =
    r#"UPDATE message SET token_estimate = ? WHERE message_id = ?"#;

/// Select clause + join for bounded list reads (`readMessages`).
///
/// Composition (TS):
///   [`SQL_READ_MESSAGES_SELECT`]
///     + (if any preds: `" WHERE " + preds.join(" AND ")`)
///     + [`SQL_READ_MESSAGES_ORDER_BY`]
///     + (optional [`SQL_READ_MESSAGES_LIMIT`])
/// Predicates are appended in order: deleted → from → to (limit is a trailing
/// clause, not a WHERE predicate; its `?` is still pushed onto params).
const SQL_READ_MESSAGES_SELECT: &str = r#"SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order"#;

/// Default live-row filter (`includeDeleted !== true`).
const SQL_READ_MESSAGES_PRED_NOT_DELETED: &str = r#"m.deleted_at IS NULL"#;
/// Lower source-event-order bound (`opts.from`).
const SQL_READ_MESSAGES_PRED_FROM: &str = r#"m.source_event_order >= ?"#;
/// Upper source-event-order bound (`opts.to`).
const SQL_READ_MESSAGES_PRED_TO: &str = r#"m.source_event_order <= ?"#;
const SQL_READ_MESSAGES_ORDER_BY: &str = r#" ORDER BY m.source_event_order"#;
const SQL_READ_MESSAGES_LIMIT: &str = r#" LIMIT ?"#;

/// Dynamic IN clause for windowed block loads: PREFIX + `?, ?, …` + SUFFIX.
const SQL_READ_BLOCKS_FOR_IDS_PREFIX: &str = r#"SELECT message_id, block_type, content FROM message_block
       WHERE message_id IN ("#;

const SQL_READ_BLOCKS_FOR_IDS_SUFFIX: &str = r#")
       ORDER BY message_id, block_index"#;

#[allow(dead_code)]
const SQL_READ_MESSAGE_BY_ID: &str = r#"SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order
       WHERE m.message_id = ?"#;

#[allow(dead_code)]
const SQL_READ_BLOCKS_BY_MESSAGE_ID: &str = r#"SELECT message_id, block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index"#;

#[derive(Debug, Clone, PartialEq)]
pub struct MessageRow {
    pub message_id: String,
    pub source_event_order: i64,
    pub kind: MessageKind,
    pub token_estimate: i64,
    pub actor: String,
    pub harness: String,
    /// Membership stamp, settled at intake: the current open turn after turn
    /// intake. Written once here, never updated.
    pub turn_id: String,
    pub blocks: Vec<Block>,
}

pub fn insert_message(db: &Db, row: &MessageRow) {
    db.prepare(SQL_INSERT_MESSAGE).run(&[
        SqlParam::from(row.message_id.as_str()),
        SqlParam::from(row.source_event_order),
        SqlParam::from(row.kind.as_str()),
        SqlParam::from(row.token_estimate),
        SqlParam::from(row.actor.as_str()),
        SqlParam::from(row.harness.as_str()),
        SqlParam::from(row.turn_id.as_str()),
    ]);

    let insert_block = db.prepare(SQL_INSERT_MESSAGE_BLOCK);
    for (index, block) in row.blocks.iter().enumerate() {
        let content_json = js_json_stringify(&Value::Object(block.content.clone()));
        insert_block.run(&[
            SqlParam::from(row.message_id.as_str()),
            SqlParam::from(index as i64),
            SqlParam::from(block.block_type.as_str()),
            SqlParam::from(content_json.as_str()),
        ]);
    }
}

/// Turn status as joined for mutation validation (`"open" | "closed" | null`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutableTurnStatus {
    Open,
    Closed,
}

impl MutableTurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MutableTurnStatus::Open => "open",
            MutableTurnStatus::Closed => "closed",
        }
    }
}

/// Mutation validation view: live message joined to its turn status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutableMessageView {
    pub message_id: String,
    pub kind: String,
    pub turn_id: String,
    pub turn_status: Option<MutableTurnStatus>,
    pub initiates_turn: bool,
}

pub fn read_mutable_message(_db: &Db, _message_id: &str) -> Option<MutableMessageView> {
    todo!("phase 2")
}

pub fn mark_message_deleted(_db: &Db, _message_id: &str, _deleted_at: &str) {
    todo!("phase 2")
}

pub fn apply_message_edit(_db: &Db, _message_id: &str, _content: &str) {
    todo!("phase 2")
}

struct RawMessageRow {
    message_id: String,
    source_event_order: i64,
    kind: String,
    token_estimate: i64,
    actor: String,
    harness: String,
    turn_id: String,
    deleted_at: Option<String>,
    /// The source event's recorded_at, joined from the durable event row.
    recorded_at: String,
}

#[allow(dead_code)]
struct RawBlockRow {
    message_id: String,
    block_type: String,
    content: String,
}

fn message_kind_from_wire(kind: &str) -> MessageKind {
    match kind {
        "user_prompt" => MessageKind::UserPrompt,
        "assistant_text" => MessageKind::AssistantText,
        "assistant_thinking" => MessageKind::AssistantThinking,
        "runtime_note" => MessageKind::RuntimeNote,
        "model_change" => MessageKind::ModelChange,
        "thinking_level_change" => MessageKind::ThinkingLevelChange,
        "tool_call" => MessageKind::ToolCall,
        "tool_result" => MessageKind::ToolResult,
        other => panic!("unknown message kind from row: {other}"),
    }
}

fn block_type_from_wire(block_type: &str) -> BlockType {
    match block_type {
        "text" => BlockType::Text,
        "tool_call" => BlockType::ToolCall,
        "tool_result" => BlockType::ToolResult,
        "model_change" => BlockType::ModelChange,
        "thinking_level_change" => BlockType::ThinkingLevelChange,
        other => panic!("unknown block type from row: {other}"),
    }
}

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
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

fn map_optional_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn record_from_row(row: &RawMessageRow, blocks: Vec<Block>) -> MessageRecord {
    let mut record = MessageRecord {
        message_id: row.message_id.clone(),
        source_event_order: row.source_event_order,
        kind: message_kind_from_wire(&row.kind),
        blocks,
        token_estimate: row.token_estimate,
        actor: row.actor.clone(),
        harness: row.harness.clone(),
        recorded_at: row.recorded_at.clone(),
        turn_id: row.turn_id.clone(),
        derivations: None,
        deleted: None,
    };
    // The deleted marker is present only on deleted rows, which only the
    // includeDeleted read surfaces. It is never silently mixed into default reads.
    if row.deleted_at.is_some() {
        record.deleted = Some(true);
    }
    record
}

/// Bounds are in source-event-order coordinates. Same shape as MessageListOptions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MessageReadOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_deleted: Option<bool>,
}

pub fn read_messages(db: &Db, opts: &MessageReadOptions) -> Vec<MessageRecord> {
    // Bounds before content: the message query carries the deleted filter, the
    // source-order window, and the limit, so a bounded list resolves its window
    // from the message table first. It never reads a row, or parses a block
    // below, outside that window.
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<SqlParam> = Vec::new();
    if opts.include_deleted != Some(true) {
        conditions.push(SQL_READ_MESSAGES_PRED_NOT_DELETED);
    }
    if let Some(from) = opts.from {
        conditions.push(SQL_READ_MESSAGES_PRED_FROM);
        params.push(SqlParam::from(from));
    }
    if let Some(to) = opts.to {
        conditions.push(SQL_READ_MESSAGES_PRED_TO);
        params.push(SqlParam::from(to));
    }
    if let Some(limit) = opts.limit {
        params.push(SqlParam::from(limit));
    }

    let mut sql = String::from(SQL_READ_MESSAGES_SELECT);
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(SQL_READ_MESSAGES_ORDER_BY);
    if opts.limit.is_some() {
        sql.push_str(SQL_READ_MESSAGES_LIMIT);
    }

    let message_maps = db.prepare(&sql).all(&params);
    if message_maps.is_empty() {
        return Vec::new();
    }

    let message_rows: Vec<RawMessageRow> = message_maps
        .iter()
        .map(|row| RawMessageRow {
            message_id: map_required_str(row, "message_id"),
            source_event_order: map_required_i64(row, "source_event_order"),
            kind: map_required_str(row, "kind"),
            token_estimate: map_required_i64(row, "token_estimate"),
            actor: map_required_str(row, "actor"),
            harness: map_required_str(row, "harness"),
            turn_id: map_required_str(row, "turn_id"),
            deleted_at: map_optional_str(row, "deleted_at"),
            recorded_at: map_required_str(row, "recorded_at"),
        })
        .collect();

    // Block content only for the windowed messages — never the whole table.
    let ids: Vec<String> = message_rows
        .iter()
        .map(|row| row.message_id.clone())
        .collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let blocks_sql =
        format!("{SQL_READ_BLOCKS_FOR_IDS_PREFIX}{placeholders}{SQL_READ_BLOCKS_FOR_IDS_SUFFIX}");
    let id_params: Vec<SqlParam> = ids.iter().map(|id| SqlParam::from(id.as_str())).collect();
    let block_maps = db.prepare(&blocks_sql).all(&id_params);

    let mut blocks_by_message: HashMap<String, Vec<Block>> = HashMap::new();
    for row in block_maps {
        let message_id = map_required_str(&row, "message_id");
        let block_type = block_type_from_wire(&map_required_str(&row, "block_type"));
        let content_text = map_required_str(&row, "content");
        let parsed: Value =
            serde_json::from_str(&content_text).unwrap_or_else(|err| panic!("{err}"));
        let content = match parsed {
            Value::Object(map) => map,
            other => panic!("message block content is not a JSON object: {other}"),
        };
        blocks_by_message
            .entry(message_id)
            .or_default()
            .push(Block {
                block_type,
                content,
            });
    }

    message_rows
        .into_iter()
        .map(|row| {
            let blocks = blocks_by_message
                .remove(&row.message_id)
                .unwrap_or_default();
            record_from_row(&row, blocks)
        })
        .collect()
}

/// TS `(MessageRecord & { deleted: boolean })` — deleted always present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordWithDeleted {
    pub message_id: String,
    pub source_event_order: i64,
    pub kind: MessageKind,
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
    pub actor: String,
    pub harness: String,
    pub recorded_at: String,
    pub turn_id: String,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
}

pub fn read_message_by_id(_db: &Db, _message_id: &str) -> Option<MessageRecordWithDeleted> {
    todo!("phase 2")
}
