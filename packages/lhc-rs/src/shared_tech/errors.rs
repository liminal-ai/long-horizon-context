//! Ported from packages/lhc/src/shared-tech/errors.ts. Phase 1 skeleton.
//!
//! EXEMPLAR MODULE — canonical pattern for porting a types-and-constants file.
//! Closed string unions become Rust enums with serde renames matching the TS
//! string values exactly (snake_case values here); interfaces become structs
//! with camelCase serde renames on the wire; functions become
//! `todo!("phase 2")` skeletons with full signatures, even one-liners.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    CallerError,
    StateCorruption,
    SystemError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PathExists,
    ThreadNotFound,
    /// caller_error — a partial thread id matched more than one thread (A-8 partial-id resolve)
    AmbiguousThreadId,
    /// caller_error — mutually exclusive pi-lhc extension launch flags set together
    ConflictingLhcLaunchFlags,
    /// empty/blank file path or otherwise unusable reference
    InvalidThreadRef,
    InvalidEvent,
    EmptyBatch,
    TurnStateCorrupt,
    StorageFailure,
    // Message/turn mutation and derivation errors:
    /// caller_error — mutation against an open turn
    TurnOpen,
    /// caller_error — delete refused toward turns.delete
    MessageInitiatesTurn,
    /// caller_error
    MessageNotFound,
    /// caller_error
    TurnNotFound,
    /// state_corruption — unregistered kind at dispatch
    UnknownWorkKind,
    /// system_error — inference failed; derivation.reason carries detail
    ProviderFailure,
    /// state_corruption — handler found corrupt source; derivation blocked
    SourceDamaged,
    /// caller_error — synchronous derivation called outside an SDK inference seam
    InferenceUnavailable,
    /// caller_error — synchronous derive refused because equivalent queued work is live
    DerivationWorkInFlight,
    /// state_corruption — handler writes did not exactly match queued derivation targets
    DerivationCompletionMismatch,
    // Surface-skeleton stub contract: machine-readable, never a throw on the
    // thread-view surface.
    /// system_error — operation's story has not landed yet
    NotImplemented,
    // Compact-time config rejection: unlike SDK construction, a bad compact
    // invocation is an operational caller error returned as a result.
    /// caller_error — named profile not configured
    UnknownProfile,
    /// caller_error — band sum / bound violation, named
    InvalidViewConfig,
    /// caller_error — caller stopped compact before it wrote a view
    CompactStopped,
    // materialize accepts pi-session only; an unknown format is a caller error
    // naming the accepted values.
    /// caller_error — materialize format not supported
    UnknownFormat,
    // Bounded listing: a bad bounds option is an operational caller error
    // returned as a result, mirroring the compact-params precedent.
    /// caller_error — list bounds option rejected
    InvalidBounds,
    /// caller_error — prune targetTokens rejected
    InvalidTargetTokens,
    // Compact-continuation runtime (LIM-61 / LIM-63A):
    /// caller_error — host input failed closed validation
    InvalidCompactContinuationInput,
    /// caller_error — cannot claim exclusive LHC writer
    CompactContinuationWriterConflict,
    /// caller_error — attemptId reused for a different operation
    CompactContinuationAttemptConflict,
    /// caller_error — visibility-boundary invariants prevent activation
    StalePreparedCompact,
    // Turn parts (mid-turn compact, AC-7.3/7.4). Core cannot observe capture
    // in flight: the entry point takes the host's seam assertion and refuses
    // when it is absent or false. Mechanism exclusivity is per thread, both ways.
    /// caller_error — mid-turn compact invoked without a settled host seam assertion
    UnsettledCaptureSeam,
    /// caller_error — mid-turn compact refused: this thread is on the forced-boundary path
    ForcedBoundaryThread,
    /// caller_error — forced-boundary compact refused: this thread has served parts
    CompactContinuationPartsThread,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::CallerError => "caller_error",
            ErrorClass::StateCorruption => "state_corruption",
            ErrorClass::SystemError => "system_error",
        }
    }
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::PathExists => "path_exists",
            ErrorCode::ThreadNotFound => "thread_not_found",
            ErrorCode::AmbiguousThreadId => "ambiguous_thread_id",
            ErrorCode::ConflictingLhcLaunchFlags => "conflicting_lhc_launch_flags",
            ErrorCode::InvalidThreadRef => "invalid_thread_ref",
            ErrorCode::InvalidEvent => "invalid_event",
            ErrorCode::EmptyBatch => "empty_batch",
            ErrorCode::TurnStateCorrupt => "turn_state_corrupt",
            ErrorCode::StorageFailure => "storage_failure",
            ErrorCode::TurnOpen => "turn_open",
            ErrorCode::MessageInitiatesTurn => "message_initiates_turn",
            ErrorCode::MessageNotFound => "message_not_found",
            ErrorCode::TurnNotFound => "turn_not_found",
            ErrorCode::UnknownWorkKind => "unknown_work_kind",
            ErrorCode::ProviderFailure => "provider_failure",
            ErrorCode::SourceDamaged => "source_damaged",
            ErrorCode::InferenceUnavailable => "inference_unavailable",
            ErrorCode::DerivationWorkInFlight => "derivation_work_in_flight",
            ErrorCode::DerivationCompletionMismatch => "derivation_completion_mismatch",
            ErrorCode::NotImplemented => "not_implemented",
            ErrorCode::UnknownProfile => "unknown_profile",
            ErrorCode::InvalidViewConfig => "invalid_view_config",
            ErrorCode::CompactStopped => "compact_stopped",
            ErrorCode::UnknownFormat => "unknown_format",
            ErrorCode::InvalidBounds => "invalid_bounds",
            ErrorCode::InvalidTargetTokens => "invalid_target_tokens",
            ErrorCode::InvalidCompactContinuationInput => "invalid_compact_continuation_input",
            ErrorCode::CompactContinuationWriterConflict => "compact_continuation_writer_conflict",
            ErrorCode::CompactContinuationAttemptConflict => {
                "compact_continuation_attempt_conflict"
            }
            ErrorCode::StalePreparedCompact => "stale_prepared_compact",
            ErrorCode::UnsettledCaptureSeam => "unsettled_capture_seam",
            ErrorCode::ForcedBoundaryThread => "forced_boundary_thread",
            ErrorCode::CompactContinuationPartsThread => "compact_continuation_parts_thread",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResult {
    pub error_class: ErrorClass,
    pub code: ErrorCode,
    /// human-readable; machine logic switches on code
    pub reason: String,
    /// present on batch validation failures
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_index: Option<i64>,
}

// Expected operational failures — caller errors, corruption, environment
// failures — are always returned as OpResult errors, never thrown (panicked).
// Programmer bugs inside lhc may still panic; callers are not expected
// to handle panics as contract outcomes.
//
// Wave 0 ruling: OpResult is an in-memory contract in TS (never persisted),
// so no serde impls until a persisted use appears — see PORT_STATUS.md.
#[derive(Debug, Clone, PartialEq)]
pub enum OpResult<T> {
    Ok { value: T },
    Err { error: ErrorResult },
}

impl<T> OpResult<T> {
    pub fn is_ok(&self) -> bool {
        matches!(self, OpResult::Ok { .. })
    }
}

// Infrastructure failures (SQLite, fs) are expected operational outcomes,
// caught at the operation boundary and wrapped with the underlying detail.
pub fn storage_failure<T>(reason: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::SystemError,
            code: ErrorCode::StorageFailure,
            reason: reason.to_string(),
            event_index: None,
        },
    }
}
