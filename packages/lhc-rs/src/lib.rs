//! Host-agnostic LHC (long-horizon context) Cargo library — Rust port of
//! `packages/lhc`. TypeScript remains the behavioral source of truth.
//!
//! Phase 2 is accepted and dual-certified as a host-agnostic library at
//! `481 passed / 0 notimpl / 15 ignored`. Phase 3 (Grok Build integration)
//! remains before the larger user-facing deliverable.
//!
//! Crate-root surface mirrors `export * from "./sdk.js"` — the TS SDK's named
//! export closure (reference count 139), with seven namespace values mapped to
//! ratified Rust root modules (`inspect`, `intake_stream`, `messages`,
//! `shared_tech::logging` / existing root module ruling, `thread_view`,
//! `threads`, `turns`). Explicit list (not `pub use sdk::*`) so:
//! - Rust carrier impl types (`InspectSurface`, `LhcMessages`, …) stay under
//!   `lhc::sdk` only;
//! - `DrainOpts` / `TestingWorkRegistration` stay sdk-module-only;
//! - TS `WORK_KIND_REGISTRY` maps to the one canonical fn `work_kind_registry`
//!   (no SCREAMING alias).

pub mod inspect;
pub mod intake_stream;
pub mod messages;
pub mod retrieval;
pub mod sdk;
pub mod shared_tech;
pub mod thread_view;
pub mod threads;
pub mod turns;

pub use sdk::{
    BUILT_IN_PROFILES, Band, BatchResult, Block, BlockType, ChunkRecord, ClaimedWorkItem,
    CompactReceipt, CompletionTx, DEFAULT_COMPACT_THRESHOLD, DEFAULT_PROMPT_NAMES,
    DEFAULT_VISIBILITY, DbReadTransaction, DbWriteTransaction, DependencyGap, Derivation,
    DerivationMetadata, DerivationReportEntry, DerivationState, DeterministicOpName, DrainReport,
    DurableWorkDispatchResult, DurableWorkDispatcher, DurableWorkDispatcherMap,
    DurableWorkOperation, EnqueueDerivationTarget, EnqueueInput, ErrorClass, ErrorCode,
    ErrorResult, EventKind, EventRecord, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    HealthReport, InferenceCallbacks, InferenceConfig, InferenceResult, InspectOverview,
    IntakeStreamSurface, Lhc, LlmRequestContext, LlmRequestContextMessage, LlmRequestContextPart,
    LogEntry, LogLevel, LogQuery, LoggingSurface, MessageDetail, MessageEventInput,
    MessageListOptions, MessageRecord, ModelAssignment, ModelCall, ModelCallFailureKind,
    ModelCallInput, ModelCallResult, MutationResult, OpResult, PROMPT_NAMES, PostCommitHook,
    PreviewCompactOutcome, PreviewCompactResult, ProviderProvenance, PruneReceipt, QueueDetailRow,
    RenderingPart, ResolvedSdkConfig, ResolvedViewConfig, Scheduler, SchedulerMode, SdkConfig,
    SdkViewConfig, SessionAssistantMessage, SessionAssistantPart, SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry, SessionThreadView, SessionThreadViewEntry,
    SessionThreadViewEntrySource, SessionThreadViewMessage, SessionToolResultMessage,
    SessionUserMessage, StoredLogEntry, StoredView, SubjectKind, TOKEN_ESTIMATOR_ID,
    ThreadFileInfo, ThreadRef, ThreadViewSurface, ToolOutcome, ToolResultClassification,
    ToolResultFacts, ToolResultOperationClass, ToolResultPromptMode, ToolResultResponseShape,
    TurnRecord, ViewCompactParams, ViewContentsReport, ViewProfile, ViewProfileOverride,
    ViewStatus, VisibilityBudgets, WorkHandler, WorkHandlerMap, WorkItemRecord, WorkKind,
    WorkOwner, WorkSourceRef, WorkSurface, apply_derivation_success, count_live_items,
    create_db_read_transaction, create_db_write_transaction,
    create_deterministic_inference_callbacks, deterministic_outcomes_suffix, deterministic_text,
    enqueue, estimate_tokens, init_lhc, lookup_work_dispatcher, lookup_work_handler,
    map_work_q_handlers, query_log, queue_detail, register_testing_work, set_scheduler_poke,
    set_thread_touch, supersede_queued, work_kind_registry, write_log,
};

// Retrieval domain types (TS `export * as retrieval` + named shapes used by hosts/tests).
pub use sdk::{
    DEFAULT_RETRIEVAL_TOKEN_BUDGET, ImpressionRecord, MAX_RETRIEVAL_IDS_PER_CALL,
    RETRIEVAL_SLICE_FLOOR, RetrievalOptions,
    RetrievalReceipt, RetrievedMessage, RetrievedTurn, RetrievedTurnSource, SliceReceipt,
    TokenSlice, UnservedEntity, UnservedReason, slice_tokens,
};
