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
use crate::shared_tech::derivation::{Derivation, DerivationReportEntry, SubjectKind};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::persist::{DbWriteTransaction, create_db_read_transaction};
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef,
    enqueue,
};
use crate::threads::ThreadRef;

use internal::cascade::CascadeClear;
use internal::derivations::read_message_derivations;
use internal::project::project_event;
use internal::store::{MessageReadOptions, MessageRow, insert_message, read_messages};
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
}

impl BlockType {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockType::Text => "text",
            BlockType::ToolCall => "tool_call",
            BlockType::ToolResult => "tool_result",
            BlockType::ModelChange => "model_change",
            BlockType::ThinkingLevelChange => "thinking_level_change",
        }
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
/// Exhaustive eight-variant closed vocab with byte-exact snake_case wire values.
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
        }
    }
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
        | EventKind::ThinkingLevelChange => MessageCreated {
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
}

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
            let records = read_messages(transaction.db, &read_opts);
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
pub fn read_live_messages(_db: &Db) -> Vec<MessageRecord> {
    todo!("phase 2")
}

/// TS `MessageDetail` — canonical record + honest deleted + report derivations.
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
    pub deleted: bool,
    pub derivations: Vec<DerivationReportEntry>,
}

pub async fn show(_thread_ref: ThreadRef, _message_id: &str) -> OpResult<MessageDetail> {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageReportOpts {
    pub not_ready: Option<bool>,
    pub message_id: Option<String>,
}

pub async fn report(
    _thread_ref: ThreadRef,
    _opts: Option<MessageReportOpts>,
) -> OpResult<Vec<DerivationReportEntry>> {
    todo!("phase 2")
}

pub async fn derive(
    _thread_ref: ThreadRef,
    _message_ids: &[String],
) -> OpResult<Vec<MessageDeriveResult>> {
    todo!("phase 2")
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

pub async fn edit(_thread_ref: ThreadRef, _edit: EditInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}

pub async fn remove(_thread_ref: ThreadRef, _removal: RemoveInput) -> OpResult<MutationResult> {
    todo!("phase 2")
}
