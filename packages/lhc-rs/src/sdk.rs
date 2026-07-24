//! Ported from packages/lhc/src/sdk.ts. Phase 1 PARTIAL stub.
//!
//! Wave 1–2: `init_lhc`, `Lhc`, and sdk.ts-faithful re-exports Wave tests need.
//! Full SDK surface lands in Wave 7. Durable-work types live in
//! `shared_tech::durable_work` (canonical); re-exported here where sdk.ts does.

// Crate-root re-exports mirroring sdk.ts (index.ts is `export * from "./sdk.js"`).
// Intentionally omitted (no sdk.ts counterpart / not Wave 1–2 surface):
// `Db`, `LeaseConfig`, `SdkMode`, `NewThreadInput`, `NewThreadResult`, `MessageKind`.
pub use crate::intake_stream::{BatchResult, EventKind, EventRecord, MessageEventInput};
pub use crate::messages::{
    Block, BlockType, MessageDetail, MessageListOptions, MessageRecord, MutationResult,
};
pub use crate::shared_tech::context::{set_scheduler_poke, set_thread_touch};
pub use crate::shared_tech::derivation::{
    Derivation, DerivationMetadata, InferenceCallbacks, InferenceResult, SdkConfig, ToolOutcome,
    WorkHandler,
};
pub use crate::shared_tech::deterministic::{
    create_deterministic_inference_callbacks, deterministic_text,
};
pub use crate::shared_tech::durable_work::{
    DurableWorkDispatchResult, DurableWorkDispatcher, DurableWorkDispatcherMap,
    DurableWorkOperation,
};
pub use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
/// Wave 6: canonical view vocabulary re-exported where `sdk.ts` does
/// (`export type { … } from "./shared-tech"` + thread-view config constants).
/// Wave 6: canonical inspect view-contents shape exported by `sdk.ts`
/// (`ViewContentsReport` from shared-tech). Broader non-view SDK/root export
/// completion remains Wave 7.
pub use crate::shared_tech::inspect::ViewContentsReport;
pub use crate::shared_tech::logging::{LogEntry, LogLevel, LogQuery, StoredLogEntry, write_log};
pub use crate::shared_tech::persist::{DbReadTransaction, DbWriteTransaction};
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

use std::sync::Arc;

use crate::messages::{EditInput, MessageDeriveResult, RemoveInput};
use crate::shared_tech::derivation::ResolvedSdkConfig;
use crate::shared_tech::durable_work::DurableWorkOperationName;
use crate::threads::{NewThreadInput, NewThreadResult};
use crate::turns::{ChunkDeriveResult, TurnDeriveResult};

/// TS `{ handlers?; dispatchers? }` for [`register_testing_work`].
pub struct TestingWorkRegistration {
    pub handlers: Option<WorkHandlerMap>,
    pub dispatchers: Option<DurableWorkDispatcherMap>,
}

/// TS `registerTestingWork` — defined in sdk.ts (not durable-work).
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

/// TS `WorkSurface`.
pub struct WorkSurface;

impl WorkSurface {
    pub async fn drain(&self, _ref: ThreadRef, _opts: Option<DrainOpts>) -> OpResult<DrainReport> {
        todo!("phase 2")
    }
}

#[derive(Debug, Clone, Default)]
pub struct DrainOpts {
    pub max_items: Option<i64>,
}

/// TS `LoggingSurface`.
pub struct LoggingSurface;

impl LoggingSurface {
    pub async fn write(&self, _ref: ThreadRef, _entry: LogEntry) -> OpResult<()> {
        todo!("phase 2")
    }

    pub async fn query(&self, _ref: ThreadRef, _q: LogQuery) -> OpResult<Vec<StoredLogEntry>> {
        todo!("phase 2")
    }

    pub async fn query_derivation_log(
        &self,
        _ref: ThreadRef,
        _q: crate::shared_tech::logging::DerivationLogQuery,
    ) -> OpResult<Vec<crate::shared_tech::logging::StoredDerivationLogEntry>> {
        todo!("phase 2")
    }
}

/// TS `ThreadViewSurface` — Wave 6 full surface (bodies Phase 2).
/// Mirrors sdk.ts ThreadViewSurface method set.
pub struct ThreadViewSurface;

impl ThreadViewSurface {
    pub async fn get_llm_request_context(&self, _ref: ThreadRef) -> OpResult<LlmRequestContext> {
        todo!("phase 2")
    }

    pub async fn get_session_thread_view(
        &self,
        _ref: ThreadRef,
    ) -> OpResult<crate::shared_tech::view::SessionThreadView> {
        todo!("phase 2")
    }

    pub async fn status(&self, _ref: ThreadRef) -> OpResult<crate::shared_tech::view::ViewStatus> {
        todo!("phase 2")
    }

    pub async fn prune(
        &self,
        _ref: ThreadRef,
        _params: Option<crate::thread_view::PruneParams>,
    ) -> OpResult<crate::shared_tech::view::PruneReceipt> {
        todo!("phase 2")
    }

    pub async fn describe(
        &self,
        _ref: ThreadRef,
    ) -> OpResult<Option<crate::shared_tech::view::StoredView>> {
        todo!("phase 2")
    }

    pub async fn preview_compact(
        &self,
        _ref: ThreadRef,
        _opts: crate::thread_view::CompactOpts,
    ) -> OpResult<crate::shared_tech::view::PreviewCompactOutcome> {
        todo!("phase 2")
    }

    pub async fn compact(
        &self,
        _ref: ThreadRef,
        _opts: crate::thread_view::CompactOpts,
    ) -> OpResult<crate::shared_tech::view::CompactReceipt> {
        todo!("phase 2")
    }

    pub async fn materialize(
        &self,
        _ref: ThreadRef,
        _opts: crate::thread_view::MaterializeOpts,
    ) -> OpResult<crate::thread_view::MaterializeResult> {
        todo!("phase 2")
    }
}

/// TS messages namespace binding — PARTIAL (Wave 4 suites need show/edit/remove/report).
pub struct LhcMessages;

impl LhcMessages {
    pub async fn list(
        &self,
        _thread_ref: ThreadRef,
        _filter: Option<MessageListOptions>,
    ) -> OpResult<Vec<MessageRecord>> {
        todo!("phase 2")
    }

    pub async fn show(&self, _thread_ref: ThreadRef, _message_id: &str) -> OpResult<MessageDetail> {
        todo!("phase 2")
    }

    pub async fn report(
        &self,
        _thread_ref: ThreadRef,
        _opts: Option<crate::messages::MessageReportOpts>,
    ) -> OpResult<Vec<crate::shared_tech::derivation::DerivationReportEntry>> {
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

    /// TS `sdk.messages.cleanPrompt` — namespace surface; Phase 2 binds to module export.
    pub fn clean_prompt(&self, _text: &str) -> String {
        todo!("phase 2")
    }
}

/// TS threads namespace binding — PARTIAL.
pub struct LhcThreads;

impl LhcThreads {
    pub async fn new_thread(&self, _input: NewThreadInput) -> OpResult<NewThreadResult> {
        todo!("phase 2")
    }

    /// TS `sdk.threads.info` — Wave 6 view-llm-request-context needs the nesting.
    pub async fn info(&self, _ref: ThreadRef) -> OpResult<ThreadFileInfo> {
        todo!("phase 2")
    }
}

/// TS intakeStream namespace binding — PARTIAL.
pub struct LhcIntakeStream;

impl LhcIntakeStream {
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

    /// TS `intakeStream.initLhc` — same function as crate-root init_lhc.
    pub fn init_lhc(&self, _config: SdkConfig) -> Lhc {
        todo!("phase 2")
    }
}

/// TS turns namespace binding — PARTIAL.
pub struct LhcTurns;

impl LhcTurns {
    pub async fn list_turns(&self, _thread_ref: ThreadRef) -> OpResult<Vec<TurnRecord>> {
        todo!("phase 2")
    }

    pub async fn list_chunks(&self, _thread_ref: ThreadRef) -> OpResult<Vec<ChunkRecord>> {
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

/// TS `Lhc` — PARTIAL: fields/methods Wave 1 tests call.
pub struct Lhc {
    pub threads: LhcThreads,
    pub intake_stream: LhcIntakeStream,
    pub messages: LhcMessages,
    pub turns: LhcTurns,
    pub thread_view: ThreadViewSurface,
    pub logging: LoggingSurface,
    pub config: ResolvedSdkConfig,
    pub scheduler: Scheduler,
    pub work: WorkSurface,
}

impl Lhc {
    pub async fn drain_settled(&self, _ref: ThreadRef) {
        todo!("phase 2")
    }
}

/// TS `initLhc` — PARTIAL stub.
pub fn init_lhc(_config: SdkConfig) -> Lhc {
    todo!("phase 2")
}
