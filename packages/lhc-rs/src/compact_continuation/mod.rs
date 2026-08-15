//! Compact-continuation staged runtime (LIM-61 / LIM-63A).
//!
//! Pure contract/oracle: `shared_tech::compact_continuation`.
//! Live thread operation: this module.
//!
//! Public `run_compact_continuation` does **not** accept test hooks. Fault
//! injection is test-only via `run_compact_continuation_for_tests`, gated
//! behind the `test-util` cargo feature (and `cfg(test)` for in-crate unit
//! tests). Production consumers without that feature cannot name the module.

mod internal;

pub use internal::run::{
    CompactContinuationHostFacts, CompactContinuationRunResult, HostCompactOpts, HostValidationAck,
    StoredOperationIdentity, compute_attempt_intent, compute_operation_identity,
    compute_retry_posture, get_compact_continuation_attempt_intent,
    get_compact_continuation_host_validation, get_compact_continuation_receipt,
    get_compact_continuation_writer_claim, get_pending_compact_continuation_boundary,
    has_compact_continuation_marker, hash_attempt_intent, hash_record,
    list_compact_continuation_boundaries, list_compact_continuation_receipts,
    list_compact_continuation_stages, parse_stored_operation_identity,
    record_compact_continuation_host_validation, run_compact_continuation,
};
pub use internal::store::{
    AttemptRow, BoundaryRow, BoundaryStatus, ForceIntentRow, HostValidationRow,
    HostValidationStatus, StageLogEntry, StageName, StoredCompactContinuationReceipt,
    WriterClaimKind, WriterClaimRow,
};
pub use internal::tool_pair::{
    ProtectedToolPairSetProof, ToolPairFailReason, ToolPairOk, ToolPairProof,
    prove_pending_tool_pair, prove_protected_tool_pair_set,
};
pub use internal::validate_host::validate_host_facts;

/// Test-only surface — reachable from integration tests and
/// `tests/fixtures/compact_continuation_seam.rs`, not from the public SDK.
#[doc(hidden)]
#[cfg(any(test, feature = "test-util"))]
pub use internal::run::{CompactContinuationTestHooks, run_compact_continuation_for_tests};
#[doc(hidden)]
#[cfg(any(test, feature = "test-util"))]
pub use internal::store::{force_clear_writer, seed_writer_claim};

// Integration tests / host certification enable `feature = "test-util"`.
// Default production builds do not compile this module at all.
#[doc(hidden)]
#[cfg(any(test, feature = "test-util"))]
pub mod test_support {
    pub use super::internal::run::{
        CompactContinuationTestHooks, run_compact_continuation_for_tests,
    };
    pub use super::internal::store::{
        force_clear_writer, read_pending_boundary, seed_writer_claim, upsert_boundary,
    };
}
