//! Ported from packages/lhc/src/shared-tech/durable-work/index.ts.
//! Phase 1 skeleton — types/serde/as_str/constants REAL; behavior bodies
//! `todo!("phase 2")`. Private `DerivationTargetKeyParts` field projection is
//! type-glue only. No public operation-key helper (sdk owns lookup wiring).
//!
//! Durable work dispatch: operation intents, derivation completion transactions,
//! and the handler runner used by domain dispatchers.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::derivation::{
    BoxFuture, CompletionTx, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    ResolvedSdkConfig, SubjectKind, WorkHandler,
};
use super::storage::Db;
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

    pub fn new(_detail: impl Into<String>) -> Self {
        todo!("phase 2")
    }
}

impl std::fmt::Display for DerivationCompletionError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!("phase 2")
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

fn target_key(_target: &impl DerivationTargetKeyParts) -> String {
    todo!("phase 2")
}

pub fn assert_exact_derivation_writes(
    _expected: &[EnqueueDerivationTarget],
    _writes: &[HandlerDerivationWrite],
) {
    todo!("phase 2")
}

pub fn operation_intent(_kind: WorkKind, _source_ref: &WorkSourceRef) -> DurableWorkOperation {
    todo!("phase 2")
}

pub fn write_pending_derivations(
    _db: &Db,
    _derivations: &[EnqueueDerivationTarget],
    _source_version: i64,
) {
    todo!("phase 2")
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
    _db: &Db,
    _attempt: &DerivationAttempt,
    _writes: &[HandlerDerivationWrite],
    _derived_at: &str,
    _on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> ApplyDerivationSuccessDisposition {
    todo!("phase 2")
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
    _db: &Db,
    _attempt: &DerivationAttempt,
    _failure: &DerivationTerminalFailure,
) -> ApplyDerivationTerminalDisposition {
    todo!("phase 2")
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

pub async fn run_work_handler(
    _db: &Db,
    _config: &ResolvedSdkConfig,
    _handler: RunWorkHandlerFn,
    _item: RunWorkHandlerItem,
    _identity: Option<HandlerRunIdentity>,
) -> HandlerOutcome {
    todo!("phase 2")
}

pub fn derivation_target(
    _subject_kind: SubjectKind,
    _subject_id: String,
    _derivation_type: String,
) -> EnqueueDerivationTarget {
    todo!("phase 2")
}
