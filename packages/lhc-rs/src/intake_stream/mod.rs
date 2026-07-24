//! Ported from packages/lhc/src/intake-stream/index.ts.
//! Phase 1 PARTIAL stub — EventKind / MessageEventInput / BatchResult / EventRecord
//! and message_events / list_events surfaces Wave 1 tests call.
//!
//! Judgment (validation.test.ts:36–52): TS builds invalid events via
//! `as unknown as MessageEventInput`. Python uses TypedDict dicts. Rust keeps
//! a camelCase wire struct with `event_kind: String` + `#[serde(flatten)] extra`
//! so the same invalid constructions compile without inventing APIs.
//!
//! `message_events` takes typed [`crate::threads::ThreadRef`] (faithful to TS).
//! Unknown-envelope probes exercise `ThreadRef`'s closed serde boundary
//! (`unknown_field`) — not a second public wire API.

pub mod internal;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::work_queue::{WorkKind, WorkOwner, WorkSourceRef};
use crate::threads::ThreadRef;

/// Closed event-kind vocabulary (derived from MessageEventInput in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EventKind {
    #[serde(rename = "user_prompt")]
    UserPrompt,
    #[serde(rename = "assistant_text")]
    AssistantText,
    #[serde(rename = "assistant_thinking")]
    AssistantThinking,
    #[serde(rename = "runtime_note")]
    RuntimeNote,
    #[serde(rename = "model_change")]
    ModelChange,
    #[serde(rename = "thinking_level_change")]
    ThinkingLevelChange,
    #[serde(rename = "tool_call")]
    ToolCall,
    #[serde(rename = "tool_result")]
    ToolResult,
    #[serde(rename = "turn_end")]
    TurnEnd,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::UserPrompt => "user_prompt",
            EventKind::AssistantText => "assistant_text",
            EventKind::AssistantThinking => "assistant_thinking",
            EventKind::RuntimeNote => "runtime_note",
            EventKind::ModelChange => "model_change",
            EventKind::ThinkingLevelChange => "thinking_level_change",
            EventKind::ToolCall => "tool_call",
            EventKind::ToolResult => "tool_result",
            EventKind::TurnEnd => "turn_end",
        }
    }

    pub const ALL: [EventKind; 9] = [
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::AssistantThinking,
        EventKind::RuntimeNote,
        EventKind::ModelChange,
        EventKind::ThinkingLevelChange,
        EventKind::ToolCall,
        EventKind::ToolResult,
        EventKind::TurnEnd,
    ];
}

/// Wire-shaped message event. See module judgment for stringly `event_kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEventInput {
    pub event_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub actor: String,
    pub harness: String,
    pub payload: Map<String, Value>,
    /// Unknown envelope fields (strictness probes) — TS cast-through-unknown.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchEventOutcome {
    Recorded,
    Skipped,
}

impl BatchEventOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            BatchEventOutcome::Recorded => "recorded",
            BatchEventOutcome::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchSkipReason {
    DuplicateIdempotencyKey,
}

impl BatchSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BatchSkipReason::DuplicateIdempotencyKey => "duplicate_idempotency_key",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEventResult {
    pub idempotency_key: String,
    pub outcome: BatchEventOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<BatchSkipReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnTransitionAction {
    Opened,
    Closed,
}

impl TurnTransitionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnTransitionAction::Opened => "opened",
            TurnTransitionAction::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTransition {
    pub action: TurnTransitionAction,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedWorkItem {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPosition {
    pub last_event_order: i64,
}

/// TS `BatchResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub events: Vec<BatchEventResult>,
    pub turn_transitions: Vec<TurnTransition>,
    pub queued_work: Vec<QueuedWorkItem>,
    pub thread_position: ThreadPosition,
}

/// TS `EventRecord = MessageEventInput & { eventOrder; recordedAt }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub event_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub actor: String,
    pub harness: String,
    pub payload: Map<String, Value>,
    pub event_order: i64,
    pub recorded_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// TS `messageEvents(threadRef, events)` — PARTIAL stub.
pub async fn message_events(
    _thread_ref: ThreadRef,
    _events: &[MessageEventInput],
) -> OpResult<BatchResult> {
    todo!("phase 2")
}

/// TS `listEvents` — PARTIAL stub.
pub async fn list_events(_thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
    todo!("phase 2")
}
