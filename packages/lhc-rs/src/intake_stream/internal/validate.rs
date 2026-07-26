//! Ported from packages/lhc/src/intake-stream/internal/validate.ts.
//!
//! Pure, whole-batch, three-layer closed validation. Effect Schema bindings are
//! represented as closed serde struct/enum surfaces (decoded-JSON data shapes)
//! analogous to Python TypedDict schema surfaces in
//! `packages/lhc-py/src/lhc/intake_stream/internal/validate.py`.
//!
//! REAL: `EVENT_KINDS`, `SERVER_GENERATED_FIELDS`, `DECODE_OPTIONS`, closed
//! payload/envelope schema type surfaces (`deny_unknown_fields`), and the
//! three-layer validation bodies (message strings match the Python reference).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult};

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
#[allow(dead_code)]
struct DecodeOptions {
    on_excess_property: &'static str,
    errors: &'static str,
}

#[allow(dead_code)]
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
#[allow(dead_code)]
struct ThreadRefByIdSchema {
    thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    registry_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct ThreadRefByPathSchema {
    file_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
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
#[allow(dead_code)]
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
// turn_end may be empty or carry only the optional host-observed outcome/timing
// fields (D1). assistant_text may carry optional providerUsage as a verbatim
// JSON object (no inner shape).

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct TextPayloadSchema {
    text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct AssistantTextPayloadSchema {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_usage: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct TurnEndPayloadSchema {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct ModelChangePayloadSchema {
    previous_model: String,
    new_model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct ThinkingLevelChangePayloadSchema {
    previous_level: String,
    new_level: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct ToolCallPayloadSchema {
    tool_call_id: String,
    tool_name: String,
    arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
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
    AssistantTextPayload,
    TurnEndPayload,
    ModelChangePayload,
    ThinkingLevelChangePayload,
    ToolCallPayload,
    ToolResultPayload,
}

// NOTE (Phase 2): Effect `ParseResult.ParseError` has no Rust counterpart.
// Closest stand-in: the structured decode failure object (Python `_ParseError`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParseError {
    path: Vec<String>,
    message: String,
}

fn first_issue(error: &ParseError) -> String {
    if error.path.is_empty() {
        return error.message.clone();
    }
    format!("\"{}\" {}", error.path.join("."), error.message)
}

/// Python `_actual` — Effect ArrayFormatter value rendering.
/// Hand-rolled JSON spelling for error-message prose (not persisted bytes).
fn actual(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::String(s) => json_string_literal(s),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => {
            let inner = items.iter().map(actual).collect::<Vec<_>>().join(",");
            format!("[{inner}]")
        }
        Value::Object(map) => {
            let inner = map
                .iter()
                .map(|(k, v)| format!("{}:{}", json_string_literal(k), actual(v)))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
    }
}

fn json_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn type_label(kind: &str) -> &str {
    // Effect ArrayFormatter type labels for the Expected { readonly ... } shape.
    match kind {
        "nonempty" => "minLength(1)",
        "string" => "string",
        "boolean" => "boolean",
        "record" => "{ readonly [x: string]: unknown }",
        "unknown" => "unknown",
        "event_kind" => "\"user_prompt\"",
        // Effect Schema.Literal("completed", "aborted") surface for turn_end.outcome.
        "outcome_literal" => "\"completed\" | \"aborted\"",
        other => other,
    }
}

/// `fields`: (name, kind, optional) — kinds match Python `_struct_issue`.
fn expected_shape(fields: &[(&str, &str, bool)]) -> String {
    let parts: Vec<String> = fields
        .iter()
        .map(|(name, kind, optional)| {
            let label = type_label(kind);
            if *optional {
                format!("readonly {name}?: {label} | undefined")
            } else {
                format!("readonly {name}: {label}")
            }
        })
        .collect();
    format!("{{ {} }}", parts.join("; "))
}

fn struct_issue(value: &Value, fields: &[(&str, &str, bool)]) -> Option<ParseError> {
    let expected = fields
        .iter()
        .map(|(name, _, _)| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(" | ");

    let Some(obj) = value.as_object() else {
        return Some(ParseError {
            path: Vec::new(),
            message: format!(
                "Expected {}, actual {}",
                expected_shape(fields),
                actual(value)
            ),
        });
    };

    let allowed: std::collections::HashSet<&str> =
        fields.iter().map(|(name, _, _)| *name).collect();
    for name in obj.keys() {
        if !allowed.contains(name.as_str()) {
            return Some(ParseError {
                path: vec![name.clone()],
                message: format!("is unexpected, expected: {expected}"),
            });
        }
    }

    for (name, kind, optional) in fields {
        let Some(item) = obj.get(*name) else {
            if !*optional {
                return Some(ParseError {
                    path: vec![(*name).to_string()],
                    message: "is missing".to_string(),
                });
            }
            continue;
        };

        match *kind {
            "string" => {
                if !item.is_string() {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!("Expected string, actual {}", actual(item)),
                    });
                }
            }
            "nonempty" => {
                let Some(s) = item.as_str() else {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!("Expected string, actual {}", actual(item)),
                    });
                };
                if s.is_empty() {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: "Expected a string at least 1 character(s) long, actual \"\""
                            .to_string(),
                    });
                }
            }
            "boolean" => {
                if !item.is_boolean() {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!("Expected boolean, actual {}", actual(item)),
                    });
                }
            }
            "record" => {
                if !item.is_object() {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!(
                            "Expected {{ readonly [x: string]: unknown }}, actual {}",
                            actual(item)
                        ),
                    });
                }
            }
            "event_kind" => {
                let ok = item
                    .as_str()
                    .is_some_and(|s| EVENT_KINDS.iter().any(|k| *k == s));
                if !ok {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!("Expected \"user_prompt\", actual {}", actual(item)),
                    });
                }
            }
            "outcome_literal" => {
                let ok = item
                    .as_str()
                    .is_some_and(|s| s == "completed" || s == "aborted");
                if !ok {
                    return Some(ParseError {
                        path: vec![(*name).to_string()],
                        message: format!(
                            "Expected \"completed\" | \"aborted\", actual {}",
                            actual(item)
                        ),
                    });
                }
            }
            "unknown" => {}
            _ => {}
        }
    }

    None
}

fn decode_issue(schema: DecodeSchema, value: &Value) -> Option<String> {
    let issue = match schema {
        DecodeSchema::ThreadRefById => struct_issue(
            value,
            &[
                ("threadId", "nonempty", false),
                ("registryPath", "string", true),
            ],
        ),
        DecodeSchema::ThreadRefByPath => struct_issue(value, &[("filePath", "nonempty", false)]),
        DecodeSchema::EventEnvelope => {
            // payload is Schema.Unknown: required key when present is never typed,
            // and a missing key is tolerated (presence checked after decode).
            struct_issue(
                value,
                &[
                    ("eventKind", "event_kind", false),
                    ("idempotencyKey", "nonempty", false),
                    ("actor", "nonempty", false),
                    ("harness", "nonempty", false),
                    ("payload", "unknown", true),
                ],
            )
        }
        DecodeSchema::TextPayload => struct_issue(value, &[("text", "string", false)]),
        DecodeSchema::AssistantTextPayload => struct_issue(
            value,
            &[("text", "string", false), ("providerUsage", "record", true)],
        ),
        DecodeSchema::TurnEndPayload => struct_issue(
            value,
            &[
                ("outcome", "outcome_literal", true),
                ("outcomeReason", "string", true),
                ("startedAt", "string", true),
                ("endedAt", "string", true),
            ],
        ),
        DecodeSchema::ModelChangePayload => struct_issue(
            value,
            &[
                ("previousModel", "nonempty", false),
                ("newModel", "nonempty", false),
            ],
        ),
        DecodeSchema::ThinkingLevelChangePayload => struct_issue(
            value,
            &[
                ("previousLevel", "nonempty", false),
                ("newLevel", "nonempty", false),
            ],
        ),
        DecodeSchema::ToolCallPayload => struct_issue(
            value,
            &[
                ("toolCallId", "nonempty", false),
                ("toolName", "nonempty", false),
                ("arguments", "record", false),
            ],
        ),
        DecodeSchema::ToolResultPayload => struct_issue(
            value,
            &[
                ("toolCallId", "nonempty", false),
                ("content", "string", false),
                ("isError", "boolean", true),
            ],
        ),
    };
    issue.as_ref().map(first_issue)
}

fn caller_error(reason: &str, event_index: Option<i64>) -> ErrorResult {
    ErrorResult {
        error_class: ErrorClass::CallerError,
        code: ErrorCode::InvalidEvent,
        reason: reason.to_string(),
        event_index,
    }
}

/// Envelope-level: the thread reference must decode against the closed union.
/// Returns `None` when valid.
///
/// TS `validateThreadRef(ref: unknown)` / Python `object` — accept `&Value`
/// so invalid envelopes remain expressible (not pre-narrowed to [`ThreadRef`]).
///
/// Effect Union with errors:"first" reports the first member's issue — mirror
/// by always surfacing the by-id branch failure text when neither member decodes.
pub fn validate_thread_ref(ref_value: &Value) -> Option<ErrorResult> {
    let Some(by_id) = decode_issue(DecodeSchema::ThreadRefById, ref_value) else {
        return None;
    };
    if decode_issue(DecodeSchema::ThreadRefByPath, ref_value).is_none() {
        return None;
    }
    Some(caller_error(
        &format!("envelope: invalid thread reference — {by_id}"),
        None,
    ))
}

/// Whole-batch validation: array order, first failure wins. Returns `None`
/// when every event is valid.
///
/// TS `validateEvents(events: unknown)` — `&Value` (JSON array) so malformed
/// batches remain expressible before typed narrowing.
pub fn validate_events(events: &Value) -> Option<ErrorResult> {
    let Some(arr) = events.as_array() else {
        return Some(caller_error("envelope: events must be a JSON array", None));
    };
    if arr.is_empty() {
        return Some(ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::EmptyBatch,
            reason: "envelope: events array is empty; a batch must carry at least one event"
                .to_string(),
            event_index: None,
        });
    }
    for (index, event) in arr.iter().enumerate() {
        if let Some(failure) = validate_one_event(event, index as i64) {
            return Some(failure);
        }
    }
    None
}

fn validate_one_event(event: &Value, index: i64) -> Option<ErrorResult> {
    let Some(record) = event.as_object() else {
        return Some(caller_error(
            "event: each event must be a JSON object",
            Some(index),
        ));
    };

    for field in SERVER_GENERATED_FIELDS {
        if record.contains_key(field) {
            return Some(caller_error(
                &format!(
                    "event: server-generated field \"{field}\" must not be supplied by the caller"
                ),
                Some(index),
            ));
        }
    }

    let kind = record.get("eventKind").and_then(|v| v.as_str());
    if let Some(kind) = kind {
        if !EVENT_KINDS.iter().any(|k| *k == kind) {
            return Some(caller_error(
                &format!("event: unknown event kind \"{kind}\""),
                Some(index),
            ));
        }
    }

    if let Some(issue) = decode_issue(DecodeSchema::EventEnvelope, event) {
        return Some(caller_error(&format!("event: {issue}"), Some(index)));
    }

    // Schema.Unknown tolerates a missing payload key; presence is layer 3.
    let payload = record.get("payload");
    let Some(payload) = payload.filter(|p| p.is_object()) else {
        return Some(caller_error(
            "event: payload must be a JSON object",
            Some(index),
        ));
    };

    let payload_schema = match kind {
        Some("turn_end") => DecodeSchema::TurnEndPayload,
        Some("assistant_text") => DecodeSchema::AssistantTextPayload,
        Some("tool_call") => DecodeSchema::ToolCallPayload,
        Some("tool_result") => DecodeSchema::ToolResultPayload,
        Some("model_change") => DecodeSchema::ModelChangePayload,
        Some("thinking_level_change") => DecodeSchema::ThinkingLevelChangePayload,
        _ => DecodeSchema::TextPayload,
    };
    if let Some(issue) = decode_issue(payload_schema, payload) {
        return Some(caller_error(&format!("payload: {issue}"), Some(index)));
    }
    None
}
