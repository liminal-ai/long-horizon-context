//! Ported from packages/lhc/src/intake-stream/index.ts.
//!
//! Wave 3 Phase 1: EventKind / MessageEventInput / BatchResult / EventRecord
//! and message_events / list_events surfaces (`todo!("phase 2")` bodies).
//!
//! Wave 1 broad write wire applies **only** to [`MessageEventInput`]
//! (validation.test.ts:36–52 — TS cast-through-unknown / stringly kind +
//! flatten extras). [`EventRecord`] is the closed read-back union: tagged on
//! `eventKind`, kind-exact payloads, no flatten extras.
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

// ── EventRecord payloads (kind-exact, closed) ──────────────────────

/// TS `{ text: string }` — user_prompt / assistant_thinking / runtime_note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPayload {
    pub text: String,
}

/// TS `AssistantTextPayload` — text plus optional verbatim provider usage (schema v5 / D1, D3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantTextPayload {
    pub text: String,
    /// Provider usage is the host's verbatim JSON object for one model call —
    /// no fixed column set, no interpretation inside LHC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_usage: Option<Map<String, Value>>,
}

/// TS `{ previousModel; newModel }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelChangePayload {
    pub previous_model: String,
    pub new_model: String,
}

/// TS `{ previousLevel; newLevel }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinkingLevelChangePayload {
    pub previous_level: String,
    pub new_level: String,
}

/// TS `{ toolCallId; toolName; arguments }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCallPayload {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: Map<String, Value>,
}

/// TS `{ toolCallId; content; isError? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultPayload {
    pub tool_call_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// Host-observed turn outcome on `turn_end` (schema v5 / D1, D2). Closed vocab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TurnOutcome {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "aborted")]
    Aborted,
}

impl TurnOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnOutcome::Completed => "completed",
            TurnOutcome::Aborted => "aborted",
        }
    }
}

/// Host-observed turn outcome/timing on turn_end (schema v5 / D1). All optional;
/// empty payload stays valid for hosts that do not report these facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnEndPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

/// TS `EventRecord = MessageEventInput & { eventOrder; recordedAt }`.
///
/// Closed tagged union on `eventKind` (snake_case values matching [`EventKind`]).
/// Not a Wave 1 broad wire — no flatten extras, kind-exact payloads only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "eventKind", deny_unknown_fields)]
pub enum EventRecord {
    #[serde(rename = "user_prompt", rename_all = "camelCase")]
    UserPrompt {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: TextPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "assistant_text", rename_all = "camelCase")]
    AssistantText {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: AssistantTextPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "assistant_thinking", rename_all = "camelCase")]
    AssistantThinking {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: TextPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "runtime_note", rename_all = "camelCase")]
    RuntimeNote {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: TextPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "model_change", rename_all = "camelCase")]
    ModelChange {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: ModelChangePayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "thinking_level_change", rename_all = "camelCase")]
    ThinkingLevelChange {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: ThinkingLevelChangePayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "tool_call", rename_all = "camelCase")]
    ToolCall {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: ToolCallPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "tool_result", rename_all = "camelCase")]
    ToolResult {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: ToolResultPayload,
        event_order: i64,
        recorded_at: String,
    },
    #[serde(rename = "turn_end", rename_all = "camelCase")]
    TurnEnd {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: TurnEndPayload,
        event_order: i64,
        recorded_at: String,
    },
}

impl EventRecord {
    pub fn event_kind(&self) -> EventKind {
        match self {
            EventRecord::UserPrompt { .. } => EventKind::UserPrompt,
            EventRecord::AssistantText { .. } => EventKind::AssistantText,
            EventRecord::AssistantThinking { .. } => EventKind::AssistantThinking,
            EventRecord::RuntimeNote { .. } => EventKind::RuntimeNote,
            EventRecord::ModelChange { .. } => EventKind::ModelChange,
            EventRecord::ThinkingLevelChange { .. } => EventKind::ThinkingLevelChange,
            EventRecord::ToolCall { .. } => EventKind::ToolCall,
            EventRecord::ToolResult { .. } => EventKind::ToolResult,
            EventRecord::TurnEnd { .. } => EventKind::TurnEnd,
        }
    }

    pub fn event_order(&self) -> i64 {
        match self {
            EventRecord::UserPrompt { event_order, .. }
            | EventRecord::AssistantText { event_order, .. }
            | EventRecord::AssistantThinking { event_order, .. }
            | EventRecord::RuntimeNote { event_order, .. }
            | EventRecord::ModelChange { event_order, .. }
            | EventRecord::ThinkingLevelChange { event_order, .. }
            | EventRecord::ToolCall { event_order, .. }
            | EventRecord::ToolResult { event_order, .. }
            | EventRecord::TurnEnd { event_order, .. } => *event_order,
        }
    }

    pub fn recorded_at(&self) -> &str {
        match self {
            EventRecord::UserPrompt { recorded_at, .. }
            | EventRecord::AssistantText { recorded_at, .. }
            | EventRecord::AssistantThinking { recorded_at, .. }
            | EventRecord::RuntimeNote { recorded_at, .. }
            | EventRecord::ModelChange { recorded_at, .. }
            | EventRecord::ThinkingLevelChange { recorded_at, .. }
            | EventRecord::ToolCall { recorded_at, .. }
            | EventRecord::ToolResult { recorded_at, .. }
            | EventRecord::TurnEnd { recorded_at, .. } => recorded_at.as_str(),
        }
    }

    pub fn actor(&self) -> &str {
        match self {
            EventRecord::UserPrompt { actor, .. }
            | EventRecord::AssistantText { actor, .. }
            | EventRecord::AssistantThinking { actor, .. }
            | EventRecord::RuntimeNote { actor, .. }
            | EventRecord::ModelChange { actor, .. }
            | EventRecord::ThinkingLevelChange { actor, .. }
            | EventRecord::ToolCall { actor, .. }
            | EventRecord::ToolResult { actor, .. }
            | EventRecord::TurnEnd { actor, .. } => actor.as_str(),
        }
    }

    pub fn harness(&self) -> &str {
        match self {
            EventRecord::UserPrompt { harness, .. }
            | EventRecord::AssistantText { harness, .. }
            | EventRecord::AssistantThinking { harness, .. }
            | EventRecord::RuntimeNote { harness, .. }
            | EventRecord::ModelChange { harness, .. }
            | EventRecord::ThinkingLevelChange { harness, .. }
            | EventRecord::ToolCall { harness, .. }
            | EventRecord::ToolResult { harness, .. }
            | EventRecord::TurnEnd { harness, .. } => harness.as_str(),
        }
    }

    pub fn idempotency_key(&self) -> &str {
        match self {
            EventRecord::UserPrompt {
                idempotency_key, ..
            }
            | EventRecord::AssistantText {
                idempotency_key, ..
            }
            | EventRecord::AssistantThinking {
                idempotency_key, ..
            }
            | EventRecord::RuntimeNote {
                idempotency_key, ..
            }
            | EventRecord::ModelChange {
                idempotency_key, ..
            }
            | EventRecord::ThinkingLevelChange {
                idempotency_key, ..
            }
            | EventRecord::ToolCall {
                idempotency_key, ..
            }
            | EventRecord::ToolResult {
                idempotency_key, ..
            }
            | EventRecord::TurnEnd {
                idempotency_key, ..
            } => idempotency_key.as_str(),
        }
    }

    // Accessor arms are exhaustive on purpose (no `_`): a tenth event kind
    // must fail compilation here and force a mapping decision (brief rule 6).
    pub fn text_payload(&self) -> Option<&TextPayload> {
        match self {
            EventRecord::UserPrompt { payload, .. }
            | EventRecord::AssistantThinking { payload, .. }
            | EventRecord::RuntimeNote { payload, .. } => Some(payload),
            EventRecord::AssistantText { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn assistant_text_payload(&self) -> Option<&AssistantTextPayload> {
        match self {
            EventRecord::AssistantText { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn model_change_payload(&self) -> Option<&ModelChangePayload> {
        match self {
            EventRecord::ModelChange { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn thinking_level_change_payload(&self) -> Option<&ThinkingLevelChangePayload> {
        match self {
            EventRecord::ThinkingLevelChange { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn tool_call_payload(&self) -> Option<&ToolCallPayload> {
        match self {
            EventRecord::ToolCall { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn tool_result_payload(&self) -> Option<&ToolResultPayload> {
        match self {
            EventRecord::ToolResult { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn turn_end_payload(&self) -> Option<&TurnEndPayload> {
        match self {
            EventRecord::TurnEnd { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. } => None,
        }
    }
}

/// TS `messageEvents(threadRef, events)`.
pub async fn message_events(
    thread_ref: ThreadRef,
    events: &[MessageEventInput],
) -> OpResult<BatchResult> {
    internal::pipeline::run_message_events(thread_ref, events, None).await
}

/// TS `listEvents`.
pub async fn list_events(thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
    internal::pipeline::run_list_events(thread_ref).await
}
