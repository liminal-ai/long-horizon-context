//! Ported from packages/lhc/src/messages/index.ts. Phase 1 skeleton.
//!
//! Wave 0 partial: internal exemplar. Wave 1 PARTIAL: Block / MessageRecord /
//! list surface that Wave 1 tests call. Wave 3 PARTIAL: MutationResult
//! contract types for lifecycle fixture collection. Full messages surface
//! lands in Wave 4.

pub mod internal;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::Derivation;
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::work_queue::WorkKind;
use crate::threads::ThreadRef;

use internal::cascade::CascadeClear;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

pub use internal::derive::{MessageDeriveDerivationType, MessageDeriveResult};

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

/// TS `messages.list` — PARTIAL stub (Wave 1 runtime-change / tool-result tests).
pub async fn list(
    _thread_ref: ThreadRef,
    _filter: Option<MessageListOptions>,
) -> OpResult<Vec<MessageRecord>> {
    todo!("phase 2")
}

/// TS `messages.derive` — PARTIAL stub (Wave 2 work-execution).
pub async fn derive(
    _thread_ref: ThreadRef,
    _message_ids: &[String],
) -> OpResult<Vec<MessageDeriveResult>> {
    todo!("phase 2")
}

/// TS `messages.edit` — PARTIAL stub (Wave 3 lifecycle types; body Wave 4).
pub async fn edit(_thread_ref: ThreadRef, _edit: EditInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}

/// TS `messages.remove` — PARTIAL stub (Wave 3 lifecycle types; body Wave 4).
pub async fn remove(_thread_ref: ThreadRef, _removal: RemoveInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}
