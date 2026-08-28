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
    #[serde(rename = "compact_continuation_marker")]
    CompactContinuationMarker,
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
            EventKind::CompactContinuationMarker => "compact_continuation_marker",
            EventKind::TurnEnd => "turn_end",
        }
    }

    pub const ALL: [EventKind; 10] = [
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::AssistantThinking,
        EventKind::RuntimeNote,
        EventKind::ModelChange,
        EventKind::ThinkingLevelChange,
        EventKind::ToolCall,
        EventKind::ToolResult,
        EventKind::CompactContinuationMarker,
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

/// TS `{ text: string }` — user_prompt / runtime_note. `steer` is the
/// user_prompt-only host assertion (turn parts, Flow 7) that this prompt
/// arrived inside a run already in progress: it joins the open turn as a
/// member and is never a turn boundary. Validation rejects it on
/// runtime_note, so a stored note never carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPayload {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steer: Option<bool>,
}

/// Host-captured model identity for resume (PI same-model signature keep).
/// Opaque strings; SDK stores and exports verbatim — no identity matching here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantModelProvenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
}

/// TS `AssistantThinkingPayload` — text, optional opaque signature, optional provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantThinkingPayload {
    pub text: String,
    /// Opaque provider thinking token (Anthropic encrypted thinking, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    /// Host-supplied step index (schema v12, turn parts F2): the zero-based
    /// provider request/response cycle this message belongs to. Recorded
    /// verbatim, never inferred; NULL in storage when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
}

/// TS `AssistantTextPayload` — text, optional provider usage (schema v5), optional provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantTextPayload {
    pub text: String,
    /// Provider usage is the host's verbatim JSON object for one model call —
    /// no fixed column set, no interpretation inside LHC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_usage: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    /// Host-supplied step index (schema v12, turn parts F2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
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
    /// Host-supplied step index (schema v12, turn parts F2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
}

/// TS `{ toolCallId; content; isError? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultPayload {
    pub tool_call_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Host-supplied step index (schema v12): a tool_result carries the same
    /// index as its tool_call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
}

/// Typed compact-continuation marker payload (LIM-61 / LIM-63A).
/// Model-visible when served; LHC inspect/retrieval-visible; hidden from ordinary user chat.
/// Semantics fields are frozen by the compact-continuation contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationMarkerPayload {
    pub kind: String,
    pub continuation_turn_id: String,
    pub cause: String,
    pub action: String,
    pub new_user_request: bool,
    pub wait_for_user: bool,
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
        payload: AssistantThinkingPayload,
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
    #[serde(rename = "compact_continuation_marker", rename_all = "camelCase")]
    CompactContinuationMarker {
        idempotency_key: String,
        actor: String,
        harness: String,
        payload: CompactContinuationMarkerPayload,
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
            EventRecord::CompactContinuationMarker { .. } => EventKind::CompactContinuationMarker,
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
            | EventRecord::CompactContinuationMarker { event_order, .. }
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
            | EventRecord::CompactContinuationMarker { recorded_at, .. }
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
            | EventRecord::CompactContinuationMarker { actor, .. }
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
            | EventRecord::CompactContinuationMarker { harness, .. }
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
            | EventRecord::CompactContinuationMarker {
                idempotency_key, ..
            }
            | EventRecord::TurnEnd {
                idempotency_key, ..
            } => idempotency_key.as_str(),
        }
    }

    // Accessor arms are exhaustive on purpose (no `_`): a new event kind
    // must fail compilation here and force a mapping decision (brief rule 6).
    pub fn text_payload(&self) -> Option<&TextPayload> {
        match self {
            EventRecord::UserPrompt { payload, .. } | EventRecord::RuntimeNote { payload, .. } => {
                Some(payload)
            }
            EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::CompactContinuationMarker { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn assistant_thinking_payload(&self) -> Option<&AssistantThinkingPayload> {
        match self {
            EventRecord::AssistantThinking { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
            | EventRecord::CompactContinuationMarker { .. }
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
            | EventRecord::CompactContinuationMarker { .. }
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
            | EventRecord::CompactContinuationMarker { .. }
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
            | EventRecord::CompactContinuationMarker { .. }
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
            | EventRecord::CompactContinuationMarker { .. }
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
            | EventRecord::CompactContinuationMarker { .. }
            | EventRecord::TurnEnd { .. } => None,
        }
    }

    pub fn compact_continuation_marker_payload(&self) -> Option<&CompactContinuationMarkerPayload> {
        match self {
            EventRecord::CompactContinuationMarker { payload, .. } => Some(payload),
            EventRecord::UserPrompt { .. }
            | EventRecord::AssistantText { .. }
            | EventRecord::AssistantThinking { .. }
            | EventRecord::RuntimeNote { .. }
            | EventRecord::ModelChange { .. }
            | EventRecord::ThinkingLevelChange { .. }
            | EventRecord::ToolCall { .. }
            | EventRecord::ToolResult { .. }
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
            | EventRecord::ToolResult { .. }
            | EventRecord::CompactContinuationMarker { .. } => None,
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

pub use internal::pipeline::{LEGACY_KEY_PAGE_LIMIT, LEGACY_KEY_TOTAL_LOOKUP_CAP};

/// TS `ThreadFrontier` — constant-row durable position and identity for a
/// thread: everything a normal consumer needs to place itself in the archive
/// without reading any event payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadFrontier {
    pub thread_id: String,
    pub created_at: String,
    pub last_event_order: i64,
    pub last_recorded_at: Option<String>,
    pub view_boundary_position: i64,
}

/// TS `EventKeyPrefixCount` — one entry per distinct requested prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventKeyPrefixCount {
    pub prefix: String,
    pub exists: bool,
    pub count: i64,
}

/// TS `EventKeyReference` — one matched key with its archive position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventKeyReference {
    pub idempotency_key: String,
    pub event_order: i64,
}

/// TS `EventKeyPage` — one page of a legacy prefix walk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventKeyPage {
    pub keys: Vec<EventKeyReference>,
    /// Opaque continuation token; `None` when the walk stopped for good.
    pub cursor: Option<String>,
    /// True only when this page reached the end of the prefix.
    pub complete: bool,
    /// True when the total lookup cap stopped the walk short of the end.
    pub cap_exhausted: bool,
}

/// TS `EventKeyPageQuery` — options for one page of a legacy prefix walk.
///
/// TS additionally rejects a non-integer `limit`; a Rust `i64` cannot hold one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventKeyPageQuery {
    pub prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// TS `threadFrontier(threadRef)` — constant-row frontier. Never reads or
/// parses event payloads.
pub async fn thread_frontier(thread_ref: ThreadRef) -> OpResult<ThreadFrontier> {
    internal::pipeline::run_thread_frontier(thread_ref).await
}

/// TS `eventKeyPrefixCounts(threadRef, prefixes)`.
///
/// Existence and count for a finite, caller-supplied set of idempotency-key
/// prefixes, one indexed range query per distinct prefix. Results carry one
/// entry per *distinct* prefix in first-occurrence order (duplicates collapse),
/// so the result is O(input prefixes) rows. Overlapping prefixes are evaluated
/// independently — a key under both is counted by both. An empty input list
/// returns an empty result after the thread reference is resolved; an empty
/// prefix is an `invalid_bounds` caller error, because the whole archive is
/// `list_events`' explicit job.
pub async fn event_key_prefix_counts(
    thread_ref: ThreadRef,
    prefixes: &[String],
) -> OpResult<Vec<EventKeyPrefixCount>> {
    internal::pipeline::run_event_key_prefix_counts(thread_ref, prefixes).await
}

/// TS `listEventKeysByPrefix(threadRef, options)`.
///
/// Cursor-paginated key listing under one prefix — the lazy compatibility path
/// for legacy, ID-less occurrence resolution. Order is `idempotency_key`
/// ascending (the unique index's own order); events are append-only and keys
/// are immutable, so a page never repeats or reorders rows already returned.
///
/// `limit` defaults to and may not exceed [`LEGACY_KEY_PAGE_LIMIT`]; a larger
/// limit is refused with `invalid_bounds` rather than clamped.
/// [`LEGACY_KEY_TOTAL_LOOKUP_CAP`] bounds one walk: when it stops the walk
/// before the prefix ends, the page reports `cap_exhausted: true` and
/// `complete: false` with no cursor — a visible degraded result, never a
/// partial answer presented as the whole truth.
pub async fn list_event_keys_by_prefix(
    thread_ref: ThreadRef,
    options: EventKeyPageQuery,
) -> OpResult<EventKeyPage> {
    internal::pipeline::run_list_event_keys_by_prefix(thread_ref, options).await
}
