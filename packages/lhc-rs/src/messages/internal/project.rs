//! Ported from packages/lhc/src/messages/internal/project.ts.
//!
//! Event to message + typed blocks. Verbatim means payload fields are copied
//! into block content untouched: nothing here trims, normalizes, splits, or
//! summarizes. Token estimates come from the one counting util.

use serde_json::{Map, Value, json};

use crate::intake_stream::EventRecord;
use crate::messages::{Block, BlockType, RecordedEvent};
use crate::shared_tech::content_blocks::{blob_token_estimate, placeholder_text};
use crate::shared_tech::js_json::js_json_stringify;
use crate::shared_tech::token_counting::estimate_tokens;

// A message that carried content blocks beyond text keeps block 0 as its
// text-shaped form — the text of its text blocks with a short placeholder
// (type, media type, size, title) where each non-text block sits — so every
// reader of block 0 (bands, derivations, retrieval, token pricing) sees that
// the block existed without seeing its bytes. Rows 1..n hold the API blocks
// verbatim (blob payloads already replaced by references at intake), in order,
// so serving can replay the exact content array.
fn api_block_rows(blocks: Option<&[Map<String, Value>]>) -> Vec<Block> {
    blocks
        .unwrap_or(&[])
        .iter()
        .map(|block| Block {
            block_type: block
                .get("type")
                .and_then(Value::as_str)
                .and_then(BlockType::from_wire)
                .unwrap_or_else(|| panic!("validated API block carries a known type: {block:?}")),
            content: block.clone(),
        })
        .collect()
}

fn text_shaped(text: &str, blocks: Option<&[Map<String, Value>]>) -> String {
    match blocks {
        None | Some([]) => text.to_string(),
        Some(blocks) => blocks
            .iter()
            .map(|block| placeholder_text(&Value::Object(block.clone())))
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn blob_tokens(blocks: Option<&[Map<String, Value>]>) -> i64 {
    blocks
        .unwrap_or(&[])
        .iter()
        .map(|block| blob_token_estimate(&Value::Object(block.clone())))
        .sum()
}

fn single_block(block: Option<&Map<String, Value>>) -> Option<Vec<Map<String, Value>>> {
    block.map(|b| vec![b.clone()])
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedMessage {
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
}

/// turn_end is recorded in the event order but produces no message.
pub fn project_event(event: &RecordedEvent) -> Option<ProjectedMessage> {
    match event {
        EventRecord::UserPrompt { payload, .. } => {
            let text = text_shaped(&payload.text, payload.blocks.as_deref());
            let mut content = Map::new();
            content.insert("text".into(), json!(text.clone()));
            // The steer assertion rides the block so the record says why this
            // prompt sits mid-turn; text is what every reader consumes.
            if payload.steer == Some(true) {
                content.insert("steer".into(), json!(true));
            }
            let mut blocks = vec![Block {
                block_type: BlockType::Text,
                content,
            }];
            blocks.extend(api_block_rows(payload.blocks.as_deref()));
            Some(ProjectedMessage {
                blocks,
                token_estimate: estimate_tokens(&text) + blob_tokens(payload.blocks.as_deref()),
            })
        }
        EventRecord::RuntimeNote { payload, .. } => {
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
        // providerUsage rides the event payload and is stored as a message
        // column (not a block) — projection leaves text + optional provenance
        // in the block.
        EventRecord::AssistantText { payload, .. } => {
            let mut content = Map::new();
            content.insert("text".into(), json!(payload.text.clone()));
            if let Some(ref provider) = payload.provider {
                content.insert("provider".into(), json!(provider.clone()));
            }
            if let Some(ref model) = payload.model {
                content.insert("model".into(), json!(model.clone()));
            }
            if let Some(ref api) = payload.api {
                content.insert("api".into(), json!(api.clone()));
            }
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::Text,
                    content,
                }],
                token_estimate: estimate_tokens(&payload.text),
            })
        }
        EventRecord::AssistantThinking { payload, .. } => {
            // Verbatim payload copy: text always; signature + model identity when sent.
            let mut content = Map::new();
            content.insert("text".into(), json!(payload.text.clone()));
            if let Some(ref signature) = payload.signature {
                content.insert("signature".into(), json!(signature.clone()));
            }
            if let Some(ref provider) = payload.provider {
                content.insert("provider".into(), json!(provider.clone()));
            }
            if let Some(ref model) = payload.model {
                content.insert("model".into(), json!(model.clone()));
            }
            if let Some(ref api) = payload.api {
                content.insert("api".into(), json!(api.clone()));
            }
            // Count signature bytes too — when served back to the provider they sit in
            // the live context window (the fable live-vs-LHC token gap).
            let estimate_source = match payload.signature.as_deref() {
                Some(sig) if !sig.is_empty() => format!("{}{}", payload.text, sig),
                _ => payload.text.clone(),
            };
            let mut blocks = vec![Block {
                block_type: BlockType::Text,
                content,
            }];
            let single = single_block(payload.block.as_ref());
            blocks.extend(api_block_rows(single.as_deref()));
            Some(ProjectedMessage {
                blocks,
                token_estimate: estimate_tokens(&estimate_source),
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
            let mut blocks = vec![Block {
                block_type: BlockType::ToolCall,
                content,
            }];
            let single = single_block(payload.block.as_ref());
            blocks.extend(api_block_rows(single.as_deref()));
            Some(ProjectedMessage {
                blocks,
                token_estimate: estimate_tokens(&args_json),
            })
        }
        EventRecord::ToolResult { payload, .. } => {
            let text = text_shaped(&payload.content, payload.blocks.as_deref());
            let mut content = Map::new();
            content.insert("toolCallId".into(), json!(payload.tool_call_id.clone()));
            content.insert("content".into(), json!(text.clone()));
            content.insert("isError".into(), json!(payload.is_error.unwrap_or(false)));
            let mut blocks = vec![Block {
                block_type: BlockType::ToolResult,
                content,
            }];
            blocks.extend(api_block_rows(payload.blocks.as_deref()));
            // Tool results count the full text-shaped content — the same string
            // block 0 carries in full — plus the blob estimate of any nested
            // image or document the text cannot see.
            Some(ProjectedMessage {
                blocks,
                token_estimate: estimate_tokens(&text) + blob_tokens(payload.blocks.as_deref()),
            })
        }
        EventRecord::CompactContinuationMarker { payload, .. } => {
            // Typed marker: model-visible when served; not ordinary user chat.
            // Token estimate covers the stable model-facing instruction text.
            let mut content = Map::new();
            content.insert("kind".into(), json!(payload.kind.clone()));
            content.insert(
                "continuationTurnId".into(),
                json!(payload.continuation_turn_id.clone()),
            );
            content.insert("cause".into(), json!(payload.cause.clone()));
            content.insert("action".into(), json!(payload.action.clone()));
            content.insert("newUserRequest".into(), json!(payload.new_user_request));
            content.insert("waitForUser".into(), json!(payload.wait_for_user));
            let model_facing = [
                "[compact continuation]",
                &format!("cause={}", payload.cause),
                &format!("action={}", payload.action),
                "newUserRequest=false",
                "waitForUser=false",
                &format!("continuationTurnId={}", payload.continuation_turn_id),
            ]
            .join(" ");
            Some(ProjectedMessage {
                blocks: vec![Block {
                    block_type: BlockType::CompactContinuationMarker,
                    content,
                }],
                token_estimate: estimate_tokens(&model_facing),
            })
        }
        EventRecord::TurnEnd { .. } => None,
    }
}
