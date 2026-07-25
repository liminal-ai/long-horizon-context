//! Ported from packages/lhc/src/turns/internal/chunk-recovery.ts.
//!
//! Compact-selection material for a chunk: ready stored summary content, or a
//! deterministic concat floor over live members when the summary is not ready.
//! Not a domain/crate-root export surface.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::tool_result_rendering::truncate_for_fallback;
use crate::turns::ChunkDeriveDerivationType;

const SQL_CHUNK_EXISTS: &str = r#"SELECT 1 FROM chunk WHERE chunk_id = ?"#;

const SQL_LIVE_CHUNK_MEMBERS: &str = r#"SELECT cm.turn_id FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx"#;

const SQL_TURN_MESSAGES: &str = r#"SELECT message_id, kind FROM message
     WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order"#;

const SQL_MESSAGE_BLOCK_CONTENT: &str =
    r#"SELECT content FROM message_block WHERE message_id = ? ORDER BY block_index"#;

const SQL_TURN_STATUS: &str =
    r#"SELECT status, closed_at_event_order FROM turns WHERE turn_id = ?"#;

const SQL_CHUNK_DERIVATION: &str = r#"SELECT state, content, reason FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?"#;

/// TS `CompactChunkMaterial` — tagged on `kind`. Private to turns (index imports
/// the type for `getChunkText` only; not a crate-root/sdk export).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompactChunkMaterial {
    #[serde(rename_all = "camelCase")]
    Ready { content: String },
    #[serde(rename_all = "camelCase")]
    Concat { content: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Blocked { reason: String },
}

/// JS `String(value ?? "")` for JSON-representable runtime values.
fn js_string_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => "false".to_string(),
        // For finite JSON numbers, JS `String(number)` and `JSON.stringify`
        // share the same number spelling. Reuse the crate's Node-compatible
        // lane so -0 and exponent thresholds do not drift through Rust Display.
        Some(Value::Number(n)) => js_json_stringify(&Value::Number(n.clone())),
        Some(Value::Array(items)) => {
            // Array.prototype.toString → join(",") with recursive ToString;
            // null/undefined elements become empty.
            items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => js_string_nullish(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(",")
        }
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// TS property read on a JSON.parse result cast to Record — live Node boxes
/// non-null scalars/arrays (missing keys → undefined) and throws on null.
fn js_prop<'a>(content: &'a Value, key: &str) -> Option<&'a Value> {
    match content {
        Value::Null => panic!("Cannot read properties of null (reading '{key}')"),
        Value::Object(map) => map.get(key),
        Value::Array(_) | Value::String(_) | Value::Number(_) | Value::Bool(_) => None,
    }
}

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_optional_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

/// TS `blockText` — open string `kind` (message.kind), so wildcard default OK.
fn block_text(kind: &str, content: &Value) -> String {
    match kind {
        "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note" => {
            match js_prop(content, "text") {
                Some(Value::String(text)) => text.clone(),
                _ => String::new(),
            }
        }
        "model_change" => {
            format!(
                "[model change] {} -> {}",
                js_string_nullish(js_prop(content, "previousModel")),
                js_string_nullish(js_prop(content, "newModel"))
            )
        }
        "thinking_level_change" => {
            format!(
                "[thinking level change] {} -> {}",
                js_string_nullish(js_prop(content, "previousLevel")),
                js_string_nullish(js_prop(content, "newLevel"))
            )
        }
        "tool_call" => {
            let name = match js_prop(content, "toolName") {
                Some(Value::String(s)) => s.as_str(),
                _ => "unknown_tool",
            };
            let args = match js_prop(content, "arguments") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(v) => v.clone(),
            };
            truncate_for_fallback(&format!(
                "[tool call · {name}] {}",
                js_json_stringify(&args)
            ))
        }
        "tool_result" => match js_prop(content, "content") {
            Some(Value::String(text)) => {
                format!("[tool result]\n{}", truncate_for_fallback(text))
            }
            _ => "[tool result]".to_string(),
        },
        _ => String::new(),
    }
}

fn stored_member_concat(db: &Db, chunk_id: &str) -> CompactChunkMaterial {
    let chunk = db
        .prepare(SQL_CHUNK_EXISTS)
        .get_params(&[SqlParam::from(chunk_id)]);
    if chunk.is_none() {
        return CompactChunkMaterial::Blocked {
            reason: format!("canonical record corrupt: chunk {chunk_id} not found"),
        };
    }

    let members = db
        .prepare(SQL_LIVE_CHUNK_MEMBERS)
        .all(&[SqlParam::from(chunk_id)]);
    if members.is_empty() {
        return CompactChunkMaterial::Blocked {
            reason: format!("canonical record corrupt: chunk {chunk_id} has no readable members"),
        };
    }

    let mut sections: Vec<String> = Vec::new();
    for member in &members {
        let turn_id = map_required_str(member, "turn_id");
        let turn = db
            .prepare(SQL_TURN_STATUS)
            .get_params(&[SqlParam::from(turn_id.as_str())]);
        let turn_ok = match &turn {
            Some(row) => {
                let status = map_required_str(row, "status");
                let closed = !matches!(row.get("closed_at_event_order"), None | Some(Value::Null));
                status == "closed" && closed
            }
            None => false,
        };
        if !turn_ok {
            return CompactChunkMaterial::Blocked {
                reason: format!(
                    "canonical record corrupt: chunk {chunk_id} member {turn_id} is unreadable"
                ),
            };
        }

        let messages = db
            .prepare(SQL_TURN_MESSAGES)
            .all(&[SqlParam::from(turn_id.as_str())]);
        let mut lines: Vec<String> = Vec::new();
        for message in messages {
            let kind = map_required_str(&message, "kind");
            let message_id = map_required_str(&message, "message_id");
            let blocks = db
                .prepare(SQL_MESSAGE_BLOCK_CONTENT)
                .all(&[SqlParam::from(message_id.as_str())]);
            for block in blocks {
                let content_raw = map_required_str(&block, "content");
                let content_value: Value = serde_json::from_str(&content_raw)
                    .unwrap_or_else(|err| panic!("message block content JSON: {err}"));
                // TS casts to Record but does not validate — scalar/array boxes
                // yield empty/default property reads; null throws on access.
                let text = block_text(&kind, &content_value);
                if !text.is_empty() {
                    lines.push(text);
                }
            }
        }
        sections.push(lines.join("\n"));
    }

    CompactChunkMaterial::Concat {
        content: sections.join("\n\n---\n\n"),
        reason: "not_ready".to_string(),
    }
}

pub fn compact_chunk_material_from_stored_members(
    db: &Db,
    chunk_id: &str,
    derivation_type: ChunkDeriveDerivationType,
) -> CompactChunkMaterial {
    let derivation_type_str = derivation_type.as_str();
    let row = db.prepare(SQL_CHUNK_DERIVATION).get_params(&[
        SqlParam::from(chunk_id),
        SqlParam::from(derivation_type_str),
    ]);
    if let Some(row) = &row {
        let state = map_required_str(row, "state");
        if state == "ready" {
            if let Some(content) = map_optional_str(row, "content") {
                return CompactChunkMaterial::Ready { content };
            }
        }
        if state == "blocked" {
            return CompactChunkMaterial::Blocked {
                reason: map_optional_str(row, "reason").unwrap_or_else(|| {
                    format!("{derivation_type_str} for chunk {chunk_id} is blocked")
                }),
            };
        }
    }

    let fallback = stored_member_concat(db, chunk_id);
    match fallback {
        CompactChunkMaterial::Concat { content, .. } => {
            let reason = match &row {
                None => "missing_derivation",
                Some(row) if map_required_str(row, "state") == "failed" => "failed_floor",
                Some(_) => "not_ready",
            };
            CompactChunkMaterial::Concat {
                content,
                reason: reason.to_string(),
            }
        }
        other => other,
    }
}
