//! Ported from packages/lhc/src/sdk.ts. Phase 1 PARTIAL stub.
//!
//! Wave 1 needs `init_lhc`, `Lhc` (fields/methods tests call), and crate-root
//! re-exports that have an `sdk.ts` counterpart. Full SDK surface lands in
//! Wave 7. `registerTestingWork` / `DurableWorkDispatcherMap` land with the
//! durable-work wave (no Wave 1 consumer).

// Crate-root re-exports mirroring sdk.ts (index.ts is `export * from "./sdk.js"`).
// Intentionally omitted (no sdk.ts counterpart / not Wave 1 surface):
// `Db`, `LeaseConfig`, `SdkMode`, `NewThreadInput`, `NewThreadResult`, `MessageKind`.
pub use crate::intake_stream::{BatchResult, EventKind, EventRecord, MessageEventInput};
pub use crate::messages::{Block, BlockType, MessageListOptions, MessageRecord};
pub use crate::shared_tech::context::{set_scheduler_poke, set_thread_touch};
pub use crate::shared_tech::derivation::{
    Derivation, DerivationMetadata, InferenceCallbacks, InferenceResult, SdkConfig, ToolOutcome,
    WorkHandler,
};
pub use crate::shared_tech::deterministic::{
    create_deterministic_inference_callbacks, deterministic_text,
};
pub use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
pub use crate::shared_tech::logging::{LogEntry, LogLevel, LogQuery, StoredLogEntry, write_log};
pub use crate::shared_tech::persist::{DbReadTransaction, DbWriteTransaction};
pub use crate::shared_tech::scheduler::{DrainReport, Scheduler};
pub use crate::shared_tech::view::LlmRequestContext;
pub use crate::shared_tech::work_queue::{WorkHandlerMap, WorkKind, count_live_items};
pub use crate::threads::ThreadRef;
pub use crate::turns::TurnRecord;

use crate::shared_tech::derivation::ResolvedSdkConfig;
use crate::threads::{NewThreadInput, NewThreadResult};

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
