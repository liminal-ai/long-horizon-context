//! Ported from packages/lhc/src/messages/index.ts. Phase 1 skeleton.
//!
//! Full messages surface: types/constants REAL; every behavior body
//! `todo!("phase 2")`. CascadeClear stays private (Wave 3 ruling — no root
//! re-export); MutationResult embeds it.

pub mod internal;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::intake_stream::EventRecord;
use crate::shared_tech::derivation::{Derivation, DerivationReportEntry};
use crate::shared_tech::errors::{ErrorResult, OpResult};
use crate::shared_tech::persist::DbWriteTransaction;
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::{WorkItemRecord, WorkKind};
use crate::threads::ThreadRef;

use internal::cascade::CascadeClear;

pub use internal::derive::{MessageDeriveDerivationType, MessageDeriveResult};
pub use internal::smoothing::clean_prompt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    Text,
    ToolCall,
    ToolResult,
    ModelChange,
    ThinkingLevelChange,
}

impl BlockType {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockType::Text => "text",
            BlockType::ToolCall => "tool_call",
            BlockType::ToolResult => "tool_result",
            BlockType::ModelChange => "model_change",
            BlockType::ThinkingLevelChange => "thinking_level_change",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub block_type: BlockType,
    /// Per-kind shape as projected, verbatim source content.
    pub content: Map<String, Value>,
}

/// Message kinds are EventKind excluding turn_end (`Exclude<EventKind, "turn_end">`).
/// Exhaustive eight-variant closed vocab with byte-exact snake_case wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    UserPrompt,
    AssistantText,
    AssistantThinking,
    RuntimeNote,
    ModelChange,
    ThinkingLevelChange,
    ToolCall,
    ToolResult,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageKind::UserPrompt => "user_prompt",
            MessageKind::AssistantText => "assistant_text",
            MessageKind::AssistantThinking => "assistant_thinking",
            MessageKind::RuntimeNote => "runtime_note",
            MessageKind::ModelChange => "model_change",
            MessageKind::ThinkingLevelChange => "thinking_level_change",
            MessageKind::ToolCall => "tool_call",
            MessageKind::ToolResult => "tool_result",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub message_id: String,
    pub source_event_order: i64,
    pub kind: MessageKind,
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
    pub actor: String,
    pub harness: String,
    pub recorded_at: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

/// TS `RecordedEvent = EventRecord` — preserves kind→payload coupling.
pub type RecordedEvent = EventRecord;

/// TS non-null `MessageCreated` arm (`toolCallId` only for tool activity).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCreated {
    pub message_id: String,
    pub kind: MessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCreateResult {
    pub message: Option<MessageCreated>,
    pub queued_work: Vec<WorkItemRecord>,
}

const SQL_SELECT_THREAD_ID: &str = r#"SELECT thread_id FROM thread_metadata WHERE id = 1"#;

/// Cross-domain surface, called by intake-stream inside the batch transaction.
pub fn create(
    _transaction: &DbWriteTransaction,
    _recorded_event: &RecordedEvent,
    _turn_id: &str,
) -> MessageCreateResult {
    todo!("phase 2")
}

fn queue_message_work(
    _transaction: &DbWriteTransaction,
    _message: Option<&MessageCreated>,
) -> Vec<WorkItemRecord> {
    todo!("phase 2")
}

fn thread_not_found<T>(_file_path: &str) -> OpResult<T> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MessageListOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_deleted: Option<bool>,
}

fn invalid_bounds(_reason: &str) -> ErrorResult {
    todo!("phase 2")
}

fn validate_list_options(_opts: &MessageListOptions) -> Option<ErrorResult> {
    todo!("phase 2")
}

pub async fn list(
    _thread_ref: ThreadRef,
    _filter: Option<MessageListOptions>,
) -> OpResult<Vec<MessageRecord>> {
    todo!("phase 2")
}

/// In-transaction read for coordinators that already hold an open thread handle.
pub fn read_live_messages(_db: &Db) -> Vec<MessageRecord> {
    todo!("phase 2")
}

/// TS `MessageDetail` — canonical record + honest deleted + report derivations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
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
    pub derivations: Vec<DerivationReportEntry>,
}

pub async fn show(_thread_ref: ThreadRef, _message_id: &str) -> OpResult<MessageDetail> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageReportOpts {
    pub not_ready: Option<bool>,
    pub message_id: Option<String>,
}

pub async fn report(
    _thread_ref: ThreadRef,
    _opts: Option<MessageReportOpts>,
) -> OpResult<Vec<DerivationReportEntry>> {
    todo!("phase 2")
}

pub async fn derive(
    _thread_ref: ThreadRef,
    _message_ids: &[String],
) -> OpResult<Vec<MessageDeriveResult>> {
    todo!("phase 2")
}

/// TS `MutationResult.changed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationChanged {
    pub message_ids: Vec<String>,
    pub turn_ids: Vec<String>,
}

/// TS `MutationResult.queued` entry — distinct from cascade's internal queued shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationQueuedWork {
    pub work_item_id: String,
    pub kind: WorkKind,
}

/// TS `MutationResult` — shared edit/delete contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub changed: MutationChanged,
    pub cleared: Vec<CascadeClear>,
    pub dropped: Vec<CascadeClear>,
    pub queued: Vec<MutationQueuedWork>,
    pub superseded: Vec<String>,
}

/// TS `edit({ messageId, content })`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInput {
    pub message_id: String,
    pub content: String,
}

/// TS `remove({ messageId })`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveInput {
    pub message_id: String,
}

pub async fn edit(_thread_ref: ThreadRef, _edit: EditInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}

pub async fn remove(_thread_ref: ThreadRef, _removal: RemoveInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}
