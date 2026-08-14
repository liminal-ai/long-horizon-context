//! Feature-off compile-fail: production consumers cannot name the
//! compact-continuation fault-injection surface without `feature = "test-util"`.
//!
//! Mirrors the TS package `exports` map that keeps testHooks off the public
//! closed validation surface (LIM-61 certified property).

fn main() {
    let _ = std::any::type_name_of_val(
        &lhc::compact_continuation::test_support::run_compact_continuation_for_tests,
    );
}
