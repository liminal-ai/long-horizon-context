//! Ported from packages/lhc/src/sdk.ts.
//!
//! Public SDK surface: namespace bindings, init_lhc, work/logging/thread-view/
//! inspect surfaces, and the type/value re-exports that mirror sdk.ts.

// ── Canonical public re-exports (sdk.ts) ─────────────────────────────

pub use crate::intake_stream::{BatchResult, EventKind, EventRecord, MessageEventInput};
pub use crate::messages::{
    Block, BlockType, MessageDetail, MessageListOptions, MessageRecord, MutationResult,
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
pub use crate::shared_tech::token_counting::{TOKEN_ESTIMATOR_ID, estimate_tokens};
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

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;

use crate::messages::{
    EditInput, MessageCreateResult, MessageDeriveResult, MessageReportOpts, RecordedEvent,
    RemoveInput,
};
use crate::shared_tech::context::InstanceSeam;
use crate::shared_tech::derivation::CompressionTargets;
use crate::shared_tech::durable_work::DurableWorkOperationName;
#[allow(unused_imports)] // Phase 2 init path; mirror TS dependency graph
use crate::shared_tech::inference_adapter::create_inference_callbacks;
use crate::shared_tech::inference_types::{ResolvedDerivationGuards, ThinkingLevel};
use crate::shared_tech::logging::{DerivationLogQuery, StoredDerivationLogEntry};
#[allow(unused_imports)] // Phase 2 init path; mirror TS dependency graph
use crate::shared_tech::prompts::PROMPT_REGISTRY;
use crate::shared_tech::storage::Db;
use crate::thread_view::{CompactOpts, MaterializeOpts, MaterializeResult, PruneParams};
use crate::threads::{
    ListThreadsInput, NewThreadInput, NewThreadResult, ResolveInput, ResolvedThreadPath, ThreadInfo,
};
use crate::turns::internal::chunk_recovery::CompactChunkMaterial;
use crate::turns::{
    ChunkDeriveDerivationType, ChunkDeriveResult, RecordedTurnEvent, TurnChunkStructure,
    TurnDeriveResult, TurnReportOpts, TurnTransitionOutcome,
};

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
}

impl WorkSurface {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn drain(&self, _ref: ThreadRef, _opts: Option<DrainOpts>) -> OpResult<DrainReport> {
        todo!("phase 2")
    }
}

/// TS `LoggingSurface` — opaque per-instance seam carrier.
#[derive(Clone)]
pub struct LoggingSurface {
    seam: Arc<InstanceSeam>,
}

impl LoggingSurface {
    fn new(seam: Arc<InstanceSeam>) -> Self {
        Self { seam }
    }

    pub async fn write(&self, _ref: ThreadRef, _entry: LogEntry) -> OpResult<()> {
        todo!("phase 2")
    }

    pub async fn query(&self, _ref: ThreadRef, _q: LogQuery) -> OpResult<Vec<StoredLogEntry>> {
        todo!("phase 2")
    }

    pub async fn query_derivation_log(
        &self,
        _ref: ThreadRef,
        _q: DerivationLogQuery,
    ) -> OpResult<Vec<StoredDerivationLogEntry>> {
        todo!("phase 2")
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

    pub async fn get_llm_request_context(&self, _ref: ThreadRef) -> OpResult<LlmRequestContext> {
        todo!("phase 2")
    }

    pub async fn get_session_thread_view(&self, _ref: ThreadRef) -> OpResult<SessionThreadView> {
        todo!("phase 2")
    }

    pub async fn status(&self, _ref: ThreadRef) -> OpResult<ViewStatus> {
        todo!("phase 2")
    }

    pub async fn prune(
        &self,
        _ref: ThreadRef,
        _params: Option<PruneParams>,
    ) -> OpResult<PruneReceipt> {
        todo!("phase 2")
    }

    pub async fn describe(&self, _ref: ThreadRef) -> OpResult<Option<StoredView>> {
        todo!("phase 2")
    }

    pub async fn preview_compact(
        &self,
        _ref: ThreadRef,
        _opts: CompactOpts,
    ) -> OpResult<PreviewCompactOutcome> {
        todo!("phase 2")
    }

    pub async fn compact(&self, _ref: ThreadRef, _opts: CompactOpts) -> OpResult<CompactReceipt> {
        todo!("phase 2")
    }

    pub async fn materialize(
        &self,
        _ref: ThreadRef,
        _opts: MaterializeOpts,
    ) -> OpResult<MaterializeResult> {
        todo!("phase 2")
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

    pub async fn overview(&self, _ref: ThreadRef) -> OpResult<InspectOverview> {
        todo!("phase 2")
    }

    pub async fn health(&self, _ref: ThreadRef) -> OpResult<HealthReport> {
        todo!("phase 2")
    }

    pub async fn view(&self, _ref: ThreadRef) -> OpResult<ViewContentsReport> {
        todo!("phase 2")
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
        _transaction: &DbWriteTransaction,
        _recorded_event: &RecordedEvent,
        _turn_id: &str,
    ) -> MessageCreateResult {
        todo!("phase 2")
    }

    pub async fn list(
        &self,
        _thread_ref: ThreadRef,
        _filter: Option<MessageListOptions>,
    ) -> OpResult<Vec<MessageRecord>> {
        todo!("phase 2")
    }

    pub fn read_live_messages(&self, _db: &Db) -> Vec<MessageRecord> {
        todo!("phase 2")
    }

    pub async fn show(&self, _thread_ref: ThreadRef, _message_id: &str) -> OpResult<MessageDetail> {
        todo!("phase 2")
    }

    pub async fn report(
        &self,
        _thread_ref: ThreadRef,
        _opts: Option<MessageReportOpts>,
    ) -> OpResult<Vec<DerivationReportEntry>> {
        todo!("phase 2")
    }

    pub async fn derive(
        &self,
        _thread_ref: ThreadRef,
        _message_ids: &[String],
    ) -> OpResult<Vec<MessageDeriveResult>> {
        todo!("phase 2")
    }

    pub async fn edit(&self, _thread_ref: ThreadRef, _edit: EditInput) -> OpResult<MutationResult> {
        todo!("phase 2")
    }

    pub async fn remove(
        &self,
        _thread_ref: ThreadRef,
        _removal: RemoveInput,
    ) -> OpResult<MutationResult> {
        todo!("phase 2")
    }

    /// TS `sdk.messages.cleanPrompt` — Phase 2 wraps through the instance seam.
    pub fn clean_prompt(&self, _text: &str) -> String {
        todo!("phase 2")
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

    pub async fn new_thread(&self, _input: NewThreadInput) -> OpResult<NewThreadResult> {
        todo!("phase 2")
    }

    pub async fn resolve(&self, _input: ResolveInput) -> OpResult<ThreadInfo> {
        todo!("phase 2")
    }

    pub async fn list_threads(
        &self,
        _input: Option<ListThreadsInput>,
    ) -> OpResult<Vec<ThreadInfo>> {
        todo!("phase 2")
    }

    pub async fn info(&self, _ref: ThreadRef) -> OpResult<ThreadFileInfo> {
        todo!("phase 2")
    }

    pub async fn resolve_thread_ref(&self, _ref: ThreadRef) -> OpResult<ResolvedThreadPath> {
        todo!("phase 2")
    }

    pub fn open_thread_database(&self, _file_path: &str) -> OpResult<Db> {
        todo!("phase 2")
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
        _thread_ref: ThreadRef,
        _events: &[MessageEventInput],
    ) -> OpResult<BatchResult> {
        todo!("phase 2")
    }

    pub async fn list_events(&self, _thread_ref: ThreadRef) -> OpResult<Vec<EventRecord>> {
        todo!("phase 2")
    }

    /// TS `intakeStream.initLhc` — same function as crate-root [`init_lhc`].
    pub fn init_lhc(&self, _config: SdkConfig) -> Lhc {
        todo!("phase 2")
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
        _transaction: &DbWriteTransaction,
        _recorded_event: &RecordedTurnEvent,
    ) -> TurnTransitionOutcome {
        todo!("phase 2")
    }

    pub async fn list_turns(&self, _thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
        todo!("phase 2")
    }

    pub async fn list_chunks(&self, _thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
        todo!("phase 2")
    }

    pub fn get_chunk_text(
        &self,
        _transaction: &DbReadTransaction,
        _chunk_id: &str,
        _derivation_type: Option<ChunkDeriveDerivationType>,
    ) -> CompactChunkMaterial {
        todo!("phase 2")
    }

    pub fn read_turn_chunk_structure(&self, _db: &Db) -> TurnChunkStructure {
        todo!("phase 2")
    }

    pub async fn report(
        &self,
        _thread_ref: ThreadRef,
        _opts: Option<&TurnReportOpts>,
    ) -> OpResult<Vec<DerivationReportEntry>> {
        todo!("phase 2")
    }

    pub async fn derive_turn(
        &self,
        _thread_ref: ThreadRef,
        _turn_id: &str,
    ) -> OpResult<TurnDeriveResult> {
        todo!("phase 2")
    }

    pub async fn derive_detailed_chunk(
        &self,
        _thread_ref: ThreadRef,
        _chunk_id: &str,
    ) -> OpResult<ChunkDeriveResult> {
        todo!("phase 2")
    }

    pub async fn derive_brief_chunk(
        &self,
        _thread_ref: ThreadRef,
        _chunk_id: &str,
    ) -> OpResult<ChunkDeriveResult> {
        todo!("phase 2")
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
    pub config: ResolvedSdkConfig,
    pub scheduler: Scheduler,
    pub work: WorkSurface,
    /// Stable per-instance work registration (TS `WeakMap<Lhc, WorkRegistration>`).
    /// Private Rust construction state — not a root export. Address-keyed
    /// globals are not faithful: `Lhc` moves and addresses can be reused.
    work_registration: Arc<Mutex<WorkRegistration>>,
}

impl Lhc {
    pub async fn drain_settled(&self, _ref: ThreadRef) {
        todo!("phase 2")
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

/// TS `registerTestingWork` — Phase 1 exact todo; mutates
/// [`Lhc::work_registration`] in Phase 2.
pub fn register_testing_work(_sdk: &Lhc, _registration: TestingWorkRegistration) {
    todo!("phase 2")
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

fn require_positive(_value: f64, _name: &str) {
    todo!("phase 2")
}

fn require_positive_i64(_value: i64, _name: &str) {
    todo!("phase 2")
}

/// Bind a domain surface to one SDK instance's delivery seam (epic-fix-001).
///
/// In Rust the namespace bindings are already owned structs; Phase 2 wraps each
/// method body in [`run_with_instance_seam`]. Signature retained for fidelity.
fn scope_surface<T>(_surface: T, _seam: Arc<InstanceSeam>) -> T {
    todo!("phase 2")
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

/// TS `resolveTargetRatios` — private; behavior Phase 2.
enum TargetRatioKind {
    DetailedTurnCompression,
    ChunkSummaryBrief,
}

fn resolve_target_ratios(
    _kind: TargetRatioKind,
    _assignment: Option<&ModelAssignment>,
) -> CompressionTargets {
    todo!("phase 2")
}

/// Resolve the `inference` construction path: validate host function and
/// assignment map, fill defaults, build [`InferenceCallbacks`].
fn resolve_inference_callbacks(
    _inference: &InferenceConfig,
    _guards: &ResolvedDerivationGuards,
) -> InferenceCallbacks {
    todo!("phase 2")
}

/// TS `initLhc` — the only initialization path.
///
/// Config mistakes are programmer errors at construction and panic; operating
/// failures after construction return [`OpResult`] per the error contract.
pub fn init_lhc(_config: SdkConfig) -> Lhc {
    todo!("phase 2")
}
