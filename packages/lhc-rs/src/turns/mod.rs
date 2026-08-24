//! Ported from packages/lhc/src/turns/index.ts.
//!
//! Wave 3: `create` and the intake helpers it needs. Remaining surface bodies
//! stay Phase 2. `TurnStructureRow` / `ChunkStructureRow` /
//! `CompactChunkMaterial` stay module-private to the domain (not crate-root
//! exports). `TurnDeriveResult` / `ChunkDeriveResult` follow Wave 4
//! `MessageDeriveResult` wire precedent (custom Serialize field order + tagged
//! Deserialize).

pub mod internal;

use std::panic::{AssertUnwindSafe, panic_any};
use std::path::Path;

use futures::FutureExt;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::intake_stream::{EventKind, TurnEndPayload, TurnOutcome};
use crate::shared_tech::context::resolve_instance_config;
use crate::shared_tech::derivation::{
    Derivation, DerivationReportEntry, ResolvedSdkConfig, SubjectKind,
};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use crate::shared_tech::persist::{
    DbReadTransaction, DbWriteTransaction, create_db_read_transaction,
};
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef,
    enqueue,
};
use crate::threads::{ThreadRef, open_thread_database, resolve_thread_ref};

use internal::chunk_recovery::{CompactChunkMaterial, compact_chunk_material_from_stored_members};
use internal::chunks::{ChunkStructureRow, drop_empty_readable_chunks, read_chunk_structure};
use internal::derivations::{
    TurnOwnedSubjectKind, TurnReportOptions, read_chunk_rows, read_owned_derivations,
    report_turn_derivations,
};
use internal::derive::{TurnOwnedDeriveResult, derive_turn_owned_in_open_db};
use internal::steps::{StepEdges, read_step_members, step_edges};
use internal::store::select_open_turn_ids as select_open_turn_ids_for_steps;
use internal::store::{
    TurnCloseHostFacts, TurnStructureRow, close_turn, count_turn_members, insert_open_turn,
    next_turn_order, read_turn_structure, read_turns, select_open_turn_ids,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Open,
    Closed,
}

impl TurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnStatus::Open => "open",
            TurnStatus::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub turn_id: String,
    pub turn_order: i64,
    pub status: TurnStatus,
    pub member_message_ids: Vec<String>,
    pub opened_at_event_order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at_event_order: Option<i64>,
    // Host-observed facts from turn_end (schema v5). Absent when unknown —
    // pre-v5 turns, prompt-boundary closes, or hosts that omit them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_idx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
}

/// TS `ChunkRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRecord {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub accumulated_projected_tokens: i64,
    pub member_turn_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivations: Option<Vec<Derivation>>,
}

/// TS transition action vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnTransitionAction {
    Opened,
    Closed,
}

impl TurnTransitionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnTransitionAction::Opened => "opened",
            TurnTransitionAction::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTransition {
    pub action: TurnTransitionAction,
    pub turn_id: String,
}

/// TS `TurnTransitionOutcome`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTransitionOutcome {
    pub transitions: Vec<TurnTransition>,
    pub turn_id: String,
    pub queued_work: Vec<WorkItemRecord>,
}

/// TS `TurnStateCorruptionError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStateCorruptionError {
    pub message: String,
}

impl TurnStateCorruptionError {
    pub const ERROR_CLASS: &'static str = "state_corruption";
    pub const CODE: &'static str = "turn_state_corrupt";
}

impl std::fmt::Display for TurnStateCorruptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TurnStateCorruptionError {}

fn current_open_turn_id(transaction: &DbWriteTransaction) -> String {
    let open_turn_ids = select_open_turn_ids(transaction.db);
    if open_turn_ids.len() != 1 {
        panic_any(TurnStateCorruptionError {
            message: format!(
                "thread has {} open turns ({}); the invariant is exactly one",
                open_turn_ids.len(),
                open_turn_ids.join(", "),
            ),
        });
    }
    open_turn_ids
        .into_iter()
        .next()
        .expect("exactly one open turn")
}

/// Closing a turn durably queues that turn's derivation work in the same
/// transaction: the close update and the work item commit or roll back together.
/// host_facts land only from turn_end; prompt-boundary closes leave them unset.
fn close_turn_and_queue_work(
    transaction: &DbWriteTransaction,
    turn_id: &str,
    event_order: i64,
    host_facts: &TurnCloseHostFacts,
) -> WorkItemRecord {
    close_turn(transaction.db, turn_id, event_order, host_facts);
    // One work item backs two deterministic turn-owned derivation rows; compression
    // queues from the turn_derivation completion transaction.
    enqueue(
        transaction,
        EnqueueInput {
            owner: WorkOwner::Turns,
            kind: WorkKind::TurnDerivation,
            source_ref: WorkSourceRef::Turn {
                turn_id: turn_id.to_string(),
            },
            derivations: vec![
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: turn_id.to_string(),
                    derivation_type: "turn_rendering".to_string(),
                },
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: turn_id.to_string(),
                    derivation_type: "pre_detailed_assembly".to_string(),
                },
            ],
            operation: None,
            source_version: None,
        },
    )
}

/// TS `RecordedTurnEvent = Pick<EventRecord, "eventKind" | "eventOrder" | "payload">`.
/// Payload is the closed turn_end shape; other kinds pass an empty payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedTurnEvent {
    pub event_kind: EventKind,
    pub event_order: i64,
    pub payload: TurnEndPayload,
    /// user_prompt only: the host's assertion that this prompt is an in-run
    /// steer (turn parts, Flow 7) — a member of the open turn, never a boundary.
    #[serde(default)]
    pub steer: bool,
}

fn host_facts_from_turn_end(payload: &TurnEndPayload) -> TurnCloseHostFacts {
    TurnCloseHostFacts {
        outcome: payload.outcome,
        outcome_reason: payload.outcome_reason.clone(),
        started_at: payload.started_at.clone(),
        ended_at: payload.ended_at.clone(),
    }
}

/// Cross-domain surface, called by intake-stream inside the batch transaction
/// for every recorded event. Synchronous and throwing by design, like
/// messages.create: a turn-storage failure rejects the whole batch.
pub fn create(
    transaction: &DbWriteTransaction,
    recorded_event: &RecordedTurnEvent,
) -> TurnTransitionOutcome {
    let open_turn_id = current_open_turn_id(transaction);
    let has_members = count_turn_members(transaction.db, &open_turn_id) > 0;
    if recorded_event.event_kind == EventKind::TurnEnd {
        if !has_members {
            return TurnTransitionOutcome {
                transitions: Vec::new(),
                turn_id: open_turn_id,
                queued_work: Vec::new(),
            };
        }
        // Payload was closed-validated as TurnEndPayload at intake (validate layer 3).
        let host_facts = host_facts_from_turn_end(&recorded_event.payload);
        let item = close_turn_and_queue_work(
            transaction,
            &open_turn_id,
            recorded_event.event_order,
            &host_facts,
        );
        let turn_id = insert_open_turn(
            transaction.db,
            next_turn_order(transaction.db),
            recorded_event.event_order,
        );
        return TurnTransitionOutcome {
            transitions: vec![
                TurnTransition {
                    action: TurnTransitionAction::Closed,
                    turn_id: open_turn_id,
                },
                TurnTransition {
                    action: TurnTransitionAction::Opened,
                    turn_id: turn_id.clone(),
                },
            ],
            turn_id,
            queued_work: vec![item],
        };
    }
    // A steering prompt (host-asserted `steer: true`) arrived inside a run in
    // progress: it is a member of the open turn, never a boundary (turn parts,
    // Flow 7 — the task's turn identity survives a steer).
    if recorded_event.event_kind == EventKind::UserPrompt && has_members && !recorded_event.steer {
        // Prompt-boundary closes leave host facts unset (NULLs).
        let item = close_turn_and_queue_work(
            transaction,
            &open_turn_id,
            recorded_event.event_order,
            &TurnCloseHostFacts::default(),
        );
        let turn_id = insert_open_turn(
            transaction.db,
            next_turn_order(transaction.db),
            recorded_event.event_order,
        );
        return TurnTransitionOutcome {
            transitions: vec![
                TurnTransition {
                    action: TurnTransitionAction::Closed,
                    turn_id: open_turn_id,
                },
                TurnTransition {
                    action: TurnTransitionAction::Opened,
                    turn_id: turn_id.clone(),
                },
            ],
            turn_id,
            queued_work: vec![item],
        };
    }
    TurnTransitionOutcome {
        transitions: Vec::new(),
        turn_id: open_turn_id,
        queued_work: Vec::new(),
    }
}

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

/// TS `listTurns`.
pub async fn list_turns(thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        Box::pin(async move {
            let derivations_by_turn =
                read_owned_derivations(transaction.db, TurnOwnedSubjectKind::Turn);
            read_turns(transaction.db)
                .into_iter()
                .map(|mut record| {
                    if let Some(derivations) = derivations_by_turn.get(&record.turn_id) {
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
        Err(payload) => {
            storage_failure(&format!("turn read-back failed: {}", panic_detail(payload)))
        }
    }
}

/// TS `listChunks`.
pub async fn list_chunks(thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        Box::pin(async move {
            let derivations_by_chunk =
                read_owned_derivations(transaction.db, TurnOwnedSubjectKind::Chunk);
            read_chunk_rows(transaction.db)
                .into_iter()
                .map(|row| {
                    let mut record = ChunkRecord {
                        chunk_id: row.chunk_id.clone(),
                        chunk_order: row.chunk_order,
                        status: row.status,
                        accumulated_projected_tokens: row.accumulated_projected_tokens,
                        member_turn_ids: row.member_turn_ids,
                        derivations: None,
                    };
                    if let Some(derivations) = derivations_by_chunk.get(&row.chunk_id) {
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
            "chunk read-back failed: {}",
            panic_detail(payload)
        )),
    }
}

/// Closed chunk derivation vocabulary on a successful `ChunkDeriveResult`
/// and on `getChunkText` / chunk-summary reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ChunkDeriveDerivationType {
    #[serde(rename = "chunk_summary_detailed")]
    ChunkSummaryDetailed,
    #[serde(rename = "chunk_summary_brief")]
    ChunkSummaryBrief,
}

impl ChunkDeriveDerivationType {
    pub fn as_str(self) -> &'static str {
        match self {
            ChunkDeriveDerivationType::ChunkSummaryDetailed => "chunk_summary_detailed",
            ChunkDeriveDerivationType::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

/// TS `getChunkText(transaction, chunkId, derivationType = "chunk_summary_detailed")`.
///
/// Phase 1: `None` represents the omitted third argument (TS default
/// `chunk_summary_detailed`). Phase 2 must apply that default before read.
/// Returns compact material (domain type, not crate-root).
pub fn get_chunk_text(
    transaction: &DbReadTransaction,
    chunk_id: &str,
    derivation_type: Option<ChunkDeriveDerivationType>,
) -> CompactChunkMaterial {
    let derivation_type =
        derivation_type.unwrap_or(ChunkDeriveDerivationType::ChunkSummaryDetailed);
    compact_chunk_material_from_stored_members(transaction.db, chunk_id, derivation_type)
}

/// TS `TurnChunkStructure`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChunkStructure {
    pub turns: Vec<TurnStructureRow>,
    pub chunks: Vec<ChunkStructureRow>,
}

/// Step edges of one turn from its host-supplied step indices (any status).
pub fn read_turn_steps(db: &Db, turn_id: &str) -> StepEdges {
    step_edges(&read_step_members(db, turn_id))
}

/// The open turn's step facts for a host pressure decision (turn parts,
/// AC-7.1): identity, the sum of stored member estimates, and the step edges
/// read from host-supplied step indices. Deterministic, inference-free, no
/// writes. None only when the record holds no open turn (a damaged thread;
/// the state machine otherwise keeps exactly one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTurnSteps {
    pub turn_id: String,
    pub estimated_tokens: i64,
    pub edges: StepEdges,
}

pub fn read_active_turn_steps(db: &Db) -> Option<ActiveTurnSteps> {
    let turn_id = select_open_turn_ids_for_steps(db).into_iter().next()?;
    let estimated_tokens = db
        .prepare(
            "SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message WHERE turn_id = ? AND deleted_at IS NULL",
        )
        .get_params(&[crate::shared_tech::storage::SqlParam::from(turn_id.as_str())])
        .and_then(|row| row.get("total").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    Some(ActiveTurnSteps {
        edges: read_turn_steps(db, &turn_id),
        turn_id,
        estimated_tokens,
    })
}

pub fn read_turn_chunk_structure(db: &Db) -> TurnChunkStructure {
    TurnChunkStructure {
        turns: read_turn_structure(db),
        chunks: read_chunk_structure(db),
    }
}

// Cross-domain compact hook. The caller owns the surrounding transaction;
// turns owns validation and removal of its derived chunk rows.
/// TS `dropUnreadableChunks`.
pub fn drop_unreadable_chunks(db: &Db, chunk_ids: &[String]) -> Vec<String> {
    drop_empty_readable_chunks(db, chunk_ids)
}

/// TS `report` opts: `{ notReady?; turnId?; chunkId? }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnReportOpts {
    pub not_ready: Option<bool>,
    pub turn_id: Option<String>,
    pub chunk_id: Option<String>,
}

/// TS `report`.
pub async fn report(
    thread_ref: ThreadRef,
    opts: Option<&TurnReportOpts>,
) -> OpResult<Vec<DerivationReportEntry>> {
    let report_opts = match opts {
        Some(o) => TurnReportOptions {
            not_ready: o.not_ready,
            turn_id: o.turn_id.clone(),
            chunk_id: o.chunk_id.clone(),
        },
        None => TurnReportOptions::default(),
    };
    let result = AssertUnwindSafe(create_db_read_transaction(thread_ref, move |transaction| {
        Box::pin(async move { report_turn_derivations(transaction.db, &report_opts) })
    }))
    .catch_unwind()
    .await;

    match result {
        Ok(OpResult::Ok { value }) => OpResult::Ok { value },
        Ok(OpResult::Err { error }) => OpResult::Err { error },
        Err(payload) => storage_failure(&format!("report read failed: {}", panic_detail(payload))),
    }
}

/// TS `TurnDeriveResult` — Deserialize stays serde-tagged (`outcome`);
/// Serialize emits TS construction order (`turnId` before `outcome`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TurnDeriveResult {
    #[serde(rename_all = "camelCase")]
    Derived {
        turn_id: String,
        source_version: i64,
    },
    #[serde(rename_all = "camelCase")]
    Failed { turn_id: String, error: ErrorResult },
}

impl Serialize for TurnDeriveResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            TurnDeriveResult::Derived {
                turn_id,
                source_version,
            } => {
                let mut state = serializer.serialize_struct("TurnDeriveResult", 3)?;
                state.serialize_field("turnId", turn_id)?;
                state.serialize_field("outcome", "derived")?;
                state.serialize_field("sourceVersion", source_version)?;
                state.end()
            }
            TurnDeriveResult::Failed { turn_id, error } => {
                let mut state = serializer.serialize_struct("TurnDeriveResult", 3)?;
                state.serialize_field("turnId", turn_id)?;
                state.serialize_field("outcome", "failed")?;
                state.serialize_field("error", error)?;
                state.end()
            }
        }
    }
}

/// TS `ChunkDeriveResult` — Deserialize stays serde-tagged (`outcome`);
/// Serialize emits TS construction order from
/// `{ chunkId, derivationType, ...result }` where `result` inserts
/// `outcome, sourceVersion` → `chunkId, derivationType, outcome, sourceVersion`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ChunkDeriveResult {
    #[serde(rename_all = "camelCase")]
    Derived {
        chunk_id: String,
        derivation_type: ChunkDeriveDerivationType,
        source_version: i64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        chunk_id: String,
        error: ErrorResult,
    },
}

impl Serialize for ChunkDeriveResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            ChunkDeriveResult::Derived {
                chunk_id,
                derivation_type,
                source_version,
            } => {
                let mut state = serializer.serialize_struct("ChunkDeriveResult", 4)?;
                state.serialize_field("chunkId", chunk_id)?;
                state.serialize_field("derivationType", derivation_type)?;
                state.serialize_field("outcome", "derived")?;
                state.serialize_field("sourceVersion", source_version)?;
                state.end()
            }
            ChunkDeriveResult::Failed { chunk_id, error } => {
                let mut state = serializer.serialize_struct("ChunkDeriveResult", 3)?;
                state.serialize_field("chunkId", chunk_id)?;
                state.serialize_field("outcome", "failed")?;
                state.serialize_field("error", error)?;
                state.end()
            }
        }
    }
}

enum ConfigRequiredResult {
    Ok(ResolvedSdkConfig),
    Err { error: ErrorResult },
}

fn config_required(operation: &str) -> ConfigRequiredResult {
    match resolve_instance_config() {
        Some(config) => ConfigRequiredResult::Ok(config),
        None => ConfigRequiredResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::InferenceUnavailable,
                reason: format!(
                    "{operation} requires an initialized LHC SDK inference configuration"
                ),
                event_index: None,
            },
        },
    }
}

/// TS `deriveTurn`.
pub async fn derive_turn(thread_ref: ThreadRef, turn_id: &str) -> OpResult<TurnDeriveResult> {
    let config = match config_required("turns.deriveTurn") {
        ConfigRequiredResult::Ok(config) => config,
        ConfigRequiredResult::Err { error } => return OpResult::Err { error },
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
    let turn_id = turn_id.to_string();
    let result = AssertUnwindSafe(async {
        let source_ref = WorkSourceRef::Turn {
            turn_id: turn_id.clone(),
        };
        let assembly_result = derive_turn_owned_in_open_db(
            &db,
            &config,
            WorkKind::TurnDerivation,
            &source_ref,
            &[
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: turn_id.clone(),
                    derivation_type: "turn_rendering".into(),
                },
                EnqueueDerivationTarget {
                    subject_kind: SubjectKind::Turn,
                    subject_id: turn_id.clone(),
                    derivation_type: "pre_detailed_assembly".into(),
                },
            ],
            None,
        )
        .await;
        if let TurnOwnedDeriveResult::Failed { error } = assembly_result {
            return OpResult::Ok {
                value: TurnDeriveResult::Failed {
                    turn_id: turn_id.clone(),
                    error,
                },
            };
        }
        let result = derive_turn_owned_in_open_db(
            &db,
            &config,
            WorkKind::DetailedTurnCompression,
            &source_ref,
            &[EnqueueDerivationTarget {
                subject_kind: SubjectKind::Turn,
                subject_id: turn_id.clone(),
                derivation_type: "detailed_turn_compression".into(),
            }],
            None,
        )
        .await;
        OpResult::Ok {
            value: match result {
                TurnOwnedDeriveResult::Derived { source_version } => TurnDeriveResult::Derived {
                    turn_id: turn_id.clone(),
                    source_version,
                },
                TurnOwnedDeriveResult::Failed { error } => TurnDeriveResult::Failed {
                    turn_id: turn_id.clone(),
                    error,
                },
            },
        }
    })
    .catch_unwind()
    .await;
    db.close();
    match result {
        Ok(value) => value,
        Err(payload) => storage_failure(&format!("derive failed: {}", panic_detail(payload))),
    }
}

async fn derive_chunk(
    thread_ref: ThreadRef,
    chunk_id: &str,
    derivation_type: ChunkDeriveDerivationType,
) -> OpResult<ChunkDeriveResult> {
    let operation = match derivation_type {
        ChunkDeriveDerivationType::ChunkSummaryDetailed => "turns.deriveDetailedChunk",
        ChunkDeriveDerivationType::ChunkSummaryBrief => "turns.deriveBriefChunk",
    };
    let config = match config_required(operation) {
        ConfigRequiredResult::Ok(config) => config,
        ConfigRequiredResult::Err { error } => return OpResult::Err { error },
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
    let chunk_id = chunk_id.to_string();
    let kind = match derivation_type {
        ChunkDeriveDerivationType::ChunkSummaryDetailed => WorkKind::ChunkSummaryDetailed,
        ChunkDeriveDerivationType::ChunkSummaryBrief => WorkKind::ChunkSummaryBrief,
    };
    let result = AssertUnwindSafe(async {
        let source_ref = WorkSourceRef::Chunk {
            chunk_id: chunk_id.clone(),
        };
        let owned = derive_turn_owned_in_open_db(
            &db,
            &config,
            kind,
            &source_ref,
            &[EnqueueDerivationTarget {
                subject_kind: SubjectKind::Chunk,
                subject_id: chunk_id.clone(),
                derivation_type: derivation_type.as_str().to_string(),
            }],
            None,
        )
        .await;
        OpResult::Ok {
            value: match owned {
                TurnOwnedDeriveResult::Derived { source_version } => ChunkDeriveResult::Derived {
                    chunk_id: chunk_id.clone(),
                    derivation_type,
                    source_version,
                },
                TurnOwnedDeriveResult::Failed { error } => ChunkDeriveResult::Failed {
                    chunk_id: chunk_id.clone(),
                    error,
                },
            },
        }
    })
    .catch_unwind()
    .await;
    db.close();
    match result {
        Ok(value) => value,
        Err(payload) => storage_failure(&format!("derive failed: {}", panic_detail(payload))),
    }
}

/// TS `deriveDetailedChunk`.
pub async fn derive_detailed_chunk(
    thread_ref: ThreadRef,
    chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    derive_chunk(
        thread_ref,
        chunk_id,
        ChunkDeriveDerivationType::ChunkSummaryDetailed,
    )
    .await
}

/// TS `deriveBriefChunk`.
pub async fn derive_brief_chunk(
    thread_ref: ThreadRef,
    chunk_id: &str,
) -> OpResult<ChunkDeriveResult> {
    derive_chunk(
        thread_ref,
        chunk_id,
        ChunkDeriveDerivationType::ChunkSummaryBrief,
    )
    .await
}

// Keep Phase-2 import graph + private helpers type-referenced without
// calling todo bodies. CompactChunkMaterial / TurnStructureRow /
// ChunkStructureRow stay in `internal::*` (TS index does not name-export them).
const _: fn() = || {
    let _ = select_open_turn_ids as fn(&Db) -> Vec<String>;
    let _ = count_turn_members as fn(&Db, &str) -> i64;
    let _ = next_turn_order as fn(&Db) -> i64;
    let _ = insert_open_turn as fn(&Db, i64, i64) -> String;
    let _ = close_turn as fn(&Db, &str, i64, &TurnCloseHostFacts);
    let _ = read_turn_structure as fn(&Db) -> Vec<TurnStructureRow>;
    let _ = read_chunk_structure as fn(&Db) -> Vec<ChunkStructureRow>;
    let _ = compact_chunk_material_from_stored_members
        as fn(&Db, &str, ChunkDeriveDerivationType) -> CompactChunkMaterial;
    let _ = current_open_turn_id;
    let _ = close_turn_and_queue_work;
    let _ = host_facts_from_turn_end;
    let _ = thread_not_found::<()>;
    let _ = config_required;
    let _ = derive_chunk;
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::errors::{ErrorClass, ErrorCode};
    use crate::shared_tech::js_json::js_json_stringify_of;
    use serde_json::json;

    #[test]
    fn turn_derive_result_derived_wire_shape_round_trips() {
        let v = TurnDeriveResult::Derived {
            turn_id: "t1".into(),
            source_version: 2,
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "turnId": "t1",
                "outcome": "derived",
                "sourceVersion": 2,
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"turnId":"t1","outcome":"derived","sourceVersion":2}"#
        );
        let back: TurnDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn turn_derive_result_failed_wire_shape_round_trips() {
        let v = TurnDeriveResult::Failed {
            turn_id: "t2".into(),
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::TurnNotFound,
                reason: "missing".into(),
                event_index: None,
            },
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "turnId": "t2",
                "outcome": "failed",
                "error": {
                    "errorClass": "caller_error",
                    "code": "turn_not_found",
                    "reason": "missing",
                },
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"turnId":"t2","outcome":"failed","error":{"errorClass":"caller_error","code":"turn_not_found","reason":"missing"}}"#
        );
        let back: TurnDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn chunk_derive_result_derived_wire_shape_round_trips() {
        let v = ChunkDeriveResult::Derived {
            chunk_id: "c1".into(),
            derivation_type: ChunkDeriveDerivationType::ChunkSummaryDetailed,
            source_version: 3,
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "chunkId": "c1",
                "derivationType": "chunk_summary_detailed",
                "outcome": "derived",
                "sourceVersion": 3,
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"chunkId":"c1","derivationType":"chunk_summary_detailed","outcome":"derived","sourceVersion":3}"#
        );
        let back: ChunkDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn chunk_derive_result_failed_wire_shape_round_trips() {
        let v = ChunkDeriveResult::Failed {
            chunk_id: "c2".into(),
            error: ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::ProviderFailure,
                reason: "boom".into(),
                event_index: None,
            },
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "chunkId": "c2",
                "outcome": "failed",
                "error": {
                    "errorClass": "system_error",
                    "code": "provider_failure",
                    "reason": "boom",
                },
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"chunkId":"c2","outcome":"failed","error":{"errorClass":"system_error","code":"provider_failure","reason":"boom"}}"#
        );
        let back: ChunkDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }
}
