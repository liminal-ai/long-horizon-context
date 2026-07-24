//! Ported from packages/lhc/src/sdk.ts. Phase 1 PARTIAL stub.
//!
//! Wave 1–2: `init_lhc`, `Lhc`, and sdk.ts-faithful re-exports Wave tests need.
//! Full SDK surface lands in Wave 7. Durable-work types live in
//! `shared_tech::durable_work` (canonical); re-exported here where sdk.ts does.

// Crate-root re-exports mirroring sdk.ts (index.ts is `export * from "./sdk.js"`).
// Intentionally omitted (no sdk.ts counterpart / not Wave 1–2 surface):
// `Db`, `LeaseConfig`, `SdkMode`, `NewThreadInput`, `NewThreadResult`, `MessageKind`.
pub use crate::intake_stream::{BatchResult, EventKind, EventRecord, MessageEventInput};
pub use crate::messages::{Block, BlockType, MessageListOptions, MessageRecord, MutationResult};
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
pub use crate::shared_tech::logging::{LogEntry, LogLevel, LogQuery, StoredLogEntry, write_log};
pub use crate::shared_tech::persist::{DbReadTransaction, DbWriteTransaction};
pub use crate::shared_tech::scheduler::{DrainReport, Scheduler, SchedulerMode};
pub use crate::shared_tech::token_counting::{TOKEN_ESTIMATOR_ID, estimate_tokens};
pub use crate::shared_tech::view::LlmRequestContext;
pub use crate::shared_tech::work_queue::{
    ClaimedWorkItem, EnqueueDerivationTarget, EnqueueInput, QueueDetailRow, WorkHandlerMap,
    WorkItemRecord, WorkKind, WorkOwner, WorkSourceRef, count_live_items, enqueue,
    map_work_q_handlers, queue_detail, supersede_queued, work_kind_registry,
};
pub use crate::threads::{ThreadFileInfo, ThreadRef};
pub use crate::turns::TurnRecord;

use std::sync::Arc;

use crate::messages::MessageDeriveResult;
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

/// TS `ThreadViewSurface` — PARTIAL: get_llm_request_context for Wave 1.
pub struct ThreadViewSurface;

impl ThreadViewSurface {
    pub async fn get_llm_request_context(&self, _ref: ThreadRef) -> OpResult<LlmRequestContext> {
        todo!("phase 2")
    }
}

/// TS messages namespace binding — PARTIAL.
pub struct LhcMessages;

impl LhcMessages {
    pub async fn list(
        &self,
        _thread_ref: ThreadRef,
        _filter: Option<MessageListOptions>,
    ) -> OpResult<Vec<MessageRecord>> {
        todo!("phase 2")
    }

    pub async fn derive(
        &self,
        _thread_ref: ThreadRef,
        _message_ids: &[String],
    ) -> OpResult<Vec<MessageDeriveResult>> {
        todo!("phase 2")
    }
}

/// TS threads namespace binding — PARTIAL.
pub struct LhcThreads;

impl LhcThreads {
    pub async fn new_thread(&self, _input: NewThreadInput) -> OpResult<NewThreadResult> {
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
