//! Ported from packages/lhc/src/messages/internal/project.ts.
//!
//! Event to message + typed blocks. Verbatim means payload fields are copied
//! into block content untouched: nothing here trims, normalizes, splits, or
//! summarizes. Token estimates come from the one counting util.

use serde_json::{Map, Value, json};

use crate::intake_stream::EventRecord;
use crate::messages::{Block, BlockType, RecordedEvent};
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::token_counting::estimate_tokens;

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedMessage {
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
}

/// turn_end is recorded in the event order but produces no message.
pub fn project_event(event: &RecordedEvent) -> Option<ProjectedMessage> {
    match event {
        EventRecord::UserPrompt { payload, .. }
        | EventRecord::AssistantText { payload, .. }
        | EventRecord::AssistantThinking { payload, .. }
        | EventRecord::RuntimeNote { payload, .. } => {
            let mut content = Map::new();
            content.insert("text".into(), json!(payload.text.clone()));
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::Text,
                    content,
                }],
                token_estimate: estimate_tokens(&payload.text),
            })
        }
        EventRecord::ModelChange { payload, .. } => {
            let mut content = Map::new();
            content.insert(
                "previousModel".into(),
                json!(payload.previous_model.clone()),
            );
            content.insert("newModel".into(), json!(payload.new_model.clone()));
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::ModelChange,
                    content,
                }],
                token_estimate: estimate_tokens(&format!(
                    "{} {}",
                    payload.previous_model, payload.new_model
                )),
            })
        }
        EventRecord::ThinkingLevelChange { payload, .. } => {
            let mut content = Map::new();
            content.insert(
                "previousLevel".into(),
                json!(payload.previous_level.clone()),
            );
            content.insert("newLevel".into(), json!(payload.new_level.clone()));
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::ThinkingLevelChange,
                    content,
                }],
                token_estimate: estimate_tokens(&format!(
                    "{} {}",
                    payload.previous_level, payload.new_level
                )),
            })
        }
        EventRecord::ToolCall { payload, .. } => {
            let mut content = Map::new();
            content.insert("toolCallId".into(), json!(payload.tool_call_id.clone()));
            content.insert("toolName".into(), json!(payload.tool_name.clone()));
            content.insert("arguments".into(), Value::Object(payload.arguments.clone()));
            // Tool calls count their serialized arguments.
            let args_json = js_json_stringify(&Value::Object(payload.arguments.clone()));
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::ToolCall,
                    content,
                }],
                token_estimate: estimate_tokens(&args_json),
            })
        }
        EventRecord::ToolResult { payload, .. } => {
            let mut content = Map::new();
            content.insert("toolCallId".into(), json!(payload.tool_call_id.clone()));
            content.insert("content".into(), json!(payload.content.clone()));
            content.insert("isError".into(), json!(payload.is_error.unwrap_or(false)));
            // Tool results count the full content string — the same string the
            // block carries in full.
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::ToolResult,
                    content,
                }],
                token_estimate: estimate_tokens(&payload.content),
            })
        }
        EventRecord::TurnEnd { .. } => None,
    }
}
