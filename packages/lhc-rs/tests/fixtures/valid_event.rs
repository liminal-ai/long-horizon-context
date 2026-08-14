//! Typed `valid_event` helpers — faithful to TS `EventByKind<K>` /
//! `validEvent<K>(kind, overrides)`.
//!
//! Kind/payload mismatches are compile errors: a `ToolCallPayload` cannot be
//! placed in `UserPromptOverrides`. Invalid pairings require
//! [`valid_event_forced`] (serde Value cast-through), matching TS
//! `@ts-expect-error` + cast.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use lhc::intake_stream::{EventKind, MessageEventInput};

static KEY_COUNTER: AtomicU64 = AtomicU64::new(0);

// ── Typed payloads (per kind) ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPromptPayload {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssistantTextPayload {
    pub text: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api: Option<String>,
}

impl AssistantTextPayload {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssistantThinkingPayload {
    pub text: String,
    pub signature: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api: Option<String>,
}

impl AssistantThinkingPayload {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeNotePayload {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelChangePayload {
    pub previous_model: String,
    pub new_model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingLevelChangePayload {
    pub previous_level: String,
    pub new_level: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallPayload {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultPayload {
    pub tool_call_id: String,
    pub content: String,
    pub is_error: Option<bool>,
}

/// Host-observed turn outcome/timing on turn_end (schema v5). All optional.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnEndPayload {
    pub outcome: Option<String>,
    pub outcome_reason: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

/// Typed compact-continuation marker payload (contract-frozen literals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactContinuationMarkerPayload {
    pub kind: String,
    pub continuation_turn_id: String,
    pub cause: String,
    pub action: String,
    pub new_user_request: bool,
    pub wait_for_user: bool,
}

impl Default for CompactContinuationMarkerPayload {
    fn default() -> Self {
        Self {
            kind: "lhc.compact_continuation".into(),
            continuation_turn_id: "t-continuation".into(),
            cause: "context_compacted_task_in_progress".into(),
            action: "continue_existing_task".into(),
            new_user_request: false,
            wait_for_user: false,
        }
    }
}

// ── Typed overrides (per kind) ─────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct UserPromptOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<UserPromptPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct AssistantTextOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<AssistantTextPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct AssistantThinkingOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<AssistantThinkingPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeNoteOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<RuntimeNotePayload>,
}

#[derive(Debug, Clone, Default)]
pub struct ModelChangeOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<ModelChangePayload>,
}

#[derive(Debug, Clone, Default)]
pub struct ThinkingLevelChangeOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<ThinkingLevelChangePayload>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolCallOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<ToolCallPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolResultOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<ToolResultPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct TurnEndOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<TurnEndPayload>,
}

#[derive(Debug, Clone, Default)]
pub struct CompactContinuationMarkerOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<CompactContinuationMarkerPayload>,
}

// ── Sealed KindOverrides: kind → overrides type ────────────────────────────

mod sealed {
    pub trait Sealed {}
}

/// Maps a kind to its typed overrides. Only the matching override struct
/// implements this for each kind — payload mismatches are type errors.
pub trait KindOverrides: sealed::Sealed + Sized {
    const KIND: EventKind;

    fn into_parts(self) -> CommonOverrides;
}

#[derive(Debug, Clone, Default)]
pub struct CommonOverrides {
    pub idempotency_key: Option<String>,
    pub actor: Option<String>,
    pub harness: Option<String>,
    pub payload: Option<Map<String, Value>>,
}

macro_rules! impl_kind_overrides {
    ($ov:ty, $kind:ident, $payload_to_map:expr) => {
        impl sealed::Sealed for $ov {}
        impl KindOverrides for $ov {
            const KIND: EventKind = EventKind::$kind;

            fn into_parts(self) -> CommonOverrides {
                CommonOverrides {
                    idempotency_key: self.idempotency_key,
                    actor: self.actor,
                    harness: self.harness,
                    payload: self.payload.map($payload_to_map),
                }
            }
        }
    };
}

impl_kind_overrides!(UserPromptOverrides, UserPrompt, |p: UserPromptPayload| {
    json!({"text": p.text}).as_object().expect("object").clone()
});
impl_kind_overrides!(
    AssistantTextOverrides,
    AssistantText,
    |p: AssistantTextPayload| {
        // providerUsage is attached by mutating MessageEventInput.payload in
        // host-facts tests (optional schema v5 field; most fixtures omit it).
        let mut obj = json!({"text": p.text}).as_object().expect("object").clone();
        if let Some(provider) = p.provider {
            obj.insert("provider".into(), json!(provider));
        }
        if let Some(model) = p.model {
            obj.insert("model".into(), json!(model));
        }
        if let Some(api) = p.api {
            obj.insert("api".into(), json!(api));
        }
        obj
    }
);
impl_kind_overrides!(
    AssistantThinkingOverrides,
    AssistantThinking,
    |p: AssistantThinkingPayload| {
        let mut obj = json!({"text": p.text}).as_object().expect("object").clone();
        if let Some(signature) = p.signature {
            obj.insert("signature".into(), json!(signature));
        }
        if let Some(provider) = p.provider {
            obj.insert("provider".into(), json!(provider));
        }
        if let Some(model) = p.model {
            obj.insert("model".into(), json!(model));
        }
        if let Some(api) = p.api {
            obj.insert("api".into(), json!(api));
        }
        obj
    }
);
impl_kind_overrides!(
    RuntimeNoteOverrides,
    RuntimeNote,
    |p: RuntimeNotePayload| { json!({"text": p.text}).as_object().expect("object").clone() }
);
impl_kind_overrides!(
    ModelChangeOverrides,
    ModelChange,
    |p: ModelChangePayload| {
        json!({
            "previousModel": p.previous_model,
            "newModel": p.new_model,
        })
        .as_object()
        .expect("object")
        .clone()
    }
);
impl_kind_overrides!(
    ThinkingLevelChangeOverrides,
    ThinkingLevelChange,
    |p: ThinkingLevelChangePayload| {
        json!({
            "previousLevel": p.previous_level,
            "newLevel": p.new_level,
        })
        .as_object()
        .expect("object")
        .clone()
    }
);
impl_kind_overrides!(ToolCallOverrides, ToolCall, |p: ToolCallPayload| {
    json!({
        "toolCallId": p.tool_call_id,
        "toolName": p.tool_name,
        "arguments": Value::Object(p.arguments),
    })
    .as_object()
    .expect("object")
    .clone()
});
impl_kind_overrides!(ToolResultOverrides, ToolResult, |p: ToolResultPayload| {
    let mut map = Map::new();
    map.insert("toolCallId".into(), json!(p.tool_call_id));
    map.insert("content".into(), json!(p.content));
    if let Some(is_error) = p.is_error {
        map.insert("isError".into(), json!(is_error));
    } else {
        map.insert("isError".into(), json!(false));
    }
    map
});
impl_kind_overrides!(TurnEndOverrides, TurnEnd, |p: TurnEndPayload| {
    let mut map = Map::new();
    if let Some(outcome) = p.outcome {
        map.insert("outcome".into(), json!(outcome));
    }
    if let Some(reason) = p.outcome_reason {
        map.insert("outcomeReason".into(), json!(reason));
    }
    if let Some(started) = p.started_at {
        map.insert("startedAt".into(), json!(started));
    }
    if let Some(ended) = p.ended_at {
        map.insert("endedAt".into(), json!(ended));
    }
    map
});
impl_kind_overrides!(
    CompactContinuationMarkerOverrides,
    CompactContinuationMarker,
    |p: CompactContinuationMarkerPayload| {
        json!({
            "kind": p.kind,
            "continuationTurnId": p.continuation_turn_id,
            "cause": p.cause,
            "action": p.action,
            "newUserRequest": p.new_user_request,
            "waitForUser": p.wait_for_user,
        })
        .as_object()
        .expect("object")
        .clone()
    }
);

fn default_payload(kind: EventKind) -> Map<String, Value> {
    let value = match kind {
        EventKind::UserPrompt => json!({"text": "please read the file"}),
        EventKind::AssistantText => json!({"text": "here is what I found"}),
        EventKind::AssistantThinking => json!({"text": "considering the file contents"}),
        EventKind::RuntimeNote => json!({"text": "harness restarted mid-turn"}),
        EventKind::ModelChange => json!({"previousModel": "gpt-5", "newModel": "gpt-5.1"}),
        EventKind::ThinkingLevelChange => {
            json!({"previousLevel": "medium", "newLevel": "high"})
        }
        EventKind::ToolCall => json!({
            "toolCallId": "call-1",
            "toolName": "read_file",
            "arguments": {"path": "notes.txt"},
        }),
        EventKind::ToolResult => json!({
            "toolCallId": "call-1",
            "content": "contents of notes.txt",
            "isError": false,
        }),
        EventKind::CompactContinuationMarker => json!({
            "kind": "lhc.compact_continuation",
            "continuationTurnId": "t-continuation",
            "cause": "context_compacted_task_in_progress",
            "action": "continue_existing_task",
            "newUserRequest": false,
            "waitForUser": false,
        }),
        EventKind::TurnEnd => json!({}),
    };
    value.as_object().expect("payload object").clone()
}

fn assemble(kind: EventKind, parts: CommonOverrides) -> MessageEventInput {
    let n = KEY_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let base = json!({
        "eventKind": kind.as_str(),
        "idempotencyKey": parts
            .idempotency_key
            .unwrap_or_else(|| format!("fixture-key-{n}")),
        "actor": parts.actor.unwrap_or_else(|| "fixture-actor".into()),
        "harness": parts.harness.unwrap_or_else(|| "fixture-harness".into()),
        "payload": parts.payload.unwrap_or_else(|| default_payload(kind)),
    });
    serde_json::from_value(base).expect("valid_event builds MessageEventInput")
}

/// Type-safe builder: overrides dictate the kind (TS `validEvent<K>(kind, ov)`).
///
/// Call as `valid_event(kind::USER_PROMPT, UserPromptOverrides { … })`.
/// Passing a `ToolCallPayload` inside `UserPromptOverrides` is a type error.
pub fn valid_event<O: KindOverrides>(kind: KindToken<O>, overrides: O) -> MessageEventInput {
    let _ = kind;
    assemble(O::KIND, overrides.into_parts())
}

/// Zero-sized token tying an [`EventKind`] value to its [`KindOverrides`] type.
#[derive(Debug, Clone, Copy)]
pub struct KindToken<O: KindOverrides> {
    _marker: std::marker::PhantomData<O>,
}

impl<O: KindOverrides> KindToken<O> {
    pub const fn new() -> Self {
        Self {
            _marker: std::marker::PhantomData,
        }
    }
}

impl<O: KindOverrides> Default for KindToken<O> {
    fn default() -> Self {
        Self::new()
    }
}

/// Kind markers used as the first argument to [`valid_event`].
pub mod kind {
    use super::{
        AssistantTextOverrides, AssistantThinkingOverrides, CompactContinuationMarkerOverrides,
        KindToken, ModelChangeOverrides, RuntimeNoteOverrides, ThinkingLevelChangeOverrides,
        ToolCallOverrides, ToolResultOverrides, TurnEndOverrides, UserPromptOverrides,
    };

    pub const USER_PROMPT: KindToken<UserPromptOverrides> = KindToken::new();
    pub const ASSISTANT_TEXT: KindToken<AssistantTextOverrides> = KindToken::new();
    pub const ASSISTANT_THINKING: KindToken<AssistantThinkingOverrides> = KindToken::new();
    pub const RUNTIME_NOTE: KindToken<RuntimeNoteOverrides> = KindToken::new();
    pub const MODEL_CHANGE: KindToken<ModelChangeOverrides> = KindToken::new();
    pub const THINKING_LEVEL_CHANGE: KindToken<ThinkingLevelChangeOverrides> = KindToken::new();
    pub const TOOL_CALL: KindToken<ToolCallOverrides> = KindToken::new();
    pub const TOOL_RESULT: KindToken<ToolResultOverrides> = KindToken::new();
    pub const COMPACT_CONTINUATION_MARKER: KindToken<CompactContinuationMarkerOverrides> =
        KindToken::new();
    pub const TURN_END: KindToken<TurnEndOverrides> = KindToken::new();
}

/// Convenience: default-shaped event for a runtime [`EventKind`] (loops / batches).
pub fn valid_event_for_kind(kind: EventKind) -> MessageEventInput {
    match kind {
        EventKind::UserPrompt => valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
        EventKind::AssistantText => {
            valid_event(kind::ASSISTANT_TEXT, AssistantTextOverrides::default())
        }
        EventKind::AssistantThinking => valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides::default(),
        ),
        EventKind::RuntimeNote => valid_event(kind::RUNTIME_NOTE, RuntimeNoteOverrides::default()),
        EventKind::ModelChange => valid_event(kind::MODEL_CHANGE, ModelChangeOverrides::default()),
        EventKind::ThinkingLevelChange => valid_event(
            kind::THINKING_LEVEL_CHANGE,
            ThinkingLevelChangeOverrides::default(),
        ),
        EventKind::ToolCall => valid_event(kind::TOOL_CALL, ToolCallOverrides::default()),
        EventKind::ToolResult => valid_event(kind::TOOL_RESULT, ToolResultOverrides::default()),
        EventKind::CompactContinuationMarker => valid_event(
            kind::COMPACT_CONTINUATION_MARKER,
            CompactContinuationMarkerOverrides::default(),
        ),
        EventKind::TurnEnd => valid_event(kind::TURN_END, TurnEndOverrides::default()),
    }
}

/// Untyped cast-through for invalid kind/payload pairings (TS cast via unknown).
pub fn valid_event_forced(kind: EventKind, overrides: Value) -> MessageEventInput {
    let n = KEY_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let mut base = json!({
        "eventKind": kind.as_str(),
        "idempotencyKey": format!("fixture-key-{n}"),
        "actor": "fixture-actor",
        "harness": "fixture-harness",
        "payload": default_payload(kind),
    });
    if let Value::Object(ov) = overrides {
        if let Value::Object(ref mut map) = base {
            for (k, v) in ov {
                map.insert(k, v);
            }
        }
    }
    serde_json::from_value(base).expect("valid_event_forced builds MessageEventInput")
}

/// Alias matching the finding name.
pub fn valid_event_untyped(kind: EventKind, overrides: Value) -> MessageEventInput {
    valid_event_forced(kind, overrides)
}

pub fn valid_user_prompt(overrides: UserPromptOverrides) -> MessageEventInput {
    valid_event(kind::USER_PROMPT, overrides)
}
pub fn valid_assistant_text(overrides: AssistantTextOverrides) -> MessageEventInput {
    valid_event(kind::ASSISTANT_TEXT, overrides)
}
pub fn valid_assistant_thinking(overrides: AssistantThinkingOverrides) -> MessageEventInput {
    valid_event(kind::ASSISTANT_THINKING, overrides)
}
pub fn valid_runtime_note(overrides: RuntimeNoteOverrides) -> MessageEventInput {
    valid_event(kind::RUNTIME_NOTE, overrides)
}
pub fn valid_model_change(overrides: ModelChangeOverrides) -> MessageEventInput {
    valid_event(kind::MODEL_CHANGE, overrides)
}
pub fn valid_thinking_level_change(overrides: ThinkingLevelChangeOverrides) -> MessageEventInput {
    valid_event(kind::THINKING_LEVEL_CHANGE, overrides)
}
pub fn valid_tool_call(overrides: ToolCallOverrides) -> MessageEventInput {
    valid_event(kind::TOOL_CALL, overrides)
}
pub fn valid_tool_result(overrides: ToolResultOverrides) -> MessageEventInput {
    valid_event(kind::TOOL_RESULT, overrides)
}
pub fn valid_turn_end(overrides: TurnEndOverrides) -> MessageEventInput {
    valid_event(kind::TURN_END, overrides)
}
