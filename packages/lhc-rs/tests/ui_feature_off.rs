//! Feature-off compile-fail: production consumers cannot name
//! `compact_continuation::test_support` without `feature = "test-util"`.
//!
//! When the package is built with `test-util` (normal evidence/gate run), this
//! harness no-ops — the structural proof is the feature-off invocation
//! recorded in `scripts/check_gate.py`.

#[test]
fn ui_feature_off() {
    #[cfg(feature = "test-util")]
    {
        // Feature is on; compile-fail case would not fail. Structural proof
        // lives in the feature-off gate step.
        return;
    }
    #[cfg(not(feature = "test-util"))]
    {
        let t = trybuild::TestCases::new();
        t.compile_fail("tests/ui_feature_off/*.rs");
    }
}
