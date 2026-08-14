//! Ported from packages/lhc/src/sdk.ts.
//!
//! Public SDK surface: namespace bindings, init_lhc, work/logging/thread-view/
//! inspect surfaces, and the type/value re-exports that mirror sdk.ts.

// ── Canonical public re-exports (sdk.ts) ─────────────────────────────

pub use crate::intake_stream::{BatchResult, EventKind, EventRecord, MessageEventInput};
pub use crate::messages::{
    Block, BlockType, MessageDetail, MessageListOptions, MessageRecord, MutationResult,
};
pub use crate::retrieval::{
    DEFAULT_RETRIEVAL_TOKEN_BUDGET, ImpressionRecord, MAX_RETRIEVAL_IDS_PER_CALL,
    MAX_RETRIEVAL_OUTPUT_TOKENS, RETRIEVAL_SLICE_FLOOR, RetrievalOptions, RetrievalReceipt,
    RetrievedMessage, RetrievedTurn, RetrievedTurnSource, SliceReceipt, UnservedEntity,
    UnservedReason, clamp_id_echo,
};
// Compact-continuation pure contract (LIM-60 / LIM-62) plus live runtime
// surface (LIM-61 / LIM-63A) mirroring TS `compactContinuation` namespace.
pub use crate::shared_tech::compact_continuation::{
    COMPACT_CONTINUATION_CONTRACT_VERSION, COMPACT_CONTINUATION_HOST_CAPABILITIES,
    COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE, COMPACT_CONTINUATION_INVARIANTS,
    COMPACT_CONTINUATION_MARKER_ACTION, COMPACT_CONTINUATION_MARKER_CAUSE,
    COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX, COMPACT_CONTINUATION_MARKER_KIND,
    COMPACT_CONTINUATION_OUTCOME_KINDS, COMPACT_CONTINUATION_REFUSE_CODES,
    COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE, COMPACT_CONTINUATION_SKIP_CODES,
    COMPACT_CONTINUATION_STATES, COMPACT_CONTINUATION_TRANSITION_ORDER,
    COMPACT_CONTINUATION_WRITER_CLAIMS, CONTEXT_COMPACT_CONTINUE_REASON,
    CompactContinuationDecision, CompactContinuationEffect, CompactContinuationEffectType,
    CompactContinuationHostCapability, CompactContinuationInput, CompactContinuationInvariantId,
    CompactContinuationInvariants, CompactContinuationLowerTargetReceipt,
    CompactContinuationMarkerSemantics, CompactContinuationOutcomeKind, CompactContinuationPolicy,
    CompactContinuationPressureReceipt, CompactContinuationReceipt, CompactContinuationRefuseCode,
    CompactContinuationResidualState, CompactContinuationSeam, CompactContinuationSkipCode,
    CompactContinuationState, CompactContinuationTransitionStep, CompactMaterialFacts,
    ForcedContinuationBoundary, LhcRenderedHistoryAccounting, PostMeasurementEstimate,
    ProviderReportedInputAccounting, ProviderUsageAuthority, SourceLabelledEstimateAccounting,
    TokenAccountingDomain, ValidationIssue, ValidationResult, WorkContinuation, WriterClaim,
    as_compact_continuation_input, assert_decision_parity,
    compact_continuation_marker_idempotency_key, decide_compact_continuation,
    validate_compact_continuation_decision, validate_compact_continuation_input,
    validate_compact_continuation_receipt,
};
// Live staged runtime (provider-neutral). Test hooks stay crate-internal /
// fixture-only (not re-exported here).
pub use crate::compact_continuation::{
    AttemptRow, BoundaryRow, BoundaryStatus, CompactContinuationHostFacts,
    CompactContinuationRunResult, ForceIntentRow, StageName, StoredCompactContinuationReceipt,
    ToolPairProof, WriterClaimRow, compute_attempt_intent, compute_operation_identity,
    compute_retry_posture, get_compact_continuation_receipt, get_compact_continuation_writer_claim,
    get_pending_compact_continuation_boundary, has_compact_continuation_marker,
    hash_attempt_intent, hash_record, list_compact_continuation_boundaries,
    list_compact_continuation_receipts, list_compact_continuation_stages, prove_pending_tool_pair,
    run_compact_continuation, validate_host_facts,
};
pub use crate::shared_tech::context::{set_scheduler_poke, set_thread_touch};
pub use crate::shared_tech::derivation::{
    CompletionTx, DependencyGap, Derivation, DerivationMetadata, DerivationReportEntry,
    DerivationState, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext, InferenceCallbacks,
    InferenceResult, ProviderProvenance, RenderingPart, ResolvedSdkConfig, SdkConfig, SubjectKind,
    ToolOutcome, ToolResultClassification, ToolResultFacts, ToolResultOperationClass,
    ToolResultPromptMode, ToolResultResponseShape, WorkHandler,
};
pub use crate::shared_tech::deterministic::{
    DeterministicOpName, create_deterministic_inference_callbacks, deterministic_outcomes_suffix,
    deterministic_text,
};
pub use crate::shared_tech::durable_work::{
    DurableWorkDispatchResult, DurableWorkDispatcher, DurableWorkDispatcherMap,
    DurableWorkOperation, apply_derivation_success,
};
use crate::shared_tech::errors::storage_failure;
pub use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
pub use crate::shared_tech::inference_types::{
    InferenceConfig, ModelAssignment, ModelCall, ModelCallFailureKind, ModelCallInput,
    ModelCallResult,
};
pub use crate::shared_tech::inspect::{HealthReport, InspectOverview, ViewContentsReport};
pub use crate::shared_tech::logging::{
    LogEntry, LogLevel, LogQuery, StoredLogEntry, query_log, write_log,
};
pub use crate::shared_tech::persist::{
    DbReadTransaction, DbWriteTransaction, PostCommitHook, create_db_read_transaction,
    create_db_write_transaction,
};
pub use crate::shared_tech::prompts::{DEFAULT_PROMPT_NAMES, PROMPT_NAMES};
pub use crate::shared_tech::scheduler::{DrainReport, Scheduler, SchedulerMode};
pub use crate::shared_tech::token_counting::{
    TOKEN_ESTIMATOR_ID, TokenSlice, estimate_tokens, slice_tokens,
};
pub use crate::shared_tech::view::{
    Band, CompactReceipt, LlmRequestContext, LlmRequestContextMessage, LlmRequestContextPart,
    PreviewCompactOutcome, PreviewCompactResult, PruneReceipt, ResolvedViewConfig, SdkViewConfig,
    SessionAssistantMessage, SessionAssistantPart, SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry, SessionThreadView, SessionThreadViewEntry,
    SessionThreadViewEntrySource, SessionThreadViewMessage, SessionToolResultMessage,
    SessionUserMessage, StoredView, ViewCompactParams, ViewProfile, ViewProfileOverride,
    ViewStatus, VisibilityBudgets,
};
pub use crate::shared_tech::work_queue::{
    ClaimedWorkItem, EnqueueDerivationTarget, EnqueueInput, QueueDetailRow, WorkHandlerMap,
    WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef, count_live_items, enqueue,
    map_work_q_handlers, queue_detail, supersede_queued, work_kind_registry,
};
/// Thread-view config constants only — `MaterializeResult` stays on `thread_view`
/// (sdk.ts materialize uses an anonymous return shape; no named type export).
pub use crate::thread_view::{BUILT_IN_PROFILES, DEFAULT_COMPACT_THRESHOLD, DEFAULT_VISIBILITY};
pub use crate::threads::{ThreadFileInfo, ThreadRef};
pub use crate::turns::{ChunkRecord, TurnRecord};

// ── Construction / private helpers ───────────────────────────────────

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use indexmap::IndexMap;

use crate::messages::internal::derive::{
    DispatchMessageDeriveWorkItem, dispatch_message_derive_work,
};
use crate::messages::internal::handlers::MESSAGE_WORK_HANDLERS;
use crate::messages::{
    self, EditInput, MessageCreateResult, MessageDeriveResult, MessageReportOpts, RecordedEvent,
    RemoveInput,
};
use crate::shared_tech::context::{
    InstanceSeam, run_with_instance_seam, run_with_instance_seam_sync,
};
use crate::shared_tech::derivation::{
    BriefTargets, ChunkPolicyConfig, Clock, CompressionTargets, LeaseConfig, SdkMode,
    ToolResultConfig,
};
use crate::shared_tech::durable_work::{DurableWorkDispatcherItem, DurableWorkOperationName};
use crate::shared_tech::inference_adapter::create_inference_callbacks;
use crate::shared_tech::inference_types::{
    ResolvedDerivationGuards, ResolvedInferenceConfig, ThinkingLevel, resolve_guards,
};
use crate::shared_tech::js_json::js_string_of_number;
use crate::shared_tech::logging::{
    DerivationLogQuery, StoredDerivationLogEntry, query_derivation_log,
};
use crate::shared_tech::persist::DbTransaction;
use crate::shared_tech::prompts::registry_get;
use crate::shared_tech::scheduler::{
    DrainDeps, DrainOpenOpts, create_scheduler, peek_thread_id, run_drain,
};
use crate::shared_tech::storage::Db;
use crate::thread_view::{
    self, CompactOpts, MaterializeOpts, MaterializeResult, PruneParams, resolve_view_config,
};
use crate::threads::{
    self, ListThreadsInput, NewThreadInput, NewThreadResult, ResolveInput, ResolvedThreadPath,
    ThreadInfo, open_thread_database,
};
use crate::turns::internal::chunk_recovery::CompactChunkMaterial;
use crate::turns::internal::derive::{
    DispatchTurnOwnedWorkItem, TURN_WORK_HANDLERS, dispatch_turn_owned_work,
};
use crate::turns::{
    self, ChunkDeriveDerivationType, ChunkDeriveResult, RecordedTurnEvent, TurnChunkStructure,
    TurnDeriveResult, TurnReportOpts, TurnTransitionOutcome,
};
use crate::{inspect, intake_stream};

// TS `WORK_KIND_REGISTRY` Record → canonical Rust exhaustive fn
// [`work_kind_registry`] (Wave 0/2 ruling). No SCREAMING alias at root.

// ── Surfaces ─────────────────────────────────────────────────────────

/// TS inline `{ maxItems?: number }` for [`WorkSurface::drain`].
/// Not a named sdk.ts export — Rust construction bag only (Wave 7 judgment).
/// Public under `lhc::sdk` for Cargo API construction; not a crate-root re-export.
/// No `Default`: optionality is the outer `Option<DrainOpts>`.
#[derive(Debug, Clone)]
pub struct DrainOpts {
    pub max_items: Option<i64>,
}

/// TS `WorkSurface` — opaque carrier for this SDK instance's delivery seam.
/// Not `Copy`: clones share `Arc<InstanceSeam>` (Promise-race drain spawns use `.clone()`).
#[derive(Clone)]
pub struct WorkSurface {
    seam: Arc<InstanceSeam>,
    drain_deps: Arc<DrainDeps>,
}

impl WorkSurface {
    fn new(seam: Arc<InstanceSeam>, drain_deps: Arc<DrainDeps>) -> Self {
        Self { seam, drain_deps }
    }

    pub async fn drain(&self, ref_: ThreadRef, opts: Option<DrainOpts>) -> OpResult<DrainReport> {
        let seam = Arc::clone(&self.seam);
        let drain_deps = Arc::clone(&self.drain_deps);
        run_with_instance_seam(seam, async move {
            let resolved_ref = threads::resolve_thread_ref(ref_).await;
            let file_path = match resolved_ref {
                OpResult::Ok { value } => value.file_path,
                OpResult::Err { error } => return OpResult::Err { error },
            };
            let open_opts = opts.map(|o| DrainOpenOpts {
                max_items: o.max_items,
            });
            run_drain(&file_path, drain_deps.as_ref(), open_opts).await
        })
        .await
    }
}

/// TS `LoggingSurface` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LoggingSurface {
    seam: Arc<InstanceSeam>,
    clock: Clock,
}

impl LoggingSurface {
    fn new(seam: Arc<InstanceSeam>, clock: Clock) -> Self {
        Self { seam, clock }
    }

    pub async fn write(&self, ref_: ThreadRef, entry: LogEntry) -> OpResult<()> {
        use futures::FutureExt;
        use std::panic::AssertUnwindSafe;

        let seam = Arc::clone(&self.seam);
        let clock = Arc::clone(&self.clock);
        // TS sdk.ts wraps each logging transaction in try/catch; Rust helpers
        // re-panic callback/SQL/close failures — contain at the SDK boundary.
        let fut = run_with_instance_seam(seam, async move {
            match create_db_write_transaction(
                ref_,
                move |transaction| {
                    let entry = entry.clone();
                    Box::pin(async move {
                        write_log(DbTransaction::Write(transaction), &entry);
                    })
                },
                Some(clock),
            )
            .await
            {
                OpResult::Ok { .. } => OpResult::Ok { value: () },
                OpResult::Err { error } => OpResult::Err { error },
            }
        });
        match AssertUnwindSafe(fut).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => {
                storage_failure(&format!("log write failed: {}", panic_detail(payload)))
            }
        }
    }

    pub async fn query(&self, ref_: ThreadRef, q: LogQuery) -> OpResult<Vec<StoredLogEntry>> {
        use futures::FutureExt;
        use std::panic::AssertUnwindSafe;

        let seam = Arc::clone(&self.seam);
        let fut = run_with_instance_seam(seam, async move {
            create_db_read_transaction(ref_, move |transaction| {
                let q = q.clone();
                Box::pin(async move { query_log(transaction.db, &q) })
            })
            .await
        });
        match AssertUnwindSafe(fut).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => {
                storage_failure(&format!("log query failed: {}", panic_detail(payload)))
            }
        }
    }

    pub async fn query_derivation_log(
        &self,
        ref_: ThreadRef,
        q: DerivationLogQuery,
    ) -> OpResult<Vec<StoredDerivationLogEntry>> {
        use futures::FutureExt;
        use std::panic::AssertUnwindSafe;

        let seam = Arc::clone(&self.seam);
        let fut = run_with_instance_seam(seam, async move {
            create_db_read_transaction(ref_, move |transaction| {
                let q = q.clone();
                Box::pin(async move { query_derivation_log(transaction.db, &q) })
            })
            .await
        });
        match AssertUnwindSafe(fut).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => storage_failure(&format!(
                "derivation log query failed: {}",
                panic_detail(payload)
            )),
        }
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

/// TS `ThreadViewSurface` — operations only (config is construction machinery).
/// Opaque per-instance seam carrier.
#[derive(Clone)]
pub struct ThreadViewSurface {
    seam: Arc<InstanceSeam>,
}

impl ThreadViewSurface {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn get_llm_request_context(&self, ref_: ThreadRef) -> OpResult<LlmRequestContext> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move {
            thread_view::get_llm_request_context(ref_).await
        })
        .await
    }

    pub async fn get_session_thread_view(&self, ref_: ThreadRef) -> OpResult<SessionThreadView> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move {
            thread_view::get_session_thread_view(ref_).await
        })
        .await
    }

    pub async fn status(&self, ref_: ThreadRef) -> OpResult<ViewStatus> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { thread_view::status(ref_).await }).await
    }

    pub async fn prune(
        &self,
        ref_: ThreadRef,
        params: Option<PruneParams>,
    ) -> OpResult<PruneReceipt> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { thread_view::prune(ref_, params).await }).await
    }

    pub async fn describe(&self, ref_: ThreadRef) -> OpResult<Option<StoredView>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { thread_view::describe(ref_).await }).await
    }

    pub async fn preview_compact(
        &self,
        ref_: ThreadRef,
        opts: CompactOpts,
    ) -> OpResult<PreviewCompactOutcome> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move {
            thread_view::preview_compact(ref_, opts).await
        })
        .await
    }

    pub async fn compact(&self, ref_: ThreadRef, opts: CompactOpts) -> OpResult<CompactReceipt> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { thread_view::compact(ref_, opts).await }).await
    }

    pub async fn materialize(
        &self,
        ref_: ThreadRef,
        opts: MaterializeOpts,
    ) -> OpResult<MaterializeResult> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(
            seam,
            async move { thread_view::materialize(ref_, opts).await },
        )
        .await
    }
}

/// TS `typeof inspectDomain` — opaque carrier; methods forward to [`crate::inspect`].
#[derive(Clone)]
pub struct InspectSurface {
    seam: Arc<InstanceSeam>,
}

impl InspectSurface {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn overview(&self, ref_: ThreadRef) -> OpResult<InspectOverview> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { inspect::overview(ref_).await }).await
    }

    pub async fn health(&self, ref_: ThreadRef) -> OpResult<HealthReport> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { inspect::health(ref_).await }).await
    }

    pub async fn view(&self, ref_: ThreadRef) -> OpResult<ViewContentsReport> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { inspect::view(ref_).await }).await
    }
}

/// TS `typeof messagesDomain` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LhcMessages {
    seam: Arc<InstanceSeam>,
}

impl LhcMessages {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub fn create(
        &self,
        transaction: &DbWriteTransaction,
        recorded_event: &RecordedEvent,
        turn_id: &str,
    ) -> MessageCreateResult {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam_sync(seam, || {
            messages::create(transaction, recorded_event, turn_id)
        })
    }

    pub async fn list(
        &self,
        thread_ref: ThreadRef,
        filter: Option<MessageListOptions>,
    ) -> OpResult<Vec<MessageRecord>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(
            seam,
            async move { messages::list(thread_ref, filter).await },
        )
        .await
    }

    pub fn read_live_messages(&self, db: &Db) -> Vec<MessageRecord> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam_sync(seam, || messages::read_live_messages(db))
    }

    pub async fn show(&self, thread_ref: ThreadRef, message_id: &str) -> OpResult<MessageDetail> {
        let seam = Arc::clone(&self.seam);
        let message_id = message_id.to_string();
        run_with_instance_seam(seam, async move {
            messages::show(thread_ref, &message_id).await
        })
        .await
    }

    pub async fn report(
        &self,
        thread_ref: ThreadRef,
        opts: Option<MessageReportOpts>,
    ) -> OpResult<Vec<DerivationReportEntry>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(
            seam,
            async move { messages::report(thread_ref, opts).await },
        )
        .await
    }

    pub async fn derive(
        &self,
        thread_ref: ThreadRef,
        message_ids: &[String],
    ) -> OpResult<Vec<MessageDeriveResult>> {
        let seam = Arc::clone(&self.seam);
        let message_ids = message_ids.to_vec();
        run_with_instance_seam(seam, async move {
            messages::derive(thread_ref, &message_ids).await
        })
        .await
    }

    pub async fn edit(&self, thread_ref: ThreadRef, edit: EditInput) -> OpResult<MutationResult> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { messages::edit(thread_ref, edit).await }).await
    }

    pub async fn remove(
        &self,
        thread_ref: ThreadRef,
        removal: RemoveInput,
    ) -> OpResult<MutationResult> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(
            seam,
            async move { messages::remove(thread_ref, removal).await },
        )
        .await
    }

    /// TS `sdk.messages.cleanPrompt` — wraps through the instance seam.
    pub fn clean_prompt(&self, text: &str) -> String {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam_sync(seam, || messages::clean_prompt(text))
    }
}

/// TS `typeof threadsDomain` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LhcThreads {
    seam: Arc<InstanceSeam>,
}

impl LhcThreads {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn new_thread(&self, input: NewThreadInput) -> OpResult<NewThreadResult> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { threads::new_thread(input).await }).await
    }

    pub async fn resolve(&self, input: ResolveInput) -> OpResult<ThreadInfo> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { threads::resolve(input).await }).await
    }

    pub async fn list_threads(&self, input: Option<ListThreadsInput>) -> OpResult<Vec<ThreadInfo>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { threads::list_threads(input).await }).await
    }

    pub async fn info(&self, ref_: ThreadRef) -> OpResult<ThreadFileInfo> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { threads::info(ref_).await }).await
    }

    pub async fn resolve_thread_ref(&self, ref_: ThreadRef) -> OpResult<ResolvedThreadPath> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { threads::resolve_thread_ref(ref_).await }).await
    }

    pub fn open_thread_database(&self, file_path: &str) -> OpResult<Db> {
        let seam = Arc::clone(&self.seam);
        let file_path = file_path.to_string();
        run_with_instance_seam_sync(seam, || open_thread_database(&file_path))
    }
}

/// TS `typeof intakeStreamDomain & { initLhc }` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LhcIntakeStream {
    seam: Arc<InstanceSeam>,
}

/// TS `IntakeStreamSurface`.
pub type IntakeStreamSurface = LhcIntakeStream;

impl LhcIntakeStream {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn message_events(
        &self,
        thread_ref: ThreadRef,
        events: &[MessageEventInput],
    ) -> OpResult<BatchResult> {
        let seam = Arc::clone(&self.seam);
        let events = events.to_vec();
        run_with_instance_seam(seam, async move {
            intake_stream::message_events(thread_ref, &events).await
        })
        .await
    }

    pub async fn list_events(&self, thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(
            seam,
            async move { intake_stream::list_events(thread_ref).await },
        )
        .await
    }

    /// TS `intakeStream.initLhc` — same function as crate-root [`init_lhc`].
    pub fn init_lhc(&self, config: SdkConfig) -> Lhc {
        init_lhc(config)
    }
}

/// TS `typeof turnsDomain` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LhcTurns {
    seam: Arc<InstanceSeam>,
}

impl LhcTurns {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub fn create(
        &self,
        transaction: &DbWriteTransaction,
        recorded_event: &RecordedTurnEvent,
    ) -> TurnTransitionOutcome {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam_sync(seam, || turns::create(transaction, recorded_event))
    }

    pub async fn list_turns(&self, thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { turns::list_turns(thread_ref).await }).await
    }

    pub async fn list_chunks(&self, thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move { turns::list_chunks(thread_ref).await }).await
    }

    pub fn get_chunk_text(
        &self,
        transaction: &DbReadTransaction,
        chunk_id: &str,
        derivation_type: Option<ChunkDeriveDerivationType>,
    ) -> CompactChunkMaterial {
        let seam = Arc::clone(&self.seam);
        let chunk_id = chunk_id.to_string();
        run_with_instance_seam_sync(seam, || {
            turns::get_chunk_text(transaction, &chunk_id, derivation_type)
        })
    }

    pub fn read_turn_chunk_structure(&self, db: &Db) -> TurnChunkStructure {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam_sync(seam, || turns::read_turn_chunk_structure(db))
    }

    pub async fn report(
        &self,
        thread_ref: ThreadRef,
        opts: Option<&TurnReportOpts>,
    ) -> OpResult<Vec<DerivationReportEntry>> {
        let seam = Arc::clone(&self.seam);
        let opts = opts.cloned();
        run_with_instance_seam(seam, async move {
            turns::report(thread_ref, opts.as_ref()).await
        })
        .await
    }

    pub async fn derive_turn(
        &self,
        thread_ref: ThreadRef,
        turn_id: &str,
    ) -> OpResult<TurnDeriveResult> {
        let seam = Arc::clone(&self.seam);
        let turn_id = turn_id.to_string();
        run_with_instance_seam(seam, async move {
            turns::derive_turn(thread_ref, &turn_id).await
        })
        .await
    }

    pub async fn derive_detailed_chunk(
        &self,
        thread_ref: ThreadRef,
        chunk_id: &str,
    ) -> OpResult<ChunkDeriveResult> {
        let seam = Arc::clone(&self.seam);
        let chunk_id = chunk_id.to_string();
        run_with_instance_seam(seam, async move {
            turns::derive_detailed_chunk(thread_ref, &chunk_id).await
        })
        .await
    }

    pub async fn derive_brief_chunk(
        &self,
        thread_ref: ThreadRef,
        chunk_id: &str,
    ) -> OpResult<ChunkDeriveResult> {
        let seam = Arc::clone(&self.seam);
        let chunk_id = chunk_id.to_string();
        run_with_instance_seam(seam, async move {
            turns::derive_brief_chunk(thread_ref, &chunk_id).await
        })
        .await
    }
}

/// TS `typeof retrievalDomain` — opaque carrier; methods forward to [`crate::retrieval`].
#[derive(Clone)]
pub struct RetrievalSurface {
    seam: Arc<InstanceSeam>,
}

impl RetrievalSurface {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn get_turns(
        &self,
        ref_: ThreadRef,
        turn_ids: &[String],
        options: Option<RetrievalOptions>,
    ) -> OpResult<RetrievalReceipt<RetrievedTurn>> {
        let seam = Arc::clone(&self.seam);
        let turn_ids = turn_ids.to_vec();
        run_with_instance_seam(seam, async move {
            crate::retrieval::get_turns(ref_, &turn_ids, options).await
        })
        .await
    }

    pub async fn get_messages(
        &self,
        ref_: ThreadRef,
        message_ids: &[String],
        options: Option<RetrievalOptions>,
    ) -> OpResult<RetrievalReceipt<RetrievedMessage>> {
        let seam = Arc::clone(&self.seam);
        let message_ids = message_ids.to_vec();
        run_with_instance_seam(seam, async move {
            crate::retrieval::get_messages(ref_, &message_ids, options).await
        })
        .await
    }

    pub async fn list_impressions(&self, ref_: ThreadRef) -> OpResult<Vec<ImpressionRecord>> {
        let seam = Arc::clone(&self.seam);
        run_with_instance_seam(seam, async move {
            crate::retrieval::list_impressions(ref_).await
        })
        .await
    }
}

/// TS `Lhc`.
pub struct Lhc {
    pub threads: LhcThreads,
    pub intake_stream: LhcIntakeStream,
    pub messages: LhcMessages,
    pub turns: LhcTurns,
    pub thread_view: ThreadViewSurface,
    pub inspect: InspectSurface,
    pub logging: LoggingSurface,
    pub retrieval: RetrievalSurface,
    pub config: ResolvedSdkConfig,
    pub scheduler: Scheduler,
    pub work: WorkSurface,
    /// Stable per-instance work registration (TS `WeakMap<Lhc, WorkRegistration>`).
    /// Private Rust construction state — not a root export. Address-keyed
    /// globals are not faithful: `Lhc` moves and addresses can be reused.
    work_registration: Arc<Mutex<WorkRegistration>>,
}

impl Lhc {
    pub async fn drain_settled(&self, ref_: ThreadRef) {
        let resolved_ref = threads::resolve_thread_ref(ref_).await;
        let OpResult::Ok { value } = resolved_ref else {
            return; // nothing can be scheduled for an unresolvable ref
        };
        let Some(thread_id) = peek_thread_id(&value.file_path) else {
            return;
        };
        self.scheduler.drain_settled(&thread_id).await;
    }
}

// ── Work-handler lookup / testing registration ───────────────────────

struct WorkRegistration {
    work_handlers: WorkHandlerMap,
    work_dispatchers: DurableWorkDispatcherMap,
}

/// TS inline `{ handlers?; dispatchers? }` for [`register_testing_work`].
/// Not a named sdk.ts export — Rust construction bag only (Wave 7 judgment).
/// Public under `lhc::sdk` for Cargo API construction; not a crate-root re-export.
pub struct TestingWorkRegistration {
    pub handlers: Option<WorkHandlerMap>,
    pub dispatchers: Option<DurableWorkDispatcherMap>,
}

/// TS `registerTestingWork` — mutates [`Lhc::work_registration`].
pub fn register_testing_work(sdk: &Lhc, registration: TestingWorkRegistration) {
    let mut target = sdk
        .work_registration
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(handlers) = registration.handlers {
        for (kind, handler) in handlers {
            target.work_handlers.insert(kind, handler);
        }
    }
    if let Some(dispatchers) = registration.dispatchers {
        for (op, dispatcher) in dispatchers {
            target.work_dispatchers.insert(op, dispatcher);
        }
    }
}

fn unknown_work_kind<T>(kind: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::StateCorruption,
            code: ErrorCode::UnknownWorkKind,
            reason: format!("no handler registered for work kind \"{kind}\""),
            event_index: None,
        },
    }
}

/// TS `lookupWorkHandler` — structured miss, never throw / silent undefined.
pub fn lookup_work_handler(map: &WorkHandlerMap, kind: &str) -> OpResult<WorkHandler> {
    let Some(work_kind) = WorkKind::from_wire(kind) else {
        return unknown_work_kind(kind);
    };
    match map.get(&work_kind) {
        Some(handler) => OpResult::Ok {
            value: Arc::clone(handler),
        },
        None => unknown_work_kind(kind),
    }
}

/// Exhaustive operation-key extraction for dispatcher map lookup (sdk.ts wiring).
/// Private — not a durable_work public API.
fn durable_operation_key(op: &DurableWorkOperation) -> DurableWorkOperationName {
    match op {
        DurableWorkOperation::MessagesDerive { .. } => DurableWorkOperationName::MessagesDerive,
        DurableWorkOperation::TurnsDeriveTurn { .. } => DurableWorkOperationName::TurnsDeriveTurn,
        DurableWorkOperation::TurnsDeriveDetailedTurnCompression { .. } => {
            DurableWorkOperationName::TurnsDeriveDetailedTurnCompression
        }
        DurableWorkOperation::TurnsDeriveDetailedChunk { .. } => {
            DurableWorkOperationName::TurnsDeriveDetailedChunk
        }
        DurableWorkOperation::TurnsDeriveBriefChunk { .. } => {
            DurableWorkOperationName::TurnsDeriveBriefChunk
        }
    }
}

/// TS `lookupWorkDispatcher` — structured miss when operation/kind unregistered.
pub fn lookup_work_dispatcher(
    map: &DurableWorkDispatcherMap,
    operation: Option<&DurableWorkOperation>,
    kind: &str,
) -> OpResult<DurableWorkDispatcher> {
    let Some(operation) = operation else {
        return unknown_work_kind(kind);
    };
    match map.get(&durable_operation_key(operation)) {
        Some(dispatcher) => OpResult::Ok {
            value: Arc::clone(dispatcher),
        },
        None => unknown_work_kind(kind),
    }
}

// ── initLhc private helpers ──────────────────────────────────────────

const INIT_CONFIG_PREFIX: &str = "initLhc config";

fn require_positive(value: f64, name: &str) {
    if !value.is_finite() || value <= 0.0 {
        panic!(
            "{INIT_CONFIG_PREFIX}: {name} must be a positive number, got {}",
            js_string_of_number(value)
        );
    }
}

fn require_positive_i64(value: i64, name: &str) {
    require_positive(value as f64, name);
}

/// Bind a domain surface to one SDK instance's delivery seam (epic-fix-001).
///
/// In Rust the namespace bindings are already owned structs whose methods wrap
/// [`run_with_instance_seam`]; this identity helper preserves the TS
/// `scopeSurface` call shape without a Proxy.
fn scope_surface<T>(surface: T, _seam: Arc<InstanceSeam>) -> T {
    surface
}

struct DefaultInferenceLane {
    provider: &'static str,
    model: &'static str,
}

/// Default provider lane and model for inference derivation types.
const DEFAULT_INFERENCE_LANE: DefaultInferenceLane = DefaultInferenceLane {
    provider: "codex",
    model: "gpt-5.4-mini",
};

const DEFAULT_INFERENCE_THINKING: ThinkingLevel = ThinkingLevel::None;

/// TS `DEFAULT_INFERENCE_ASSIGNMENTS` — immutable construction-internal
/// constant data (observable through routed calls, not a public export).
fn default_inference_assignments() -> IndexMap<&'static str, ModelAssignment> {
    // Prompt strings mirror TS `DEFAULT_PROMPT_NAMES[kind] ?? fallback`.
    let prompt = |kind: &str, fallback: &'static str| -> String {
        DEFAULT_PROMPT_NAMES
            .iter()
            .find(|(k, _)| *k == kind)
            .map(|(_, v)| (*v).to_string())
            .unwrap_or_else(|| fallback.to_string())
    };
    let mut map = IndexMap::new();
    map.insert(
        "smoothed_prompt",
        ModelAssignment {
            provider: DEFAULT_INFERENCE_LANE.provider.to_string(),
            model: DEFAULT_INFERENCE_LANE.model.to_string(),
            prompt: prompt("smoothed_prompt", "smoothing-v1"),
            target_min_ratio: None,
            target_max_ratio: None,
            target_aim_ratio: None,
            thinking: Some(DEFAULT_INFERENCE_THINKING),
        },
    );
    map.insert(
        "tool_result_summary",
        ModelAssignment {
            provider: DEFAULT_INFERENCE_LANE.provider.to_string(),
            model: DEFAULT_INFERENCE_LANE.model.to_string(),
            prompt: prompt("tool_result_summary", "tool-result-v2"),
            target_min_ratio: None,
            target_max_ratio: None,
            target_aim_ratio: None,
            thinking: Some(DEFAULT_INFERENCE_THINKING),
        },
    );
    map.insert(
        "detailed_turn_compression",
        ModelAssignment {
            provider: DEFAULT_INFERENCE_LANE.provider.to_string(),
            model: DEFAULT_INFERENCE_LANE.model.to_string(),
            prompt: prompt("detailed_turn_compression", "detailed-turn-compression-v3"),
            target_min_ratio: Some(0.35),
            target_max_ratio: Some(0.65),
            target_aim_ratio: Some(0.5),
            thinking: Some(DEFAULT_INFERENCE_THINKING),
        },
    );
    map.insert(
        "chunk_summary_brief",
        ModelAssignment {
            provider: DEFAULT_INFERENCE_LANE.provider.to_string(),
            model: DEFAULT_INFERENCE_LANE.model.to_string(),
            prompt: prompt("chunk_summary_brief", "chunk-brief-v3"),
            target_min_ratio: Some(0.08),
            target_max_ratio: Some(0.2),
            target_aim_ratio: Some(0.12),
            thinking: Some(DEFAULT_INFERENCE_THINKING),
        },
    );
    map
}

/// TS `resolveTargetRatios` — private.
enum TargetRatioKind {
    DetailedTurnCompression,
    ChunkSummaryBrief,
}

impl TargetRatioKind {
    fn as_str(self) -> &'static str {
        match self {
            TargetRatioKind::DetailedTurnCompression => "detailed_turn_compression",
            TargetRatioKind::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

fn resolve_target_ratios(
    kind: TargetRatioKind,
    assignment: Option<&ModelAssignment>,
) -> CompressionTargets {
    let defaults = default_inference_assignments();
    let defaults = defaults
        .get(kind.as_str())
        .expect("default inference assignment present");
    CompressionTargets {
        min_ratio: assignment
            .and_then(|a| a.target_min_ratio)
            .or(defaults.target_min_ratio)
            .expect("target min ratio"),
        aim_ratio: assignment
            .and_then(|a| a.target_aim_ratio)
            .or(defaults.target_aim_ratio)
            .expect("target aim ratio"),
        max_ratio: assignment
            .and_then(|a| a.target_max_ratio)
            .or(defaults.target_max_ratio)
            .expect("target max ratio"),
    }
}

fn merge_assignment(default: &ModelAssignment, override_: &ModelAssignment) -> ModelAssignment {
    ModelAssignment {
        provider: override_.provider.clone(),
        model: override_.model.clone(),
        prompt: override_.prompt.clone(),
        target_min_ratio: override_.target_min_ratio.or(default.target_min_ratio),
        target_aim_ratio: override_.target_aim_ratio.or(default.target_aim_ratio),
        target_max_ratio: override_.target_max_ratio.or(default.target_max_ratio),
        thinking: override_.thinking.or(default.thinking),
    }
}

/// Resolve the `inference` construction path: validate host function and
/// assignment map, fill defaults, build [`InferenceCallbacks`].
fn resolve_inference_callbacks(
    inference: &InferenceConfig,
    guards: &ResolvedDerivationGuards,
) -> InferenceCallbacks {
    let provided = inference.assignments.as_ref();
    let defaults = default_inference_assignments();
    let inference_keys: Vec<&str> = defaults.keys().copied().collect();

    if let Some(provided) = provided {
        for key in provided.keys() {
            if !defaults.contains_key(key.as_str()) {
                panic!(
                    "{INIT_CONFIG_PREFIX}: inference.assignments has unknown derivation type \"{key}\""
                );
            }
        }
    }

    let mut merged: IndexMap<String, ModelAssignment> = IndexMap::new();
    for kind in &inference_keys {
        let default = defaults.get(kind).expect("default present");
        let assignment = match provided.and_then(|p| p.get(*kind)) {
            None => default.clone(),
            Some(override_) => merge_assignment(default, override_),
        };
        for (field, value) in [
            ("provider", assignment.provider.as_str()),
            ("model", assignment.model.as_str()),
            ("prompt", assignment.prompt.as_str()),
        ] {
            if value.trim().is_empty() {
                panic!(
                    "{INIT_CONFIG_PREFIX}: inference.assignments.{kind}.{field} must be a non-empty string"
                );
            }
        }
        for (field, value) in [
            ("targetMinRatio", assignment.target_min_ratio),
            ("targetAimRatio", assignment.target_aim_ratio),
            ("targetMaxRatio", assignment.target_max_ratio),
        ] {
            if let Some(value) = value {
                if !value.is_finite() || value <= 0.0 {
                    panic!(
                        "{INIT_CONFIG_PREFIX}: inference.assignments.{kind}.{field} must be a positive number"
                    );
                }
            }
        }
        if registry_get(&assignment.prompt).is_none() {
            panic!(
                "{INIT_CONFIG_PREFIX}: inference.assignments.{kind}.prompt names unknown template \"{}\"",
                assignment.prompt
            );
        }
        merged.insert((*kind).to_string(), assignment);
    }

    let timeout_ms = inference.timeout_ms.unwrap_or(60_000);
    let max_input_chars = inference.max_input_chars.unwrap_or(200_000);
    require_positive_i64(timeout_ms, "inference.timeoutMs");
    require_positive_i64(max_input_chars, "inference.maxInputChars");
    create_inference_callbacks(ResolvedInferenceConfig {
        call: Arc::clone(&inference.call),
        assignments: merged,
        guards: guards.clone(),
        timeout_ms,
        max_input_chars,
    })
}

fn turn_owned_dispatcher(kind: WorkKind) -> DurableWorkDispatcher {
    Arc::new(move |run, item| {
        Box::pin(async move {
            dispatch_turn_owned_work(
                &run,
                &DispatchTurnOwnedWorkItem {
                    work_item_id: item.work_item_id,
                    kind,
                    source_ref: item.source_ref,
                    source_version: item.source_version,
                    derivations: item.derivations,
                },
            )
            .await
        })
    })
}

/// TS `initLhc` — the only initialization path.
///
/// Config mistakes are programmer errors at construction and panic; operating
/// failures after construction return [`OpResult`] per the error contract.
pub fn init_lhc(config: SdkConfig) -> Lhc {
    if config.inference_callbacks.is_some() == config.inference.is_some() {
        panic!("{INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference");
    }

    let guards = resolve_guards(config.guards.as_ref());
    let provided_assignments = config
        .inference
        .as_ref()
        .and_then(|inf| inf.assignments.as_ref());
    let compression_targets = resolve_target_ratios(
        TargetRatioKind::DetailedTurnCompression,
        provided_assignments.and_then(|m| m.get("detailed_turn_compression")),
    );
    let brief_targets_raw = resolve_target_ratios(
        TargetRatioKind::ChunkSummaryBrief,
        provided_assignments.and_then(|m| m.get("chunk_summary_brief")),
    );
    let brief_targets = BriefTargets {
        min_ratio: brief_targets_raw.min_ratio,
        aim_ratio: brief_targets_raw.aim_ratio,
        max_ratio: brief_targets_raw.max_ratio,
    };

    // Typed `InferenceCallbacks` already guarantees all four operations;
    // TS's runtime missing-operation loop has no Rust counterpart.
    let inference_callbacks = if let Some(inference) = &config.inference {
        resolve_inference_callbacks(inference, &guards)
    } else {
        config.inference_callbacks.expect("XOR checked above")
    };

    let resolved = ResolvedSdkConfig {
        inference_callbacks,
        mode: config.mode,
        clock: config
            .clock
            .unwrap_or_else(|| Arc::new(|| SystemTime::now())),
        guards,
        compression_targets,
        brief_targets,
        tool_result: config.tool_result.unwrap_or(ToolResultConfig {
            small_tier_tokens: 1000,
            small_target_ratio: 0.15,
            mid_target_ratio: 0.04,
        }),
        lease: config.lease.unwrap_or(LeaseConfig {
            duration_ms: 120_000,
        }),
        chunk_policy: config.chunk_policy.unwrap_or(ChunkPolicyConfig {
            target_projected_tokens: 2200,
            max_projected_tokens: 4400,
        }),
        view: resolve_view_config(config.view.as_ref()),
    };

    require_positive_i64(
        resolved.guards.smoothed_prompt.max_inference_tokens,
        "guards.smoothedPrompt.maxInferenceTokens",
    );
    require_positive(
        resolved.guards.smoothed_prompt.suspicious_output_ratio,
        "guards.smoothedPrompt.suspiciousOutputRatio",
    );
    require_positive_i64(
        resolved.guards.tool_result_summary.timeout_ms,
        "guards.toolResultSummary.timeoutMs",
    );
    require_positive_i64(
        resolved.guards.detailed_turn_compression.tiny_turn_tokens,
        "guards.detailedTurnCompression.tinyTurnTokens",
    );
    require_positive(
        resolved.compression_targets.min_ratio,
        "compressionTargets.minRatio",
    );
    require_positive(
        resolved.compression_targets.aim_ratio,
        "compressionTargets.aimRatio",
    );
    require_positive(
        resolved.compression_targets.max_ratio,
        "compressionTargets.maxRatio",
    );
    if resolved.compression_targets.max_ratio < resolved.compression_targets.min_ratio {
        panic!("{INIT_CONFIG_PREFIX}: compressionTargets.maxRatio must be >= minRatio");
    }
    if resolved.compression_targets.aim_ratio < resolved.compression_targets.min_ratio
        || resolved.compression_targets.aim_ratio > resolved.compression_targets.max_ratio
    {
        panic!(
            "{INIT_CONFIG_PREFIX}: compressionTargets.aimRatio must be between minRatio and maxRatio"
        );
    }
    require_positive(resolved.brief_targets.min_ratio, "briefTargets.minRatio");
    require_positive(resolved.brief_targets.aim_ratio, "briefTargets.aimRatio");
    require_positive(resolved.brief_targets.max_ratio, "briefTargets.maxRatio");
    if resolved.brief_targets.max_ratio < resolved.brief_targets.min_ratio {
        panic!("{INIT_CONFIG_PREFIX}: briefTargets.maxRatio must be >= minRatio");
    }
    if resolved.brief_targets.aim_ratio < resolved.brief_targets.min_ratio
        || resolved.brief_targets.aim_ratio > resolved.brief_targets.max_ratio
    {
        panic!("{INIT_CONFIG_PREFIX}: briefTargets.aimRatio must be between minRatio and maxRatio");
    }
    require_positive_i64(
        resolved.tool_result.small_tier_tokens,
        "toolResult.smallTierTokens",
    );
    require_positive(
        resolved.tool_result.small_target_ratio,
        "toolResult.smallTargetRatio",
    );
    require_positive(
        resolved.tool_result.mid_target_ratio,
        "toolResult.midTargetRatio",
    );
    require_positive_i64(resolved.lease.duration_ms, "lease.durationMs");
    require_positive_i64(
        resolved.chunk_policy.target_projected_tokens,
        "chunkPolicy.targetProjectedTokens",
    );
    if resolved.chunk_policy.max_projected_tokens < resolved.chunk_policy.target_projected_tokens {
        panic!(
            "{INIT_CONFIG_PREFIX}: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens"
        );
    }

    // Handler maps merge from per-domain contributions at construction.
    let work_handlers =
        map_work_q_handlers(&[MESSAGE_WORK_HANDLERS.clone(), TURN_WORK_HANDLERS.clone()]);
    let mut work_dispatchers: DurableWorkDispatcherMap = HashMap::new();
    work_dispatchers.insert(
        DurableWorkOperationName::MessagesDerive,
        Arc::new(|run, item: DurableWorkDispatcherItem| {
            Box::pin(async move {
                dispatch_message_derive_work(
                    &run,
                    &DispatchMessageDeriveWorkItem {
                        work_item_id: item.work_item_id,
                        source_version: item.source_version,
                        derivations: item.derivations,
                    },
                )
                .await
            })
        }),
    );
    work_dispatchers.insert(
        DurableWorkOperationName::TurnsDeriveTurn,
        turn_owned_dispatcher(WorkKind::TurnDerivation),
    );
    work_dispatchers.insert(
        DurableWorkOperationName::TurnsDeriveDetailedTurnCompression,
        turn_owned_dispatcher(WorkKind::DetailedTurnCompression),
    );
    work_dispatchers.insert(
        DurableWorkOperationName::TurnsDeriveDetailedChunk,
        turn_owned_dispatcher(WorkKind::ChunkSummaryDetailed),
    );
    work_dispatchers.insert(
        DurableWorkOperationName::TurnsDeriveBriefChunk,
        turn_owned_dispatcher(WorkKind::ChunkSummaryBrief),
    );

    let work_registration = Arc::new(Mutex::new(WorkRegistration {
        work_handlers,
        work_dispatchers,
    }));

    let reg_for_lookup = Arc::clone(&work_registration);
    let reg_for_any = Arc::clone(&work_registration);
    let drain_deps = Arc::new(DrainDeps {
        lookup_dispatcher: Box::new(move |operation, kind| {
            let map = {
                let guard = reg_for_lookup.lock().unwrap_or_else(|e| e.into_inner());
                // Clone Arcs out under the lock; never invoke callbacks while held.
                guard.work_dispatchers.clone()
            };
            lookup_work_dispatcher(&map, operation, kind)
        }),
        has_any_handler: Box::new(move || {
            let guard = reg_for_any.lock().unwrap_or_else(|e| e.into_inner());
            !guard.work_dispatchers.is_empty()
        }),
        config: resolved.clone(),
        open_thread_database: Box::new(|file_path| open_thread_database(file_path)),
    });

    let scheduler_mode = match resolved.mode {
        SdkMode::Background => SchedulerMode::Background,
        SdkMode::Manual => SchedulerMode::Manual,
    };
    // DrainDeps is not Clone; create_scheduler takes ownership. Rebuild an
    // equivalent deps Arc-share for WorkSurface via the same registration.
    let reg_for_sched = Arc::clone(&work_registration);
    let reg_for_sched_any = Arc::clone(&work_registration);
    let sched_deps = DrainDeps {
        lookup_dispatcher: Box::new(move |operation, kind| {
            let map = {
                let guard = reg_for_sched.lock().unwrap_or_else(|e| e.into_inner());
                guard.work_dispatchers.clone()
            };
            lookup_work_dispatcher(&map, operation, kind)
        }),
        has_any_handler: Box::new(move || {
            let guard = reg_for_sched_any.lock().unwrap_or_else(|e| e.into_inner());
            !guard.work_dispatchers.is_empty()
        }),
        config: resolved.clone(),
        open_thread_database: Box::new(|file_path| open_thread_database(file_path)),
    };
    let scheduler = create_scheduler(scheduler_mode, sched_deps);

    let seam: Arc<InstanceSeam> = match resolved.mode {
        SdkMode::Background => {
            let poke_scheduler = scheduler.shared_handle();
            let touch_scheduler = scheduler.shared_handle();
            Arc::new(InstanceSeam {
                poke: Box::new(move |thread_id| poke_scheduler.poke(thread_id)),
                touch: Box::new(move |file_path, db| touch_scheduler.touch(file_path, db)),
                view: Some(resolved.view.clone()),
                config: Some(resolved.clone()),
            })
        }
        SdkMode::Manual => Arc::new(InstanceSeam {
            poke: Box::new(|_thread_id| {}),
            touch: Box::new(|_file_path, _db| {}),
            view: Some(resolved.view.clone()),
            config: Some(resolved.clone()),
        }),
    };

    if resolved.mode == SdkMode::Background {
        let poke_scheduler = scheduler.shared_handle();
        let touch_scheduler = scheduler.shared_handle();
        set_scheduler_poke(Some(Box::new(move |thread_id| {
            poke_scheduler.poke(thread_id)
        })));
        set_thread_touch(Some(Box::new(move |file_path, db| {
            touch_scheduler.touch(file_path, db)
        })));
    }

    let work = WorkSurface::new(Arc::clone(&seam), Arc::clone(&drain_deps));
    let logging = LoggingSurface::new(Arc::clone(&seam), Arc::clone(&resolved.clock));

    Lhc {
        threads: scope_surface(LhcThreads::new(Arc::clone(&seam)), Arc::clone(&seam)),
        intake_stream: scope_surface(LhcIntakeStream::new(Arc::clone(&seam)), Arc::clone(&seam)),
        messages: scope_surface(LhcMessages::new(Arc::clone(&seam)), Arc::clone(&seam)),
        turns: scope_surface(LhcTurns::new(Arc::clone(&seam)), Arc::clone(&seam)),
        thread_view: scope_surface(ThreadViewSurface::new(Arc::clone(&seam)), Arc::clone(&seam)),
        inspect: scope_surface(InspectSurface::new(Arc::clone(&seam)), Arc::clone(&seam)),
        logging,
        retrieval: scope_surface(RetrievalSurface::new(Arc::clone(&seam)), Arc::clone(&seam)),
        config: resolved,
        scheduler,
        work,
        work_registration,
    }
}
