//! Ported from packages/lhc/src/messages/index.ts.
//!
//! Wave 3: `create` / `list` (+ validators) and the helpers they need.
//! CascadeClear stays private (Wave 3 ruling — no root re-export);
//! MutationResult embeds it. Remaining surface bodies stay Phase 2.

pub mod internal;

use std::panic::AssertUnwindSafe;

use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::intake_stream::{EventKind, EventRecord};
use std::path::Path;
use std::sync::Arc;

use crate::shared_tech::context::resolve_instance_config;
use crate::shared_tech::derivation::{
    Derivation, DerivationReportEntry, HandlerRunContext, SubjectKind,
};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::persist::{
    DbWriteTransaction, create_db_read_transaction, create_db_write_transaction,
};
use crate::shared_tech::storage::{Db, open_database};
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef,
    enqueue,
};
use crate::threads::{ThreadRef, open_thread_database, resolve_thread_ref};

use internal::cascade::{CascadeClear, cascade_from_message, cascade_message_delete};
use internal::derivations::{
    MessageReportOptions, read_message_derivations, report_message_derivations,
};
use internal::derive::derive_message_in_thread;
use internal::project::project_event;
use internal::store::{
    MessageReadOptions, MessageRow, apply_message_edit, insert_message, mark_message_deleted,
    read_message_by_id, read_messages, read_mutable_message,
};
use internal::work::{MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS};

pub use internal::derive::{MessageDeriveDerivationType, MessageDeriveResult};
pub use internal::smoothing::clean_prompt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    Text,
    ToolCall,
    ToolResult,
    ModelChange,
    ThinkingLevelChange,
    CompactContinuationMarker,
    // Messages API block names for the content blocks a message carried beyond
    // its text (rows 1..n; block 0 is always the text-shaped projection). TS
    // `BlockType = … | ApiBlockType`; `text` and `tool_result` share the
    // LHC spelling above. See shared_tech/content_blocks.rs.
    Image,
    Document,
    ToolUse,
    Thinking,
    RedactedThinking,
    ServerToolUse,
    WebSearchToolResult,
    WebFetchToolResult,
    CodeExecutionToolResult,
    BashCodeExecutionToolResult,
    TextEditorCodeExecutionToolResult,
    ToolSearchToolResult,
    SearchResult,
    ContainerUpload,
    ToolReference,
}

impl BlockType {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockType::Text => "text",
            BlockType::ToolCall => "tool_call",
            BlockType::ToolResult => "tool_result",
            BlockType::ModelChange => "model_change",
            BlockType::ThinkingLevelChange => "thinking_level_change",
            BlockType::CompactContinuationMarker => "compact_continuation_marker",
            BlockType::Image => "image",
            BlockType::Document => "document",
            BlockType::ToolUse => "tool_use",
            BlockType::Thinking => "thinking",
            BlockType::RedactedThinking => "redacted_thinking",
            BlockType::ServerToolUse => "server_tool_use",
            BlockType::WebSearchToolResult => "web_search_tool_result",
            BlockType::WebFetchToolResult => "web_fetch_tool_result",
            BlockType::CodeExecutionToolResult => "code_execution_tool_result",
            BlockType::BashCodeExecutionToolResult => "bash_code_execution_tool_result",
            BlockType::TextEditorCodeExecutionToolResult => {
                "text_editor_code_execution_tool_result"
            }
            BlockType::ToolSearchToolResult => "tool_search_tool_result",
            BlockType::SearchResult => "search_result",
            BlockType::ContainerUpload => "container_upload",
            BlockType::ToolReference => "tool_reference",
        }
    }

    /// Every wire spelling, LHC's own kinds and the API block names alike.
    pub const ALL: [BlockType; 21] = [
        BlockType::Text,
        BlockType::ToolCall,
        BlockType::ToolResult,
        BlockType::ModelChange,
        BlockType::ThinkingLevelChange,
        BlockType::CompactContinuationMarker,
        BlockType::Image,
        BlockType::Document,
        BlockType::ToolUse,
        BlockType::Thinking,
        BlockType::RedactedThinking,
        BlockType::ServerToolUse,
        BlockType::WebSearchToolResult,
        BlockType::WebFetchToolResult,
        BlockType::CodeExecutionToolResult,
        BlockType::BashCodeExecutionToolResult,
        BlockType::TextEditorCodeExecutionToolResult,
        BlockType::ToolSearchToolResult,
        BlockType::SearchResult,
        BlockType::ContainerUpload,
        BlockType::ToolReference,
    ];

    /// Wire spelling → block type (`block_type` column, API `type` names).
    pub fn from_wire(wire: &str) -> Option<BlockType> {
        BlockType::ALL.into_iter().find(|b| b.as_str() == wire)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub block_type: BlockType,
    /// Per-kind shape as projected, verbatim source content.
    pub content: Map<String, Value>,
}

/// Message kinds are EventKind excluding turn_end (`Exclude<EventKind, "turn_end">`).
/// Exhaustive nine-variant closed vocab with byte-exact snake_case wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    UserPrompt,
    AssistantText,
    AssistantThinking,
    RuntimeNote,
    ModelChange,
    ThinkingLevelChange,
    ToolCall,
    ToolResult,
    CompactContinuationMarker,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageKind::UserPrompt => "user_prompt",
            MessageKind::AssistantText => "assistant_text",
            MessageKind::AssistantThinking => "assistant_thinking",
            MessageKind::RuntimeNote => "runtime_note",
            MessageKind::ModelChange => "model_change",
            MessageKind::ThinkingLevelChange => "thinking_level_change",
            MessageKind::ToolCall => "tool_call",
            MessageKind::ToolResult => "tool_result",
            MessageKind::CompactContinuationMarker => "compact_continuation_marker",
        }
    }

    /// Message kinds excluding turn_end (9 variants).
    pub const ALL: [MessageKind; 9] = [
        MessageKind::UserPrompt,
        MessageKind::AssistantText,
        MessageKind::AssistantThinking,
        MessageKind::RuntimeNote,
        MessageKind::ModelChange,
        MessageKind::ThinkingLevelChange,
        MessageKind::ToolCall,
        MessageKind::ToolResult,
        MessageKind::CompactContinuationMarker,
    ];
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub message_id: String,
    pub source_event_order: i64,
    pub kind: MessageKind,
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
    pub actor: String,
    pub harness: String,
    pub recorded_at: String,
    pub turn_id: String,
    // Host-observed provider usage from assistant_text (schema v5). Absent when
    // the source event did not carry it (other kinds, pre-v5 rows, hosts that omit).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_usage: Option<Map<String, Value>>,
    // Host-supplied step index (schema v12). Absent when the source event did
    // not carry it; never inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

/// TS `RecordedEvent = EventRecord` — preserves kind→payload coupling.
pub type RecordedEvent = EventRecord;

/// TS non-null `MessageCreated` arm (`toolCallId` only for tool activity).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCreated {
    pub message_id: String,
    pub kind: MessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCreateResult {
    pub message: Option<MessageCreated>,
    pub queued_work: Vec<WorkItemRecord>,
}

#[allow(dead_code)]
const SQL_SELECT_THREAD_ID: &str = r#"SELECT thread_id FROM thread_metadata WHERE id = 1"#;

fn message_kind_from_event(kind: EventKind) -> MessageKind {
    match kind {
        EventKind::UserPrompt => MessageKind::UserPrompt,
        EventKind::AssistantText => MessageKind::AssistantText,
        EventKind::AssistantThinking => MessageKind::AssistantThinking,
        EventKind::RuntimeNote => MessageKind::RuntimeNote,
        EventKind::ModelChange => MessageKind::ModelChange,
        EventKind::ThinkingLevelChange => MessageKind::ThinkingLevelChange,
        EventKind::ToolCall => MessageKind::ToolCall,
        EventKind::ToolResult => MessageKind::ToolResult,
        EventKind::CompactContinuationMarker => MessageKind::CompactContinuationMarker,
        EventKind::TurnEnd => panic!("turn_end has no message kind"),
    }
}

fn event_kind_for_message(kind: MessageKind) -> EventKind {
    match kind {
        MessageKind::UserPrompt => EventKind::UserPrompt,
        MessageKind::AssistantText => EventKind::AssistantText,
        MessageKind::AssistantThinking => EventKind::AssistantThinking,
        MessageKind::RuntimeNote => EventKind::RuntimeNote,
        MessageKind::ModelChange => EventKind::ModelChange,
        MessageKind::ThinkingLevelChange => EventKind::ThinkingLevelChange,
        MessageKind::ToolCall => EventKind::ToolCall,
        MessageKind::ToolResult => EventKind::ToolResult,
        MessageKind::CompactContinuationMarker => EventKind::CompactContinuationMarker,
    }
}

/// Cross-domain surface, called by intake-stream inside the batch transaction.
/// Synchronous and throwing by design: message creation failure propagates to the
/// pipeline's catch and rejects the whole batch. Returns null for turn_end (no
/// message). turn_id is the membership stamp, settled by the pipeline before
/// this call.
pub fn create(
    transaction: &DbWriteTransaction,
    recorded_event: &RecordedEvent,
    turn_id: &str,
) -> MessageCreateResult {
    let projected = project_event(recorded_event);
    let Some(projected) = projected else {
        return MessageCreateResult {
            message: None,
            queued_work: Vec::new(),
        };
    };
    let kind = message_kind_from_event(recorded_event.event_kind());
    let message_id = format!("m{}", recorded_event.event_order());
    // providerUsage rides assistant_text only; projectEvent leaves it on the
    // event payload and storage writes it as a message column (not a block).
    // exactOptionalPropertyTypes: omit the key when absent — do not pass undefined.
    let provider_usage = match recorded_event {
        EventRecord::AssistantText { payload, .. } => payload.provider_usage.clone(),
        EventRecord::UserPrompt { .. }
        | EventRecord::AssistantThinking { .. }
        | EventRecord::RuntimeNote { .. }
        | EventRecord::ModelChange { .. }
        | EventRecord::ThinkingLevelChange { .. }
        | EventRecord::ToolCall { .. }
        | EventRecord::ToolResult { .. }
        | EventRecord::CompactContinuationMarker { .. }
        | EventRecord::TurnEnd { .. } => None,
    };
    // The host-supplied step index rides the four step-bearing kinds only
    // (schema v12); every other kind stores NULL.
    let step_index = match recorded_event {
        EventRecord::AssistantText { payload, .. } => payload.step_index,
        EventRecord::AssistantThinking { payload, .. } => payload.step_index,
        EventRecord::ToolCall { payload, .. } => payload.step_index,
        EventRecord::ToolResult { payload, .. } => payload.step_index,
        EventRecord::UserPrompt { .. }
        | EventRecord::RuntimeNote { .. }
        | EventRecord::ModelChange { .. }
        | EventRecord::ThinkingLevelChange { .. }
        | EventRecord::CompactContinuationMarker { .. }
        | EventRecord::TurnEnd { .. } => None,
    };
    insert_message(
        transaction.db,
        &MessageRow {
            message_id: message_id.clone(),
            source_event_order: recorded_event.event_order(),
            kind,
            token_estimate: projected.token_estimate,
            actor: recorded_event.actor().to_string(),
            harness: recorded_event.harness().to_string(),
            turn_id: turn_id.to_string(),
            provider_usage,
            step_index,
            blocks: projected.blocks,
        },
    );
    let message = match recorded_event.event_kind() {
        EventKind::ToolCall => MessageCreated {
            message_id,
            kind,
            tool_call_id: Some(
                recorded_event
                    .tool_call_payload()
                    .expect("tool_call payload")
                    .tool_call_id
                    .clone(),
            ),
        },
        EventKind::ToolResult => MessageCreated {
            message_id,
            kind,
            tool_call_id: Some(
                recorded_event
                    .tool_result_payload()
                    .expect("tool_result payload")
                    .tool_call_id
                    .clone(),
            ),
        },
        EventKind::UserPrompt
        | EventKind::AssistantText
        | EventKind::AssistantThinking
        | EventKind::RuntimeNote
        | EventKind::ModelChange
        | EventKind::ThinkingLevelChange
        | EventKind::CompactContinuationMarker => MessageCreated {
            message_id,
            kind,
            tool_call_id: None,
        },
        EventKind::TurnEnd => panic!("turn_end has no message kind"),
    };
    let queued_work = queue_message_work(transaction, Some(&message));
    MessageCreateResult {
        message: Some(message),
        queued_work,
    }
}

/// The kind gate, exact by design: a prompt queues prompt_smoothing, a tool
/// result queues tool_result_summary, nothing else queues anything.
fn queue_message_work(
    transaction: &DbWriteTransaction,
    message: Option<&MessageCreated>,
) -> Vec<WorkItemRecord> {
    let Some(message) = message else {
        return Vec::new();
    };
    let mut items = Vec::new();
    let Some(&kind) = MESSAGE_WORK_KINDS.get(&event_kind_for_message(message.kind)) else {
        return items;
    };
    let Some(derivation) = MESSAGE_WORK_DERIVATIONS.get(&kind) else {
        // Every queuing kind names its derivation above; a miss is a wiring bug.
        panic!(
            "no derived derivation mapped for message work kind {}",
            kind.as_str()
        );
    };
    items.push(enqueue(
        transaction,
        EnqueueInput {
            owner: WorkOwner::Messages,
            kind,
            source_ref: WorkSourceRef::Message {
                message_id: message.message_id.clone(),
            },
            derivations: vec![EnqueueDerivationTarget {
                subject_kind: SubjectKind::Message,
                subject_id: message.message_id.clone(),
                derivation_type: derivation.as_str().to_string(),
            }],
            operation: None,
            source_version: None,
        },
    ));
    items
}

#[allow(dead_code)]
fn thread_not_found<T>(file_path: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("no thread file exists at {file_path}"),
            event_index: None,
        },
    }
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MessageListOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_deleted: Option<bool>,
    /// When true, exclude kinds that are not ordinary user chat (e.g. markers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub for_user_chat: Option<bool>,
}

/// Message kinds present in the canonical record but hidden from ordinary user chat.
pub const USER_CHAT_HIDDEN_KINDS: &[MessageKind] = &[MessageKind::CompactContinuationMarker];

fn invalid_bounds(reason: &str) -> ErrorResult {
    ErrorResult {
        error_class: ErrorClass::CallerError,
        code: ErrorCode::InvalidBounds,
        reason: reason.to_string(),
        event_index: None,
    }
}

/// Bounds mistakes are operational caller errors returned as results, never a
/// silent empty list a caller could mistake for an empty window.
fn validate_list_options(opts: &MessageListOptions) -> Option<ErrorResult> {
    // TS checks Number.isInteger; Rust i64 options are already integers.
    if let (Some(from), Some(to)) = (opts.from, opts.to) {
        if from > to {
            return Some(invalid_bounds(&format!(
                "from ({from}) must not exceed to ({to})"
            )));
        }
    }
    if let Some(limit) = opts.limit {
        if limit < 1 {
            return Some(invalid_bounds(&format!(
                "limit must be at least 1, got {limit}"
            )));
        }
    }
    None
}

pub async fn list(
    thread_ref: ThreadRef,
    filter: Option<MessageListOptions>,
) -> OpResult<Vec<MessageRecord>> {
    if let Some(opts) = &filter {
        if let Some(bad_bounds) = validate_list_options(opts) {
            return OpResult::Err { error: bad_bounds };
        }
    }
    let for_user_chat = filter.as_ref().and_then(|o| o.for_user_chat) == Some(true);
    let read_opts = match &filter {
        Some(opts) => MessageReadOptions {
            from: opts.from,
            to: opts.to,
            limit: opts.limit,
            include_deleted: opts.include_deleted,
        },
        None => MessageReadOptions::default(),
    };
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        Box::pin(async move {
            // Bounds resolve the window first, then derivation read-back rides only
            // that window: each record carries its stored derivations, attached from
            // one grouped query scoped to the listed ids.
            let mut records = read_messages(transaction.db, &read_opts);
            if for_user_chat {
                records.retain(|record| !USER_CHAT_HIDDEN_KINDS.contains(&record.kind));
            }
            let ids: Vec<String> = records.iter().map(|r| r.message_id.clone()).collect();
            let derivations_by_message = read_message_derivations(transaction.db, Some(&ids));
            records
                .into_iter()
                .map(|mut record| {
                    if let Some(derivations) = derivations_by_message.get(&record.message_id) {
                        record.derivations = Some(derivations.clone());
                    }
                    record
                })
                .collect::<Vec<_>>()
        })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!(
            "message read-back failed: {}",
            panic_detail(payload)
        )),
    }
}

/// In-transaction read for coordinators that already hold an open thread handle.
pub fn read_live_messages(db: &Db) -> Vec<MessageRecord> {
    read_messages(db, &MessageReadOptions::default())
}

/// TS `MessageDetail` — canonical record + honest deleted + report derivations.
/// Extends `Omit<MessageRecord, "derivations">` so host-fact fields ride through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub message_id: String,
    pub source_event_order: i64,
    pub kind: MessageKind,
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
    pub actor: String,
    pub harness: String,
    pub recorded_at: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_usage: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<i64>,
    pub deleted: bool,
    pub derivations: Vec<DerivationReportEntry>,
}

pub async fn show(thread_ref: ThreadRef, message_id: &str) -> OpResult<MessageDetail> {
    let message_id = message_id.to_string();
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        let message_id = message_id.clone();
        Box::pin(async move {
            let record = read_message_by_id(transaction.db, &message_id);
            let Some(record) = record else {
                return OpResult::Err {
                    error: ErrorResult {
                        error_class: ErrorClass::CallerError,
                        code: ErrorCode::MessageNotFound,
                        reason: format!("no message {message_id} exists in this thread"),
                        event_index: None,
                    },
                };
            };
            let derivations = report_message_derivations(
                transaction.db,
                &MessageReportOptions {
                    not_ready: None,
                    message_id: Some(message_id),
                },
            );
            OpResult::Ok {
                value: MessageDetail {
                    message_id: record.message_id,
                    source_event_order: record.source_event_order,
                    kind: record.kind,
                    blocks: record.blocks,
                    token_estimate: record.token_estimate,
                    actor: record.actor,
                    harness: record.harness,
                    recorded_at: record.recorded_at,
                    turn_id: record.turn_id,
                    provider_usage: record.provider_usage,
                    step_index: record.step_index,
                    deleted: record.deleted,
                    derivations,
                },
            }
        })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!("message show failed: {}", panic_detail(payload))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageReportOpts {
    pub not_ready: Option<bool>,
    pub message_id: Option<String>,
}

pub async fn report(
    thread_ref: ThreadRef,
    opts: Option<MessageReportOpts>,
) -> OpResult<Vec<DerivationReportEntry>> {
    let report_opts = MessageReportOptions {
        not_ready: opts.as_ref().and_then(|o| o.not_ready),
        message_id: opts.and_then(|o| o.message_id),
    };
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        let report_opts = report_opts.clone();
        Box::pin(async move { report_message_derivations(transaction.db, &report_opts) })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!("report read failed: {}", panic_detail(payload))),
    }
}

pub async fn derive(
    thread_ref: ThreadRef,
    message_ids: &[String],
) -> OpResult<Vec<MessageDeriveResult>> {
    let Some(config) = resolve_instance_config() else {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::InferenceUnavailable,
                reason: "messages.derive requires an initialized LHC SDK inference configuration"
                    .into(),
                event_index: None,
            },
        };
    };
    let resolved = match resolve_thread_ref(thread_ref).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let file_path = resolved.file_path;
    if !Path::new(&file_path).exists() {
        return thread_not_found(&file_path);
    }
    let db = match open_thread_database(&file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let result = AssertUnwindSafe(async {
        let thread_id = db
            .prepare(SQL_SELECT_THREAD_ID)
            .get_params(&[])
            .and_then(|row| {
                row.get("thread_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            });
        let Some(thread_id) = thread_id else {
            return storage_failure(&format!("thread file at {file_path} lost its metadata row"));
        };
        let reopen_path = file_path.clone();
        let run = HandlerRunContext {
            thread_id,
            file_path: file_path.clone(),
            open_db: Arc::new(move || open_database(&reopen_path)),
            inference_callbacks: config.inference_callbacks.clone(),
            clock: Arc::clone(&config.clock),
            config: config.clone(),
        };
        let mut results = Vec::new();
        for message_id in message_ids {
            results.push(derive_message_in_thread(&run, message_id, None).await);
        }
        OpResult::Ok { value: results }
    })
    .catch_unwind()
    .await;
    db.close();
    match result {
        Ok(value) => value,
        Err(payload) => storage_failure(&format!("derive failed: {}", panic_detail(payload))),
    }
}

/// TS `MutationResult.changed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationChanged {
    pub message_ids: Vec<String>,
    pub turn_ids: Vec<String>,
}

/// TS `MutationResult.queued` entry — distinct from cascade's internal queued shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationQueuedWork {
    pub work_item_id: String,
    pub kind: WorkKind,
}

/// TS `MutationResult` — shared edit/delete contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub changed: MutationChanged,
    pub cleared: Vec<CascadeClear>,
    pub dropped: Vec<CascadeClear>,
    pub queued: Vec<MutationQueuedWork>,
    pub superseded: Vec<String>,
}

/// TS `edit({ messageId, content })`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInput {
    pub message_id: String,
    pub content: String,
}

/// TS `remove({ messageId })`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveInput {
    pub message_id: String,
}

pub async fn edit(thread_ref: ThreadRef, edit: EditInput) -> OpResult<MutationResult> {
    let result = AssertUnwindSafe(create_db_write_transaction(
        thread_ref,
        move |transaction| {
            let edit = edit;
            Box::pin(async move {
                let target = read_mutable_message(transaction.db, &edit.message_id);
                let Some(target) = target else {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::MessageNotFound,
                            reason: format!(
                                "no message {} exists in this thread",
                                edit.message_id
                            ),
                            event_index: None,
                        },
                    };
                };
                if target.turn_status != Some(internal::store::MutableTurnStatus::Closed) {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::TurnOpen,
                            reason: if target.turn_status
                                == Some(internal::store::MutableTurnStatus::Open)
                            {
                                format!(
                                    "message {} belongs to open turn {}; open-turn messages cannot be edited (v1 boundary)",
                                    edit.message_id, target.turn_id
                                )
                            } else {
                                format!(
                                    "message {} references no readable turn; only closed-turn messages can be edited (v1 boundary)",
                                    edit.message_id
                                )
                            },
                            event_index: None,
                        },
                    };
                }
                apply_message_edit(transaction.db, &edit.message_id, &edit.content);
                let cascade = cascade_from_message(transaction, &edit.message_id);
                OpResult::Ok {
                    value: MutationResult {
                        changed: MutationChanged {
                            message_ids: vec![edit.message_id],
                            turn_ids: Vec::new(),
                        },
                        cleared: cascade.cleared,
                        dropped: cascade.dropped,
                        queued: cascade
                            .queued
                            .into_iter()
                            .map(|q| MutationQueuedWork {
                                work_item_id: q.work_item_id,
                                kind: q.kind,
                            })
                            .collect(),
                        superseded: cascade.superseded,
                    },
                }
            })
        },
        None,
    ))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!("edit failed: {}", panic_detail(payload))),
    }
}

pub async fn remove(thread_ref: ThreadRef, removal: RemoveInput) -> OpResult<MutationResult> {
    let result = AssertUnwindSafe(create_db_write_transaction(
        thread_ref,
        move |transaction| {
            let removal = removal;
            Box::pin(async move {
                let target = read_mutable_message(transaction.db, &removal.message_id);
                let Some(target) = target else {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::MessageNotFound,
                            reason: format!(
                                "no message {} exists in this thread",
                                removal.message_id
                            ),
                            event_index: None,
                        },
                    };
                };
                if target.turn_status != Some(internal::store::MutableTurnStatus::Closed) {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::TurnOpen,
                            reason: if target.turn_status
                                == Some(internal::store::MutableTurnStatus::Open)
                            {
                                format!(
                                    "message {} belongs to open turn {}; open-turn messages cannot be deleted (v1 boundary)",
                                    removal.message_id, target.turn_id
                                )
                            } else {
                                format!(
                                    "message {} references no readable turn; only closed-turn messages can be deleted (v1 boundary)",
                                    removal.message_id
                                )
                            },
                            event_index: None,
                        },
                    };
                }
                if target.initiates_turn {
                    return OpResult::Err {
                        error: ErrorResult {
                            error_class: ErrorClass::CallerError,
                            code: ErrorCode::MessageInitiatesTurn,
                            reason: format!(
                                "message {} is the prompt that initiates turn {}; deleting the initiating prompt or whole turn is not supported in this slice",
                                removal.message_id, target.turn_id
                            ),
                            event_index: None,
                        },
                    };
                }
                let deleted_at = system_time_to_iso((transaction.clock)());
                mark_message_deleted(transaction.db, &removal.message_id, &deleted_at);
                let cascade = cascade_message_delete(transaction, &removal.message_id);
                OpResult::Ok {
                    value: MutationResult {
                        changed: MutationChanged {
                            message_ids: vec![removal.message_id],
                            turn_ids: Vec::new(),
                        },
                        cleared: cascade.cleared,
                        dropped: cascade.dropped,
                        queued: cascade
                            .queued
                            .into_iter()
                            .map(|q| MutationQueuedWork {
                                work_item_id: q.work_item_id,
                                kind: q.kind,
                            })
                            .collect(),
                        superseded: cascade.superseded,
                    },
                }
            })
        },
        None,
    ))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => value,
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!("delete failed: {}", panic_detail(payload))),
    }
}

fn system_time_to_iso(time: std::time::SystemTime) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}
