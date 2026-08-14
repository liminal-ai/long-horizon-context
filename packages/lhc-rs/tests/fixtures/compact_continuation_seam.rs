//! Epic compact-continuation test seams. Lives in fixtures/ — the one
//! directory sanctioned to reach below the SDK surface. Not a public SDK export.

pub use lhc::compact_continuation::test_support::{
    CompactContinuationTestHooks, force_clear_writer, run_compact_continuation_for_tests,
    seed_writer_claim,
};
