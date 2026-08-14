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

pub mod compact_continuation;
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
    BUILT_IN_PROFILES, Band, BatchResult, Block, BlockType, COMPACT_CONTINUATION_CONTRACT_VERSION,
    COMPACT_CONTINUATION_HOST_CAPABILITIES, COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE,
    COMPACT_CONTINUATION_INVARIANTS, COMPACT_CONTINUATION_MARKER_ACTION,
    COMPACT_CONTINUATION_MARKER_CAUSE, COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX,
    COMPACT_CONTINUATION_MARKER_KIND, COMPACT_CONTINUATION_OUTCOME_KINDS,
    COMPACT_CONTINUATION_REFUSE_CODES, COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE,
    COMPACT_CONTINUATION_SKIP_CODES, COMPACT_CONTINUATION_STATES,
    COMPACT_CONTINUATION_TRANSITION_ORDER, COMPACT_CONTINUATION_WRITER_CLAIMS,
    CONTEXT_COMPACT_CONTINUE_REASON, ChunkRecord, ClaimedWorkItem, CompactContinuationDecision,
    CompactContinuationEffect, CompactContinuationEffectType, CompactContinuationHostCapability,
    CompactContinuationInput, CompactContinuationInvariantId, CompactContinuationInvariants,
    CompactContinuationLowerTargetReceipt, CompactContinuationMarkerSemantics,
    CompactContinuationOutcomeKind, CompactContinuationPolicy, CompactContinuationPressureReceipt,
    CompactContinuationReceipt, CompactContinuationRefuseCode, CompactContinuationResidualState,
    CompactContinuationSeam, CompactContinuationSkipCode, CompactContinuationState,
    CompactContinuationTransitionStep, CompactMaterialFacts, CompactReceipt, CompletionTx,
    DEFAULT_COMPACT_THRESHOLD, DEFAULT_PROMPT_NAMES, DEFAULT_VISIBILITY, DbReadTransaction,
    DbWriteTransaction, DependencyGap, Derivation, DerivationMetadata, DerivationReportEntry,
    DerivationState, DeterministicOpName, DrainReport, DurableWorkDispatchResult,
    DurableWorkDispatcher, DurableWorkDispatcherMap, DurableWorkOperation, EnqueueDerivationTarget,
    EnqueueInput, ErrorClass, ErrorCode, ErrorResult, EventKind, EventRecord,
    ForcedContinuationBoundary, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    HealthReport, InferenceCallbacks, InferenceConfig, InferenceResult, InspectOverview,
    IntakeStreamSurface, Lhc, LhcRenderedHistoryAccounting, LlmRequestContext,
    LlmRequestContextMessage, LlmRequestContextPart, LogEntry, LogLevel, LogQuery, LoggingSurface,
    MessageDetail, MessageEventInput, MessageListOptions, MessageRecord, ModelAssignment,
    ModelCall, ModelCallFailureKind, ModelCallInput, ModelCallResult, MutationResult, OpResult,
    PROMPT_NAMES, PostCommitHook, PostMeasurementEstimate, PreviewCompactOutcome,
    PreviewCompactResult, ProviderProvenance, ProviderReportedInputAccounting,
    ProviderUsageAuthority, PruneReceipt, QueueDetailRow, RenderingPart, ResolvedSdkConfig,
    ResolvedViewConfig, Scheduler, SchedulerMode, SdkConfig, SdkViewConfig,
    SessionAssistantMessage, SessionAssistantPart, SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry, SessionThreadView, SessionThreadViewEntry,
    SessionThreadViewEntrySource, SessionThreadViewMessage, SessionToolResultMessage,
    SessionUserMessage, SourceLabelledEstimateAccounting, StoredLogEntry, StoredView, SubjectKind,
    TOKEN_ESTIMATOR_ID, ThreadFileInfo, ThreadRef, ThreadViewSurface, TokenAccountingDomain,
    ToolOutcome, ToolResultClassification, ToolResultFacts, ToolResultOperationClass,
    ToolResultPromptMode, ToolResultResponseShape, TurnRecord, ValidationIssue, ValidationResult,
    ViewCompactParams, ViewContentsReport, ViewProfile, ViewProfileOverride, ViewStatus,
    VisibilityBudgets, WorkContinuation, WorkHandler, WorkHandlerMap, WorkItemRecord, WorkKind,
    WorkOwner, WorkSourceRef, WorkSurface, WriterClaim, apply_derivation_success,
    as_compact_continuation_input, assert_decision_parity,
    compact_continuation_marker_idempotency_key, count_live_items, create_db_read_transaction,
    create_db_write_transaction, create_deterministic_inference_callbacks,
    decide_compact_continuation, deterministic_outcomes_suffix, deterministic_text, enqueue,
    estimate_tokens, init_lhc, lookup_work_dispatcher, lookup_work_handler, map_work_q_handlers,
    query_log, queue_detail, register_testing_work, set_scheduler_poke, set_thread_touch,
    supersede_queued, validate_compact_continuation_decision, validate_compact_continuation_input,
    validate_compact_continuation_receipt, work_kind_registry, write_log,
};

// Retrieval domain types (TS `export * as retrieval` + named shapes used by hosts/tests).
pub use sdk::{
    DEFAULT_RETRIEVAL_TOKEN_BUDGET, ImpressionRecord, MAX_RETRIEVAL_IDS_PER_CALL,
    MAX_RETRIEVAL_OUTPUT_TOKENS, RETRIEVAL_SLICE_FLOOR, RetrievalOptions, RetrievalReceipt,
    RetrievedMessage, RetrievedTurn, RetrievedTurnSource, SliceReceipt, TokenSlice, UnservedEntity,
    UnservedReason, clamp_id_echo, slice_tokens,
};
