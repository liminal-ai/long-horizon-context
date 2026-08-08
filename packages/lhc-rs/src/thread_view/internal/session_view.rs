//! Ported from packages/lhc/src/thread-view/internal/session-view.ts.

use serde_json::{Map, Value};

use super::boundary::read_boundary_position;
use super::render::{
    TailRenderContext, is_empty_thinking_husk, tool_names_by_call_id, tool_result_session_content,
};
use super::snapshot::{
    TailMessageRow, read_tail_messages, read_thread_metadata, read_view_snapshot,
};
use crate::shared_tech::derivation::RenderingPartKind;
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{
    Band, SessionAssistantMessage, SessionAssistantPart, SessionAssistantPartType,
    SessionModelChangeEntry, SessionThinkingLevelChangeEntry, SessionThreadView,
    SessionThreadViewEntry, SessionThreadViewEntrySource, SessionThreadViewMessage,
    SessionThreadViewRuntimeEntry, SessionToolResultMessage, SessionUserMessage,
};

// ── session-view literals (byte-exact from TS) ───────────────────

pub(crate) const LITERAL_CONTEXT_PREFIX: &str = "[context · ";
pub(crate) const LITERAL_CONTEXT_MID: &str = "]\n";
pub(crate) const LITERAL_UNKNOWN_TOOL: &str = "unknown_tool";
pub(crate) const LITERAL_RUNTIME_NOTE_PREFIX: &str = "[runtime note] ";

fn block_content(message: &TailMessageRow) -> Map<String, Value> {
    message
        .blocks
        .first()
        .map(|b| b.content.clone())
        .unwrap_or_default()
}

fn text_of(message: &TailMessageRow) -> String {
    match block_content(message).get("text") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn entry_source(message: &TailMessageRow) -> SessionThreadViewEntrySource {
    SessionThreadViewEntrySource {
        message_id: message.message_id.clone(),
        idempotency_key: message.idempotency_key.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedModelRef {
    provider: String,
    model_id: String,
}

fn parse_model_ref(model: &str) -> Option<ParsedModelRef> {
    let slash = model.find('/')?;
    if slash == 0 || slash == model.len() - 1 {
        return None;
    }
    Some(ParsedModelRef {
        provider: model[..slash].to_string(),
        model_id: model[slash + 1..].to_string(),
    })
}

fn band_user_message(band: Band, rendered_text: &str) -> SessionThreadViewEntry {
    SessionThreadViewEntry::Message(SessionThreadViewMessage::User(SessionUserMessage {
        content: format!(
            "{LITERAL_CONTEXT_PREFIX}{}{LITERAL_CONTEXT_MID}{rendered_text}",
            band.as_str()
        ),
        source_messages: Vec::new(),
    }))
}

fn thinking_signature_of(message: &TailMessageRow) -> Option<String> {
    let content = block_content(message);
    let signature = content
        .get("signature")
        .or_else(|| content.get("thinkingSignature"));
    match signature {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn string_field(content: &Map<String, Value>, key: &str) -> Option<String> {
    match content.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ModelProvenance {
    provider: Option<String>,
    model: Option<String>,
    api: Option<String>,
}

/// Provider/model/api carried by ONE assistant row (thinking or text only).
fn row_provenance_of(row: &TailMessageRow) -> ModelProvenance {
    if row.kind != RenderingPartKind::AssistantThinking
        && row.kind != RenderingPartKind::AssistantText
    {
        return ModelProvenance::default();
    }
    let content = block_content(row);
    ModelProvenance {
        provider: string_field(&content, "provider"),
        model: string_field(&content, "model"),
        api: string_field(&content, "api"),
    }
}

/// True when both sides state a field and disagree — rows without provenance
/// never conflict (they inherit the group's).
fn provenance_conflicts(a: &ModelProvenance, b: &ModelProvenance) -> bool {
    fn differs(a: &Option<String>, b: &Option<String>) -> bool {
        matches!((a, b), (Some(x), Some(y)) if x != y)
    }
    differs(&a.provider, &b.provider) || differs(&a.model, &b.model) || differs(&a.api, &b.api)
}

/// First non-empty provider/model/api from grouped assistant rows (thinking or text).
fn model_provenance_of(rows: &[TailMessageRow]) -> ModelProvenance {
    let mut provider = None;
    let mut model = None;
    let mut api = None;
    for row in rows {
        if row.kind != RenderingPartKind::AssistantThinking
            && row.kind != RenderingPartKind::AssistantText
        {
            continue;
        }
        let content = block_content(row);
        if provider.is_none() {
            provider = string_field(&content, "provider");
        }
        if model.is_none() {
            model = string_field(&content, "model");
        }
        if api.is_none() {
            api = string_field(&content, "api");
        }
        if provider.is_some() && model.is_some() && api.is_some() {
            break;
        }
    }
    ModelProvenance {
        provider,
        model,
        api,
    }
}

fn assistant_part_of(message: &TailMessageRow) -> SessionAssistantPart {
    match message.kind {
        RenderingPartKind::AssistantThinking => SessionAssistantPart {
            type_: SessionAssistantPartType::Thinking,
            thinking: Some(text_of(message)),
            thinking_signature: thinking_signature_of(message),
            text: None,
            tool_call_id: None,
            tool_name: None,
            arguments: None,
        },
        RenderingPartKind::AssistantText => SessionAssistantPart {
            type_: SessionAssistantPartType::Text,
            text: Some(text_of(message)),
            thinking: None,
            thinking_signature: None,
            tool_call_id: None,
            tool_name: None,
            arguments: None,
        },
        RenderingPartKind::ToolCall => {
            let block = block_content(message);
            // Open runtime JSON block fields — TS defaults empty / unknown_tool / {}.
            let tool_call_id = match block.get("toolCallId") {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let tool_name = match block.get("toolName") {
                Some(Value::String(s)) => s.clone(),
                _ => LITERAL_UNKNOWN_TOOL.to_string(),
            };
            let arguments = match block.get("arguments") {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            SessionAssistantPart {
                type_: SessionAssistantPartType::ToolCall,
                tool_call_id: Some(tool_call_id),
                tool_name: Some(tool_name),
                arguments: Some(arguments),
                text: None,
                thinking: None,
                thinking_signature: None,
            }
        }
        // Remaining closed kinds are never passed into assistant_part_of by the
        // flush walk (TS same default empty text part if they were).
        RenderingPartKind::UserPrompt
        | RenderingPartKind::ToolResult
        | RenderingPartKind::RuntimeNote
        | RenderingPartKind::ModelChange
        | RenderingPartKind::ThinkingLevelChange => SessionAssistantPart {
            type_: SessionAssistantPartType::Text,
            text: Some(String::new()),
            thinking: None,
            thinking_signature: None,
            tool_call_id: None,
            tool_name: None,
            arguments: None,
        },
    }
}

fn tool_result_of(message: &TailMessageRow, ctx: &TailRenderContext) -> SessionThreadViewEntry {
    let block = block_content(message);
    let tool_call_id = match block.get("toolCallId") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let tool_name = ctx
        .tool_name_by_call_id
        .get(&tool_call_id)
        .cloned()
        .unwrap_or_else(|| LITERAL_UNKNOWN_TOOL.to_string());
    let is_error = matches!(block.get("isError"), Some(Value::Bool(true)));
    SessionThreadViewEntry::Message(SessionThreadViewMessage::ToolResult(
        SessionToolResultMessage {
            tool_call_id,
            tool_name: Some(tool_name),
            content: tool_result_session_content(message, ctx),
            is_error: if is_error { Some(true) } else { None },
            source_messages: vec![entry_source(message)],
        },
    ))
}

fn model_change_of(message: &TailMessageRow) -> Option<SessionThreadViewEntry> {
    let block = block_content(message);
    let new_model = match block.get("newModel") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    let parsed = parse_model_ref(new_model)?;
    Some(SessionThreadViewEntry::Runtime(
        SessionThreadViewRuntimeEntry::ModelChange(SessionModelChangeEntry {
            provider: parsed.provider,
            model_id: parsed.model_id,
            source_messages: vec![entry_source(message)],
        }),
    ))
}

fn thinking_level_change_of(message: &TailMessageRow) -> SessionThreadViewEntry {
    let block = block_content(message);
    let level = match block.get("newLevel") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    SessionThreadViewEntry::Runtime(SessionThreadViewRuntimeEntry::ThinkingLevelChange(
        SessionThinkingLevelChangeEntry {
            level,
            source_messages: vec![entry_source(message)],
        },
    ))
}

/// TS nested `flushAssistant` inside `tailEntriesOf`.
fn flush_assistant(
    pending: &mut Vec<SessionAssistantPart>,
    pending_sources: &mut Vec<SessionThreadViewEntrySource>,
    pending_rows: &mut Vec<TailMessageRow>,
    pending_provenance: &mut ModelProvenance,
    entries: &mut Vec<SessionThreadViewEntry>,
) {
    *pending_provenance = ModelProvenance::default();
    if pending.is_empty() {
        return;
    }
    let provenance = model_provenance_of(pending_rows);
    entries.push(SessionThreadViewEntry::Message(
        SessionThreadViewMessage::Assistant(SessionAssistantMessage {
            content: std::mem::take(pending),
            source_messages: std::mem::take(pending_sources),
            provider: provenance.provider,
            model: provenance.model,
            api: provenance.api,
        }),
    ));
    pending_rows.clear();
}

fn tail_entries_of(rows: &[TailMessageRow], boundary_position: i64) -> Vec<SessionThreadViewEntry> {
    let render_ctx = TailRenderContext {
        boundary_position,
        tool_name_by_call_id: tool_names_by_call_id(rows),
    };
    let mut entries: Vec<SessionThreadViewEntry> = Vec::new();
    let mut assistant_parts: Vec<SessionAssistantPart> = Vec::new();
    let mut assistant_sources: Vec<SessionThreadViewEntrySource> = Vec::new();
    let mut assistant_rows: Vec<TailMessageRow> = Vec::new();
    let mut assistant_provenance = ModelProvenance::default();

    for row in rows {
        if is_empty_thinking_husk(row) {
            continue;
        }
        match row.kind {
            RenderingPartKind::UserPrompt => {
                flush_assistant(
                    &mut assistant_parts,
                    &mut assistant_sources,
                    &mut assistant_rows,
                    &mut assistant_provenance,
                    &mut entries,
                );
                entries.push(SessionThreadViewEntry::Message(
                    SessionThreadViewMessage::User(SessionUserMessage {
                        content: text_of(row),
                        source_messages: vec![entry_source(row)],
                    }),
                ));
            }
            RenderingPartKind::AssistantThinking
            | RenderingPartKind::AssistantText
            | RenderingPartKind::ToolCall => {
                // Identity boundary: message-level provenance covers every
                // signature in the group, so rows captured under a different
                // model/provider start a new assistant entry — otherwise the
                // host identity gate would re-emit the wrong ciphertext (TS
                // session-view parity).
                let rp = row_provenance_of(row);
                if provenance_conflicts(&assistant_provenance, &rp) {
                    flush_assistant(
                        &mut assistant_parts,
                        &mut assistant_sources,
                        &mut assistant_rows,
                        &mut assistant_provenance,
                        &mut entries,
                    );
                }
                if assistant_provenance.provider.is_none() {
                    assistant_provenance.provider = rp.provider;
                }
                if assistant_provenance.model.is_none() {
                    assistant_provenance.model = rp.model;
                }
                if assistant_provenance.api.is_none() {
                    assistant_provenance.api = rp.api;
                }
                assistant_parts.push(assistant_part_of(row));
                assistant_sources.push(entry_source(row));
                assistant_rows.push(row.clone());
            }
            RenderingPartKind::ToolResult => {
                flush_assistant(
                    &mut assistant_parts,
                    &mut assistant_sources,
                    &mut assistant_rows,
                    &mut assistant_provenance,
                    &mut entries,
                );
                entries.push(tool_result_of(row, &render_ctx));
            }
            RenderingPartKind::ModelChange => {
                // Flush first: the change marks a boundary in time, so it
                // must not appear BEFORE assistant output that preceded it.
                flush_assistant(
                    &mut assistant_parts,
                    &mut assistant_sources,
                    &mut assistant_rows,
                    &mut assistant_provenance,
                    &mut entries,
                );
                if let Some(model_change) = model_change_of(row) {
                    entries.push(model_change);
                }
            }
            RenderingPartKind::ThinkingLevelChange => {
                flush_assistant(
                    &mut assistant_parts,
                    &mut assistant_sources,
                    &mut assistant_rows,
                    &mut assistant_provenance,
                    &mut entries,
                );
                entries.push(thinking_level_change_of(row));
            }
            RenderingPartKind::RuntimeNote => {
                // Same rendering as getLlmRequestContext: a labeled user line.
                flush_assistant(
                    &mut assistant_parts,
                    &mut assistant_sources,
                    &mut assistant_rows,
                    &mut assistant_provenance,
                    &mut entries,
                );
                entries.push(SessionThreadViewEntry::Message(
                    SessionThreadViewMessage::User(SessionUserMessage {
                        content: format!("{LITERAL_RUNTIME_NOTE_PREFIX}{}", text_of(row)),
                        source_messages: vec![entry_source(row)],
                    }),
                ));
            }
        }
    }
    flush_assistant(
        &mut assistant_parts,
        &mut assistant_sources,
        &mut assistant_rows,
        &mut assistant_provenance,
        &mut entries,
    );
    entries
}

pub fn build_session_thread_view(db: &Db) -> SessionThreadView {
    let thread_id = read_thread_metadata(db).thread_id;
    let snapshot = read_view_snapshot(db);
    let compact_point = snapshot.as_ref().map(|s| s.compact_point).unwrap_or(0);
    let boundary_position = read_boundary_position(db);
    let tail_rows = read_tail_messages(db, compact_point);

    let mut entries: Vec<SessionThreadViewEntry> = Vec::new();
    if let Some(ref snapshot) = snapshot {
        for band in &snapshot.bands {
            entries.push(band_user_message(band.band, &band.rendered_text));
        }
    }
    entries.extend(tail_entries_of(&tail_rows, boundary_position));
    SessionThreadView { thread_id, entries }
}
