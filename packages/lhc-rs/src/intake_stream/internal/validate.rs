//! Ported from packages/lhc/src/intake-stream/internal/validate.ts.
//!
//! Pure, whole-batch, three-layer closed validation. Effect Schema bindings are
//! represented as closed serde struct/enum surfaces (decoded-JSON data shapes)
//! analogous to Python TypedDict schema surfaces in
//! `packages/lhc-py/src/lhc/intake_stream/internal/validate.py`.
//!
//! REAL: `EVENT_KINDS`, `SERVER_GENERATED_FIELDS`, `DECODE_OPTIONS`, and the
//! closed payload/envelope schema type surfaces (`deny_unknown_fields`).
//!
//! Behavior bodies remain `todo!("phase 2")` — Rust Phase 1 brief. Ledger note:
//! Python later made decode bodies real; Rust keeps `todo` until Phase 2
//! (types-only here).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::errors::ErrorResult;

use super::super::EventKind;

/// TS `EVENT_KINDS` — closed kind vocabulary (exported from validate.ts).
pub const EVENT_KINDS: [&str; 9] = [
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "runtime_note",
    "model_change",
    "thinking_level_change",
    "tool_call",
    "tool_result",
    "turn_end",
];

/// Denied by name with their own reason string: the old MVP's
/// silent-root-field-drop bug class gets named when it appears.
const SERVER_GENERATED_FIELDS: [&str; 4] =
    ["eventOrder", "recordedAt", "threadEventId", "schemaVersion"];

/// TS: `const DECODE_OPTIONS = { onExcessProperty: "error", errors: "first" } as const;`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DecodeOptions {
    on_excess_property: &'static str,
    errors: &'static str,
}

const DECODE_OPTIONS: DecodeOptions = DecodeOptions {
    on_excess_property: "error",
    errors: "first",
};

// NOTE (Phase 2): Effect `Schema.String.pipe(Schema.minLength(1))` has no
// standalone Rust type without inventing a validation DSL — leave unbound.

// ── Layer 1 — envelope: thread reference shape, closed ─────────────
// NOTE (Phase 2): Effect Schema.Union decode order + NonEmptyString minLength(1)
// + onExcessProperty:"error" closedness are not expressed by structs alone.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadRefByIdSchema {
    thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    registry_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadRefByPathSchema {
    file_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum ThreadRefSchema {
    ById(ThreadRefByIdSchema),
    ByPath(ThreadRefByPathSchema),
}

// ── Layer 2 — event object: the five required fields, closed ───────
//
// TS: `payload: Schema.Unknown` — presence/shape are layer 3's job. Effect
// tolerates a missing payload key at layer 2 so the named layer-3 presence
// error can fire; Rust mirrors that with `Option<Value>` (missing → None).
// `deny_unknown_fields` closes the envelope (onExcessProperty:"error").

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventEnvelopeSchema {
    event_kind: EventKind,
    idempotency_key: String,
    actor: String,
    harness: String,
    /// Optional so a missing key reaches layer-3 presence (TS Schema.Unknown).
    #[serde(default)]
    payload: Option<Value>,
}

// ── Layer 3 — per-kind payload, closed ─────────────────────────────
// NOTE (Phase 2): NonEmptyString minLength(1) and onExcessProperty closedness
// are not expressed by structs alone — `deny_unknown_fields` covers excess keys.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextPayloadSchema {
    text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelChangePayloadSchema {
    previous_model: String,
    new_model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThinkingLevelChangePayloadSchema {
    previous_level: String,
    new_level: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolCallPayloadSchema {
    tool_call_id: String,
    tool_name: String,
    arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolResultPayloadSchema {
    tool_call_id: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
}

/// Closed schema targets for [`decode_issue`] (TS Effect Schema / Python TypedDict class).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodeSchema {
    ThreadRefById,
    ThreadRefByPath,
    EventEnvelope,
    TextPayload,
    ModelChangePayload,
    ThinkingLevelChangePayload,
    ToolCallPayload,
    ToolResultPayload,
}

// NOTE (Phase 2): Effect `ParseResult.ParseError` has no Rust counterpart.
// Closest stand-in: the structured decode failure object Phase 2 will produce.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParseError {
    path: Vec<String>,
    message: String,
}

fn first_issue(_error: &ParseError) -> String {
    todo!("phase 2")
}

fn decode_issue(_schema: DecodeSchema, _value: &Value) -> Option<String> {
    todo!("phase 2")
}

fn caller_error(_reason: &str, _event_index: Option<i64>) -> ErrorResult {
    todo!("phase 2")
}

/// Envelope-level: the thread reference must decode against the closed union.
/// Returns `None` when valid.
///
/// TS `validateThreadRef(ref: unknown)` / Python `object` — accept `&Value`
/// so invalid envelopes remain expressible (not pre-narrowed to [`ThreadRef`]).
pub fn validate_thread_ref(_ref: &Value) -> Option<ErrorResult> {
    todo!("phase 2")
}

/// Whole-batch validation: array order, first failure wins. Returns `None`
/// when every event is valid.
///
/// TS `validateEvents(events: unknown)` — `&Value` (JSON array) so malformed
/// batches remain expressible before typed narrowing.
pub fn validate_events(_events: &Value) -> Option<ErrorResult> {
    todo!("phase 2")
}

fn validate_one_event(_event: &Value, _index: i64) -> Option<ErrorResult> {
    todo!("phase 2")
}
