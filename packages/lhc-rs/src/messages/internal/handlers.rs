//! Ported from packages/lhc/src/messages/internal/handlers.ts.
//!
//! Message-level derivation handlers: read the source message, optionally join
//! its call-id pair, and return derivation content through HandlerOutcome.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::shared_tech::derivation::{
    BoxFuture, CompletionTx, DerivationMetadata, HandlerDerivationWrite, HandlerOutcome,
    HandlerRunContext, InferenceRequestMessage, InferenceResult, ResolvedSdkConfig,
    SmoothPromptInput, SubjectKind, SummarizeToolResultInput, ToolOutcome, WorkHandler,
    WorkItemRef,
};
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::js_json::{js_char_codes, js_len, js_trim};
use crate::shared_tech::logging::{
    DerivationLogEntry, DerivationLogEventKind, DerivationLogTarget, LogEntry, LogLevel,
    append_derivation_log, write_log,
};
use crate::shared_tech::persist::{DbReadTransaction, DbTransaction};
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::tool_result_rendering::truncate_for_fallback;
use crate::shared_tech::work_queue::{WorkHandlerMap, WorkKind};

use super::classify_tool_result::{ToolResultClassificationInput, classify_tool_result};
use super::derivations::{MessageSource, find_paired_tool_call, read_message_source};
use super::outcome::{PairedResult, derive_tool_outcome};
use super::smoothing::clean_prompt;

/// TS `FORCE_TOOL_RESULT_SUMMARY_FALLBACK` — private.
const FORCE_TOOL_RESULT_SUMMARY_FALLBACK: bool = true;

fn source_damaged(reason: &str) -> HandlerOutcome {
    HandlerOutcome::Blocked {
        reason: format!("source_damaged: {reason}"),
    }
}

enum LoadSourceResult {
    Ok {
        message_id: String,
        source: MessageSource,
    },
    Err {
        outcome: HandlerOutcome,
    },
}

/// TS `loadSource` item: `{ sourceRef: Record<string, string> }` — narrower
/// than [`WorkItemRef`]; only `sourceRef` is in the helper contract.
struct LoadSourceItem {
    source_ref: HashMap<String, String>,
}

fn load_source(
    run: &HandlerRunContext,
    item: &LoadSourceItem,
    expected_kind: &str,
) -> LoadSourceResult {
    let Some(message_id) = item.source_ref.get("messageId").cloned() else {
        return LoadSourceResult::Err {
            outcome: source_damaged("work item carries no messageId"),
        };
    };
    // TS `openDb()` throws on infrastructure failure → handler threw / retryable.
    let db = match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let source = read_message_source(&db, &message_id);
    db.close();
    let Some(source) = source else {
        return LoadSourceResult::Err {
            outcome: source_damaged(&format!("message {message_id} not found")),
        };
    };
    if source.kind != expected_kind {
        return LoadSourceResult::Err {
            outcome: source_damaged(&format!(
                "message {message_id} is kind {}, expected {expected_kind}",
                source.kind
            )),
        };
    }
    LoadSourceResult::Ok { message_id, source }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SmoothedPromptDerivation {
    pub write: HandlerDerivationWrite,
    pub warning_log: Option<LogEntry>,
}

/// TS `/^\[[^\]]{1,80}\]$/` — `{1,80}` counts UTF-16 code units (JS regex),
/// not Rust scalar values. Astral chars are two units.
fn matches_marker_prompt_pattern(text: &str) -> bool {
    let units = js_char_codes(text);
    let len = js_len(text);
    if len < 3 || units.len() != len {
        return false;
    }
    if units[0] != b'[' as u16 || units[len - 1] != b']' as u16 {
        return false;
    }
    let inner_len = len - 2;
    if !(1..=80).contains(&inner_len) {
        return false;
    }
    !units[1..len - 1].contains(&(b']' as u16))
}

pub fn is_marker_prompt(text: &str) -> bool {
    matches_marker_prompt_pattern(js_trim(text))
}

/// TS `deriveSmoothedPrompt` — derivation write or inference failure.
pub enum DeriveSmoothedPromptResult {
    Derived(SmoothedPromptDerivation),
    InferenceFailed {
        reason: String,
        request_messages: Option<Vec<InferenceRequestMessage>>,
    },
}

pub async fn derive_smoothed_prompt(
    run: &HandlerRunContext,
    message_id: &str,
    text: &str,
) -> DeriveSmoothedPromptResult {
    let cleaned = clean_prompt(text);
    let cleaned_tokens = estimate_tokens(&cleaned);
    let guards = &run.config.guards.smoothed_prompt;
    if is_marker_prompt(&cleaned) || cleaned_tokens > guards.max_inference_tokens {
        return DeriveSmoothedPromptResult::Derived(SmoothedPromptDerivation {
            write: HandlerDerivationWrite {
                subject_kind: SubjectKind::Message,
                subject_id: message_id.to_string(),
                derivation_type: "smoothed_prompt".into(),
                content: cleaned,
                metadata: None,
                gaps: None,
            },
            warning_log: None,
        });
    }

    let result = (run.inference_callbacks.smooth_prompt)(SmoothPromptInput {
        text: cleaned.clone(),
    })
    .await;
    match result {
        InferenceResult::Err {
            reason,
            request_messages,
        } => DeriveSmoothedPromptResult::InferenceFailed {
            reason,
            request_messages,
        },
        InferenceResult::Ok {
            text: result_text,
            provenance,
            ..
        } => {
            let result_tokens = estimate_tokens(&result_text);
            if (result_tokens as f64) < guards.suspicious_output_ratio * (cleaned_tokens as f64) {
                return DeriveSmoothedPromptResult::Derived(SmoothedPromptDerivation {
                    write: HandlerDerivationWrite {
                        subject_kind: SubjectKind::Message,
                        subject_id: message_id.to_string(),
                        derivation_type: "smoothed_prompt".into(),
                        content: cleaned.clone(),
                        metadata: Some(DerivationMetadata {
                            outcome: None,
                            last_error: None,
                            discard_reason: Some("suspicious_output_ratio".into()),
                            fallback_floor: None,
                            fallback_used: None,
                            inference_attempted: None,
                            inference_succeeded: None,
                            size_disposition: None,
                            provenance: None,
                        }),
                        gaps: None,
                    },
                    warning_log: Some(LogEntry {
                        level: LogLevel::Warning,
                        message: "suspicious smoothed_prompt output discarded".into(),
                        derivation_type: Some("smoothed_prompt".into()),
                        subject_id: Some(message_id.to_string()),
                        reason: Some("suspicious_output_ratio".into()),
                        floor_used: Some(cleaned),
                    }),
                });
            }
            DeriveSmoothedPromptResult::Derived(SmoothedPromptDerivation {
                write: HandlerDerivationWrite {
                    subject_kind: SubjectKind::Message,
                    subject_id: message_id.to_string(),
                    derivation_type: "smoothed_prompt".into(),
                    content: result_text,
                    metadata: Some(DerivationMetadata {
                        outcome: None,
                        last_error: None,
                        discard_reason: None,
                        fallback_floor: None,
                        fallback_used: None,
                        inference_attempted: Some(true),
                        inference_succeeded: Some(true),
                        size_disposition: None,
                        provenance,
                    }),
                    gaps: None,
                },
                warning_log: None,
            })
        }
    }
}

fn source_ref_map(item: &WorkItemRef) -> HashMap<String, String> {
    item.source_ref
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn schedule_write_log(
    transaction: CompletionTx<'_>,
    thread_id: String,
    file_path: String,
    entry: LogEntry,
) {
    let path = transaction.db.path().to_string();
    (transaction.on_commit)(Box::new(move || {
        let opened = crate::shared_tech::storage::open_database(&path);
        if let OpResult::Ok { value: db } = opened {
            let txn = DbReadTransaction {
                db: &db,
                thread_id,
                file_path,
            };
            write_log(DbTransaction::Read(&txn), &entry);
            db.close();
        }
    }));
}

async fn smooth_prompt_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    let loaded = load_source(
        &run,
        &LoadSourceItem {
            source_ref: source_ref_map(&item),
        },
        "user_prompt",
    );
    let LoadSourceResult::Ok { message_id, source } = loaded else {
        let LoadSourceResult::Err { outcome } = loaded else {
            unreachable!()
        };
        return outcome;
    };
    let text = source
        .blocks
        .first()
        .and_then(|b| b.content.get("text"))
        .and_then(|v| v.as_str());
    let Some(text) = text else {
        return source_damaged(&format!("prompt {message_id} has no text block"));
    };
    let derived = derive_smoothed_prompt(&run, &message_id, text).await;
    match derived {
        DeriveSmoothedPromptResult::InferenceFailed {
            reason,
            request_messages,
        } => {
            let db = match (run.open_db)() {
                OpResult::Ok { value } => value,
                OpResult::Err { error } => panic!("{}", error.reason),
            };
            let txn = DbReadTransaction {
                db: &db,
                thread_id: run.thread_id.clone(),
                file_path: run.file_path.clone(),
            };
            let mut payload = Map::new();
            payload.insert("reason".into(), json!(reason.clone()));
            if let Some(msgs) = request_messages {
                payload.insert(
                    "requestMessages".into(),
                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                );
            }
            append_derivation_log(
                DbTransaction::Read(&txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Message,
                        subject_id: message_id,
                        derivation_type: "smoothed_prompt".into(),
                    },
                    event_kind: DerivationLogEventKind::InferenceFailed,
                    payload,
                },
            );
            db.close();
            HandlerOutcome::Failed { reason }
        }
        DeriveSmoothedPromptResult::Derived(derived) => {
            let thread_id = run.thread_id.clone();
            let file_path = run.file_path.clone();
            HandlerOutcome::Ok {
                derivations: Some(vec![derived.write]),
                on_applied: derived.warning_log.map(|entry| {
                    Box::new(move |transaction: CompletionTx<'_>| {
                        schedule_write_log(transaction, thread_id, file_path, entry);
                    }) as Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>
                }),
            }
        }
    }
}

pub fn tool_result_target_tokens(tokens: i64, config: &ResolvedSdkConfig) -> i64 {
    let tier = &config.tool_result;
    let ratio = if tokens <= tier.small_tier_tokens {
        tier.small_target_ratio
    } else {
        tier.mid_target_ratio
    };
    ((tokens as f64) * ratio).ceil().max(1.0) as i64
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultSummaryDerivation {
    pub write: HandlerDerivationWrite,
    pub request_messages: Option<Vec<InferenceRequestMessage>>,
    pub raw_response: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeriveToolResultSummaryInput {
    pub tool_name: String,
    pub tool_input: Option<Map<String, Value>>,
    pub content: String,
    pub outcome: ToolOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveToolResultSummaryOpts {
    pub use_inference: Option<bool>,
}

/// TS `deriveToolResultSummary` — derivation write or inference failure.
pub enum DeriveToolResultSummaryResult {
    Derived(ToolResultSummaryDerivation),
    InferenceFailed {
        reason: String,
        request_messages: Option<Vec<InferenceRequestMessage>>,
    },
}

pub async fn derive_tool_result_summary(
    run: &HandlerRunContext,
    message_id: &str,
    input: &DeriveToolResultSummaryInput,
    opts: Option<&DeriveToolResultSummaryOpts>,
) -> DeriveToolResultSummaryResult {
    let tokens = estimate_tokens(&input.content);
    let use_inference = opts
        .and_then(|o| o.use_inference)
        .unwrap_or(!FORCE_TOOL_RESULT_SUMMARY_FALLBACK);
    if !use_inference {
        return DeriveToolResultSummaryResult::Derived(ToolResultSummaryDerivation {
            write: HandlerDerivationWrite {
                subject_kind: SubjectKind::Message,
                subject_id: message_id.to_string(),
                derivation_type: "tool_result_summary".into(),
                content: truncate_for_fallback(&input.content),
                metadata: Some(DerivationMetadata {
                    outcome: Some(input.outcome),
                    last_error: None,
                    discard_reason: None,
                    fallback_floor: None,
                    fallback_used: None,
                    inference_attempted: None,
                    inference_succeeded: None,
                    size_disposition: None,
                    provenance: None,
                }),
                gaps: None,
            },
            request_messages: None,
            raw_response: None,
        });
    }
    if tokens <= run.config.tool_result.small_tier_tokens {
        return DeriveToolResultSummaryResult::Derived(ToolResultSummaryDerivation {
            write: HandlerDerivationWrite {
                subject_kind: SubjectKind::Message,
                subject_id: message_id.to_string(),
                derivation_type: "tool_result_summary".into(),
                content: input.content.clone(),
                metadata: Some(DerivationMetadata {
                    outcome: Some(input.outcome),
                    last_error: None,
                    discard_reason: None,
                    fallback_floor: None,
                    fallback_used: None,
                    inference_attempted: None,
                    inference_succeeded: None,
                    size_disposition: None,
                    provenance: None,
                }),
                gaps: None,
            },
            request_messages: None,
            raw_response: None,
        });
    }

    let target_tokens = tool_result_target_tokens(tokens, &run.config);
    let classification = classify_tool_result(&ToolResultClassificationInput {
        tool_name: input.tool_name.clone(),
        tool_input: input.tool_input.clone(),
        outcome: input.outcome,
        raw_output: input.content.clone(),
    });
    let result = (run.inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
        tool_name: input.tool_name.clone(),
        content: input.content.clone(),
        outcome: Some(input.outcome),
        target_tokens: Some(target_tokens),
        operation_class: Some(classification.operation_class),
        response_shape: Some(classification.response_shape),
        prompt_mode: Some(classification.prompt_mode),
        facts: Some(classification.facts),
    })
    .await;
    match result {
        InferenceResult::Err {
            reason,
            request_messages,
        } => DeriveToolResultSummaryResult::InferenceFailed {
            reason,
            request_messages,
        },
        InferenceResult::Ok {
            text,
            provenance,
            request_messages,
            raw_response,
        } => DeriveToolResultSummaryResult::Derived(ToolResultSummaryDerivation {
            write: HandlerDerivationWrite {
                subject_kind: SubjectKind::Message,
                subject_id: message_id.to_string(),
                derivation_type: "tool_result_summary".into(),
                content: text,
                metadata: Some(DerivationMetadata {
                    outcome: Some(input.outcome),
                    last_error: None,
                    discard_reason: None,
                    fallback_floor: None,
                    fallback_used: None,
                    inference_attempted: Some(true),
                    inference_succeeded: Some(true),
                    size_disposition: None,
                    provenance,
                }),
                gaps: None,
            },
            request_messages,
            raw_response,
        }),
    }
}

async fn tool_result_summary_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    let loaded = load_source(
        &run,
        &LoadSourceItem {
            source_ref: source_ref_map(&item),
        },
        "tool_result",
    );
    let LoadSourceResult::Ok { message_id, source } = loaded else {
        let LoadSourceResult::Err { outcome } = loaded else {
            unreachable!()
        };
        return outcome;
    };
    let block = source
        .blocks
        .first()
        .map(|b| &b.content)
        .cloned()
        .unwrap_or_default();
    let Some(content) = block
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return source_damaged(&format!(
            "tool result {message_id} has no tool_result block"
        ));
    };
    let paired_call = match block.get("toolCallId").and_then(|v| v.as_str()) {
        Some(tool_call_id) => match (run.open_db)() {
            OpResult::Ok { value: db } => {
                let paired = find_paired_tool_call(&db, tool_call_id);
                db.close();
                paired
            }
            OpResult::Err { error } => panic!("{}", error.reason),
        },
        None => None,
    };
    let tool_outcome = derive_tool_outcome(Some(PairedResult {
        is_error: block.get("isError") == Some(&Value::Bool(true)),
    }));
    let derived = derive_tool_result_summary(
        &run,
        &message_id,
        &DeriveToolResultSummaryInput {
            tool_name: paired_call
                .as_ref()
                .map(|c| c.tool_name.clone())
                .unwrap_or_else(|| "unknown_tool".into()),
            tool_input: paired_call.and_then(|c| c.tool_input),
            content,
            outcome: tool_outcome,
        },
        None,
    )
    .await;
    match derived {
        DeriveToolResultSummaryResult::InferenceFailed {
            reason,
            request_messages,
        } => {
            let db = match (run.open_db)() {
                OpResult::Ok { value } => value,
                OpResult::Err { error } => panic!("{}", error.reason),
            };
            let txn = DbReadTransaction {
                db: &db,
                thread_id: run.thread_id.clone(),
                file_path: run.file_path.clone(),
            };
            let mut payload = Map::new();
            payload.insert("reason".into(), json!(reason.clone()));
            if let Some(msgs) = request_messages {
                payload.insert(
                    "requestMessages".into(),
                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                );
            }
            append_derivation_log(
                DbTransaction::Read(&txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Message,
                        subject_id: message_id,
                        derivation_type: "tool_result_summary".into(),
                    },
                    event_kind: DerivationLogEventKind::InferenceFailed,
                    payload,
                },
            );
            db.close();
            HandlerOutcome::Failed { reason }
        }
        DeriveToolResultSummaryResult::Derived(derived) => {
            let inference_succeeded = derived
                .write
                .metadata
                .as_ref()
                .and_then(|m| m.inference_succeeded)
                == Some(true);
            let request_messages = derived.request_messages;
            let raw_response = derived.raw_response;
            let provenance = derived
                .write
                .metadata
                .as_ref()
                .and_then(|m| m.provenance.clone());
            let thread_id = run.thread_id.clone();
            let file_path = run.file_path.clone();
            let message_id_for_log = message_id.clone();
            HandlerOutcome::Ok {
                derivations: Some(vec![derived.write]),
                on_applied: if inference_succeeded {
                    Some(Box::new(move |transaction: CompletionTx<'_>| {
                        let path = transaction.db.path().to_string();
                        (transaction.on_commit)(Box::new(move || {
                            let opened = crate::shared_tech::storage::open_database(&path);
                            let OpResult::Ok { value: db } = opened else {
                                return;
                            };
                            let txn = DbReadTransaction {
                                db: &db,
                                thread_id,
                                file_path,
                            };
                            let mut payload = Map::new();
                            if let Some(provenance) = provenance {
                                payload.insert(
                                    "provenance".into(),
                                    serde_json::to_value(provenance).unwrap_or(Value::Null),
                                );
                            }
                            if let Some(msgs) = request_messages {
                                payload.insert(
                                    "requestMessages".into(),
                                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                                );
                            }
                            if let Some(raw) = raw_response {
                                payload.insert("rawResponse".into(), json!(raw));
                            }
                            append_derivation_log(
                                DbTransaction::Read(&txn),
                                &DerivationLogEntry {
                                    target: DerivationLogTarget {
                                        subject_kind: SubjectKind::Message,
                                        subject_id: message_id_for_log,
                                        derivation_type: "tool_result_summary".into(),
                                    },
                                    event_kind: DerivationLogEventKind::InferenceSucceeded,
                                    payload,
                                },
                            );
                            db.close();
                        }));
                    })
                        as Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>)
                } else {
                    None
                },
            }
        }
    }
}

/// Exact Arc identity for the PromptSmoothing map entry (private seam).
static SMOOTH_PROMPT_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { smooth_prompt_handler(run, item).await }) as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the ToolResultSummary map entry (private seam).
static TOOL_RESULT_SUMMARY_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { tool_result_summary_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// TS `messageWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>>`.
pub static MESSAGE_WORK_HANDLERS: LazyLock<WorkHandlerMap> = LazyLock::new(|| {
    let mut map: WorkHandlerMap = IndexMap::new();
    map.insert(
        WorkKind::PromptSmoothing,
        Arc::clone(&SMOOTH_PROMPT_WORK_HANDLER),
    );
    map.insert(
        WorkKind::ToolResultSummary,
        Arc::clone(&TOOL_RESULT_SUMMARY_WORK_HANDLER),
    );
    map
});

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn message_work_handlers_kinds_and_insertion_order() {
        let keys: Vec<_> = MESSAGE_WORK_HANDLERS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![WorkKind::PromptSmoothing, WorkKind::ToolResultSummary]
        );
        assert!(Arc::ptr_eq(
            MESSAGE_WORK_HANDLERS
                .get(&WorkKind::PromptSmoothing)
                .unwrap(),
            &*SMOOTH_PROMPT_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            MESSAGE_WORK_HANDLERS
                .get(&WorkKind::ToolResultSummary)
                .unwrap(),
            &*TOOL_RESULT_SUMMARY_WORK_HANDLER
        ));
    }
}
