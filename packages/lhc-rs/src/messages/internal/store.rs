//! Ported from packages/lhc/src/messages/internal/store.ts. Phase 1 skeleton.
//!
//! Message and block row operations. SQL literals REAL; behavior bodies
//! `todo!("phase 2")`.

use serde::{Deserialize, Serialize};

use crate::messages::{Block, MessageKind, MessageRecord};
use crate::shared_tech::derivation::Derivation;
use crate::shared_tech::storage::Db;

#[allow(dead_code)]
const SQL_INSERT_MESSAGE: &str = r#"INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)"#;

#[allow(dead_code)]
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
/// Phase 2 composition (TS):
///   [`SQL_READ_MESSAGES_SELECT`]
///     + (if any preds: `" WHERE " + preds.join(" AND ")`)
///     + [`SQL_READ_MESSAGES_ORDER_BY`]
///     + (optional [`SQL_READ_MESSAGES_LIMIT`])
/// Predicates are appended in order: deleted → from → to (limit is a trailing
/// clause, not a WHERE predicate; its `?` is still pushed onto params).
#[allow(dead_code)]
const SQL_READ_MESSAGES_SELECT: &str = r#"SELECT m.message_id, m.source_event_order, m.kind, m.token_estimate, m.actor, m.harness,
              m.turn_id, m.deleted_at, e.recorded_at
       FROM message m JOIN event e ON e.event_order = m.source_event_order"#;

/// Default live-row filter (`includeDeleted !== true`).
#[allow(dead_code)]
const SQL_READ_MESSAGES_PRED_NOT_DELETED: &str = r#"m.deleted_at IS NULL"#;
/// Lower source-event-order bound (`opts.from`).
#[allow(dead_code)]
const SQL_READ_MESSAGES_PRED_FROM: &str = r#"m.source_event_order >= ?"#;
/// Upper source-event-order bound (`opts.to`).
#[allow(dead_code)]
const SQL_READ_MESSAGES_PRED_TO: &str = r#"m.source_event_order <= ?"#;
#[allow(dead_code)]
const SQL_READ_MESSAGES_ORDER_BY: &str = r#" ORDER BY m.source_event_order"#;
#[allow(dead_code)]
const SQL_READ_MESSAGES_LIMIT: &str = r#" LIMIT ?"#;

/// Dynamic IN clause for windowed block loads: PREFIX + `?, ?, …` + SUFFIX.
#[allow(dead_code)]
const SQL_READ_BLOCKS_FOR_IDS_PREFIX: &str = r#"SELECT message_id, block_type, content FROM message_block
       WHERE message_id IN ("#;

#[allow(dead_code)]
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

pub fn insert_message(_db: &Db, _row: &MessageRow) {
    todo!("phase 2")
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

struct RawBlockRow {
    message_id: String,
    block_type: String,
    content: String,
}

fn record_from_row(_row: &RawMessageRow, _blocks: Vec<Block>) -> MessageRecord {
    todo!("phase 2")
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

pub fn read_messages(_db: &Db, _opts: &MessageReadOptions) -> Vec<MessageRecord> {
    todo!("phase 2")
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
