//! Ported from packages/lhc/src/shared-tech/durable-work/index.ts.
//!
//! Durable work dispatch: operation intents, derivation completion transactions,
//! and the handler runner used by domain dispatchers.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind, panic_any, resume_unwind};
use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::derivation::{
    BoxFuture, CompletionTx, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    ResolvedSdkConfig, SubjectKind, WorkHandler, WorkItemRef,
};
use super::errors::OpResult;
use super::js_json::js_json_stringify_of;
use super::persist::create_post_commit_hook_set;
use super::storage::{Db, SqlParam, open_database};
use super::work_queue::{EnqueueDerivationTarget, WorkKind, WorkSourceRef};

/// TS `DurableWorkOperation` — internally tagged on `operation`, camelCase fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation")]
pub enum DurableWorkOperation {
    #[serde(rename = "messages.derive")]
    MessagesDerive {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    #[serde(rename = "turns.deriveTurn")]
    TurnsDeriveTurn {
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    #[serde(rename = "turns.deriveDetailedTurnCompression")]
    TurnsDeriveDetailedTurnCompression {
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    #[serde(rename = "turns.deriveDetailedChunk")]
    TurnsDeriveDetailedChunk {
        #[serde(rename = "chunkId")]
        chunk_id: String,
    },
    #[serde(rename = "turns.deriveBriefChunk")]
    TurnsDeriveBriefChunk {
        #[serde(rename = "chunkId")]
        chunk_id: String,
    },
}

/// TS `DurableWorkOperation["operation"]` — map keys / vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DurableWorkOperationName {
    #[serde(rename = "messages.derive")]
    MessagesDerive,
    #[serde(rename = "turns.deriveTurn")]
    TurnsDeriveTurn,
    #[serde(rename = "turns.deriveDetailedTurnCompression")]
    TurnsDeriveDetailedTurnCompression,
    #[serde(rename = "turns.deriveDetailedChunk")]
    TurnsDeriveDetailedChunk,
    #[serde(rename = "turns.deriveBriefChunk")]
    TurnsDeriveBriefChunk,
}

impl DurableWorkOperationName {
    pub fn as_str(self) -> &'static str {
        match self {
            DurableWorkOperationName::MessagesDerive => "messages.derive",
            DurableWorkOperationName::TurnsDeriveTurn => "turns.deriveTurn",
            DurableWorkOperationName::TurnsDeriveDetailedTurnCompression => {
                "turns.deriveDetailedTurnCompression"
            }
            DurableWorkOperationName::TurnsDeriveDetailedChunk => "turns.deriveDetailedChunk",
            DurableWorkOperationName::TurnsDeriveBriefChunk => "turns.deriveBriefChunk",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DerivationAttempt {
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub work_item_id: Option<String>,
}

/// TS `DurableWorkDispatchResult` — discriminated on `disposition`.
#[derive(Debug, Clone, PartialEq)]
pub enum DurableWorkDispatchResult {
    Settled {
        disposition: DurableWorkSettledDisposition,
    },
    Failed {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableWorkSettledDisposition {
    Done,
    StaleDiscarded,
    LostLease,
}

impl DurableWorkSettledDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            DurableWorkSettledDisposition::Done => "done",
            DurableWorkSettledDisposition::StaleDiscarded => "stale_discarded",
            DurableWorkSettledDisposition::LostLease => "lost_lease",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DurableWorkDispatcherItem {
    pub work_item_id: String,
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub operation: DurableWorkOperation,
}

/// TS `DurableWorkDispatcher` — cloneable Arc so drain lookup can hand out a shared fn.
pub type DurableWorkDispatcher = Arc<
    dyn Fn(HandlerRunContext, DurableWorkDispatcherItem) -> BoxFuture<DurableWorkDispatchResult>
        + Send
        + Sync,
>;

/// TS `Partial<Record<DurableWorkOperation["operation"], DurableWorkDispatcher>>`.
/// Operation-keyed lookup only (iteration order not load-bearing) → [`HashMap`].
pub type DurableWorkDispatcherMap = HashMap<DurableWorkOperationName, DurableWorkDispatcher>;

/// TS `DerivationCompletionError` — state_corruption / derivation_completion_mismatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivationCompletionError {
    pub detail: String,
}

impl DerivationCompletionError {
    pub const ERROR_CLASS: &'static str = "state_corruption";
    pub const CODE: &'static str = "derivation_completion_mismatch";

    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for DerivationCompletionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "derivation_completion_mismatch: {}", self.detail)
    }
}

impl std::error::Error for DerivationCompletionError {}

/// TS `Pick<EnqueueDerivationTarget | HandlerDerivationWrite, subjectKind|subjectId|derivationType>`.
trait DerivationTargetKeyParts {
    fn subject_kind(&self) -> SubjectKind;
    fn subject_id(&self) -> &str;
    fn derivation_type(&self) -> &str;
}

impl DerivationTargetKeyParts for EnqueueDerivationTarget {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

impl DerivationTargetKeyParts for HandlerDerivationWrite {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

fn target_key(target: &impl DerivationTargetKeyParts) -> String {
    format!(
        "{}/{}/{}",
        target.subject_kind().as_str(),
        target.subject_id(),
        target.derivation_type()
    )
}

pub fn assert_exact_derivation_writes(
    expected: &[EnqueueDerivationTarget],
    writes: &[HandlerDerivationWrite],
) {
    let expected_keys: Vec<String> = expected.iter().map(target_key).collect();
    let write_keys: Vec<String> = writes.iter().map(target_key).collect();
    let duplicate_expected = expected_keys
        .iter()
        .enumerate()
        .find(|(index, key)| expected_keys.iter().position(|k| k == *key) != Some(*index))
        .map(|(_, key)| key.clone());
    if let Some(duplicate_expected) = duplicate_expected {
        panic_any(DerivationCompletionError::new(format!(
            "derivation completion target duplicated: {duplicate_expected}"
        )));
    }
    let duplicate_write = write_keys
        .iter()
        .enumerate()
        .find(|(index, key)| write_keys.iter().position(|k| k == *key) != Some(*index))
        .map(|(_, key)| key.clone());
    if let Some(duplicate_write) = duplicate_write {
        panic_any(DerivationCompletionError::new(format!(
            "derivation completion write duplicated: {duplicate_write}"
        )));
    }
    let expected_set: std::collections::HashSet<&str> =
        expected_keys.iter().map(String::as_str).collect();
    let write_set: std::collections::HashSet<&str> =
        write_keys.iter().map(String::as_str).collect();
    let missing: Vec<&str> = expected_keys
        .iter()
        .filter(|key| !write_set.contains(key.as_str()))
        .map(String::as_str)
        .collect();
    let extra: Vec<&str> = write_keys
        .iter()
        .filter(|key| !expected_set.contains(key.as_str()))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() || !extra.is_empty() {
        panic_any(DerivationCompletionError::new(format!(
            "derivation completion target mismatch: missing [{}], extra [{}]",
            missing.join(", "),
            extra.join(", ")
        )));
    }
}

pub fn operation_intent(kind: WorkKind, source_ref: &WorkSourceRef) -> DurableWorkOperation {
    match kind {
        WorkKind::PromptSmoothing | WorkKind::ToolResultSummary => {
            let WorkSourceRef::Message { message_id } = source_ref else {
                panic!("{} work requires a messageId source", kind.as_str());
            };
            DurableWorkOperation::MessagesDerive {
                message_id: message_id.clone(),
            }
        }
        WorkKind::TurnDerivation => {
            let WorkSourceRef::Turn { turn_id } = source_ref else {
                panic!("turn_derivation work requires a turnId source");
            };
            DurableWorkOperation::TurnsDeriveTurn {
                turn_id: turn_id.clone(),
            }
        }
        WorkKind::DetailedTurnCompression => {
            let WorkSourceRef::Turn { turn_id } = source_ref else {
                panic!("detailed_turn_compression work requires a turnId source");
            };
            DurableWorkOperation::TurnsDeriveDetailedTurnCompression {
                turn_id: turn_id.clone(),
            }
        }
        WorkKind::ChunkSummaryDetailed => {
            let WorkSourceRef::Chunk { chunk_id } = source_ref else {
                panic!("chunk_summary_detailed work requires a chunkId source");
            };
            DurableWorkOperation::TurnsDeriveDetailedChunk {
                chunk_id: chunk_id.clone(),
            }
        }
        WorkKind::ChunkSummaryBrief => {
            let WorkSourceRef::Chunk { chunk_id } = source_ref else {
                panic!("chunk_summary_brief work requires a chunkId source");
            };
            DurableWorkOperation::TurnsDeriveBriefChunk {
                chunk_id: chunk_id.clone(),
            }
        }
    }
}

pub fn write_pending_derivations(
    db: &Db,
    derivations: &[EnqueueDerivationTarget],
    source_version: i64,
) {
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let upsert = db.prepare(
            "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
             VALUES (?, ?, ?, 'pending', ?)
             ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
               state = 'pending', content = NULL, reason = NULL, metadata = NULL,
               gaps = NULL, derived_at = NULL, source_version = excluded.source_version",
        );
        for target in derivations {
            upsert.run(&[
                SqlParam::from(target.subject_kind.as_str()),
                SqlParam::from(target.subject_id.as_str()),
                SqlParam::from(target.derivation_type.as_str()),
                SqlParam::from(source_version),
            ]);
        }
        db.exec("COMMIT;");
    }));
    match result {
        Ok(()) => {}
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

/// TS `applyDerivationSuccess` return: `"done" | "stale_discarded" | "lost_lease"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyDerivationSuccessDisposition {
    Done,
    StaleDiscarded,
    LostLease,
}

impl ApplyDerivationSuccessDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyDerivationSuccessDisposition::Done => "done",
            ApplyDerivationSuccessDisposition::StaleDiscarded => "stale_discarded",
            ApplyDerivationSuccessDisposition::LostLease => "lost_lease",
        }
    }
}

pub fn apply_derivation_success(
    db: &Db,
    attempt: &DerivationAttempt,
    writes: &[HandlerDerivationWrite],
    derived_at: &str,
    on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> ApplyDerivationSuccessDisposition {
    let post_commit_hook = create_post_commit_hook_set();
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(move || {
        if let Some(work_item_id) = attempt.work_item_id.as_deref() {
            let owned = db
                .prepare("SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
                .get_params(&[SqlParam::from(work_item_id)]);
            if owned.is_none() {
                db.exec("COMMIT;");
                return ApplyDerivationSuccessDisposition::LostLease;
            }
        }
        assert_exact_derivation_writes(&attempt.derivations, writes);
        let mut hits: i64 = 0;
        let mut misses: i64 = 0;
        let update = db.prepare(
            "UPDATE derivation
             SET state = 'ready', content = ?, reason = NULL, metadata = ?, gaps = ?, derived_at = ?
             WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?",
        );
        for write in writes {
            let metadata = match &write.metadata {
                None => SqlParam::Null,
                Some(metadata) => SqlParam::from(
                    js_json_stringify_of(metadata).expect("metadata js_json_stringify_of"),
                ),
            };
            let gaps = match &write.gaps {
                None => SqlParam::Null,
                Some(gaps) => {
                    SqlParam::from(js_json_stringify_of(gaps).expect("gaps js_json_stringify_of"))
                }
            };
            let changed = update.run(&[
                SqlParam::from(write.content.as_str()),
                metadata,
                gaps,
                SqlParam::from(derived_at),
                SqlParam::from(write.subject_kind.as_str()),
                SqlParam::from(write.subject_id.as_str()),
                SqlParam::from(write.derivation_type.as_str()),
                SqlParam::from(attempt.source_version),
            ]);
            let count = changed.changes;
            if count == 0 {
                misses += 1;
            }
            if count > 1 {
                panic_any(DerivationCompletionError::new(format!(
                    "derivation completion write hit {count} rows for {} at sourceVersion {}",
                    target_key(write),
                    attempt.source_version
                )));
            }
            hits += count;
        }
        let stale = !writes.is_empty() && hits == 0;
        if !stale && misses > 0 {
            panic_any(DerivationCompletionError::new(format!(
                "derivation completion partially hit {hits} of {} rows at sourceVersion {}",
                writes.len(),
                attempt.source_version
            )));
        }
        let super::persist::PostCommitHookSet { add, flush } = post_commit_hook;
        if !stale {
            if let Some(on_applied) = on_applied {
                on_applied(CompletionTx {
                    db,
                    on_commit: Box::new(add),
                });
            }
        }
        if let Some(work_item_id) = attempt.work_item_id.as_deref() {
            db.prepare("DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
                .run(&[SqlParam::from(work_item_id)]);
        }
        db.exec("COMMIT;");
        flush();
        if stale {
            ApplyDerivationSuccessDisposition::StaleDiscarded
        } else {
            ApplyDerivationSuccessDisposition::Done
        }
    }));
    match result {
        Ok(disposition) => disposition,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivationTerminalState {
    Failed,
    Blocked,
}

impl DerivationTerminalState {
    pub fn as_str(self) -> &'static str {
        match self {
            DerivationTerminalState::Failed => "failed",
            DerivationTerminalState::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DerivationTerminalFailure {
    pub reason: String,
    pub state: DerivationTerminalState,
    pub now: String,
}

/// TS `applyDerivationTerminalFailure` return: `"done" | "lost_lease"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyDerivationTerminalDisposition {
    Done,
    LostLease,
}

impl ApplyDerivationTerminalDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyDerivationTerminalDisposition::Done => "done",
            ApplyDerivationTerminalDisposition::LostLease => "lost_lease",
        }
    }
}

pub fn apply_derivation_terminal_failure(
    db: &Db,
    attempt: &DerivationAttempt,
    failure: &DerivationTerminalFailure,
) -> ApplyDerivationTerminalDisposition {
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(|| {
        if let Some(work_item_id) = attempt.work_item_id.as_deref() {
            let owned = db
                .prepare("SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
                .get_params(&[SqlParam::from(work_item_id)]);
            if owned.is_none() {
                db.exec("COMMIT;");
                return ApplyDerivationTerminalDisposition::LostLease;
            }
        }
        let update = db.prepare(
            "UPDATE derivation
             SET state = ?, content = NULL, reason = ?, metadata = NULL, gaps = NULL, derived_at = ?
             WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?",
        );
        let mut hits: i64 = 0;
        let mut misses: i64 = 0;
        for target in &attempt.derivations {
            let changed = update.run(&[
                SqlParam::from(failure.state.as_str()),
                SqlParam::from(failure.reason.as_str()),
                SqlParam::from(failure.now.as_str()),
                SqlParam::from(target.subject_kind.as_str()),
                SqlParam::from(target.subject_id.as_str()),
                SqlParam::from(target.derivation_type.as_str()),
                SqlParam::from(attempt.source_version),
            ]);
            let count = changed.changes;
            if count == 0 {
                misses += 1;
            }
            if count > 1 {
                panic_any(DerivationCompletionError::new(format!(
                    "derivation completion terminal hit {count} rows for {} at sourceVersion {}",
                    target_key(target),
                    attempt.source_version
                )));
            }
            hits += count;
        }
        let stale = !attempt.derivations.is_empty() && hits == 0;
        if !stale && misses > 0 {
            panic_any(DerivationCompletionError::new(format!(
                "derivation completion terminal partially hit {hits} of {} rows at sourceVersion {}",
                attempt.derivations.len(),
                attempt.source_version
            )));
        }
        if let Some(work_item_id) = attempt.work_item_id.as_deref() {
            db.prepare("DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
                .run(&[SqlParam::from(work_item_id)]);
        }
        db.exec("COMMIT;");
        ApplyDerivationTerminalDisposition::Done
    }));
    match result {
        Ok(disposition) => disposition,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

/// TS handler item for `runWorkHandler` (sourceRef as Record at the call boundary).
pub type RunWorkHandlerFn = WorkHandler;

#[derive(Debug, Clone, PartialEq)]
pub struct RunWorkHandlerItem {
    pub work_item_id: String,
    pub kind: String,
    pub source_ref: WorkSourceRef,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HandlerRunIdentity {
    pub thread_id: String,
    pub file_path: String,
}

fn source_ref_as_record(source_ref: &WorkSourceRef) -> IndexMap<String, String> {
    let mut map = IndexMap::new();
    match source_ref {
        WorkSourceRef::Message { message_id } => {
            map.insert("messageId".to_string(), message_id.clone());
        }
        WorkSourceRef::Turn { turn_id } => {
            map.insert("turnId".to_string(), turn_id.clone());
        }
        WorkSourceRef::Chunk { chunk_id } => {
            map.insert("chunkId".to_string(), chunk_id.clone());
        }
    }
    map
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(err) = payload.downcast_ref::<DerivationCompletionError>() {
        return err.to_string();
    }
    "unknown panic".to_string()
}

pub async fn run_work_handler(
    db: &Db,
    config: &ResolvedSdkConfig,
    handler: RunWorkHandlerFn,
    item: RunWorkHandlerItem,
    identity: Option<HandlerRunIdentity>,
) -> HandlerOutcome {
    use futures::FutureExt;

    // TS `try` covers fallback metadata lookup + sync handler construction +
    // the awaited handler body. Catch construction panics separately from poll.
    let built = catch_unwind(AssertUnwindSafe(|| {
        let thread_id = match &identity {
            Some(identity) => identity.thread_id.clone(),
            None => db
                .prepare("SELECT thread_id FROM thread_metadata WHERE id = 1")
                .get()
                .and_then(|row| {
                    row.get("thread_id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default(),
        };
        let file_path = match &identity {
            Some(identity) => identity.file_path.clone(),
            None => db.path().to_string(),
        };
        let reopen_path = db.path().to_string();
        let open_db: Arc<dyn Fn() -> OpResult<Db> + Send + Sync> =
            Arc::new(move || open_database(&reopen_path));

        handler(
            HandlerRunContext {
                thread_id,
                file_path,
                open_db,
                inference_callbacks: config.inference_callbacks.clone(),
                clock: Arc::clone(&config.clock),
                config: config.clone(),
            },
            WorkItemRef {
                work_item_id: item.work_item_id,
                kind: item.kind,
                source_ref: source_ref_as_record(&item.source_ref),
            },
        )
    }));
    let fut = match built {
        Ok(fut) => fut,
        Err(cause) => {
            if cause.is::<DerivationCompletionError>() {
                resume_unwind(cause);
            }
            return HandlerOutcome::Failed {
                reason: format!("handler threw: {}", panic_payload_message(cause)),
            };
        }
    };
    match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(outcome) => outcome,
        Err(cause) => {
            if cause.is::<DerivationCompletionError>() {
                resume_unwind(cause);
            }
            HandlerOutcome::Failed {
                reason: format!("handler threw: {}", panic_payload_message(cause)),
            }
        }
    }
}

pub fn derivation_target(
    subject_kind: SubjectKind,
    subject_id: String,
    derivation_type: String,
) -> EnqueueDerivationTarget {
    EnqueueDerivationTarget {
        subject_kind,
        subject_id,
        derivation_type,
    }
}
