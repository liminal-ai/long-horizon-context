//! Compact-continuation staged runtime (LIM-61 / LIM-63A).
//!
//! Pure contract/oracle: `shared_tech::compact_continuation`.
//! Live thread operation: this module.
//!
//! Public `run_compact_continuation` does **not** accept test hooks. Fault
//! injection is test-only via `run_compact_continuation_for_tests`.

mod internal;

pub use internal::run::{
    CompactContinuationHostFacts, CompactContinuationRunResult, CompactContinuationTestHooks,
    compute_attempt_intent, compute_operation_identity, compute_retry_posture,
    get_compact_continuation_receipt, get_compact_continuation_writer_claim,
    get_pending_compact_continuation_boundary, has_compact_continuation_marker,
    hash_attempt_intent, hash_record, list_compact_continuation_boundaries,
    list_compact_continuation_receipts, list_compact_continuation_stages, run_compact_continuation,
    run_compact_continuation_for_tests,
};
pub use internal::store::{
    AttemptRow, BoundaryRow, BoundaryStatus, ForceIntentRow, StageLogEntry, StageName,
    StoredCompactContinuationReceipt, WriterClaimKind, WriterClaimRow, force_clear_writer,
    seed_writer_claim,
};
pub use internal::tool_pair::{ToolPairFailReason, ToolPairProof, prove_pending_tool_pair};
pub use internal::validate_host::validate_host_facts;
