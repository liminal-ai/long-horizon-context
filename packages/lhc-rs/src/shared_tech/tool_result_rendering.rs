//! Ported from packages/lhc/src/shared-tech/tool-result-rendering.ts.
//! Phase 1 skeleton.
//!
//! Deterministic truncation for composed tool activity (call args and result
//! floors). Pure: no inference, DB, clock, or config, so identical source text
//! always yields identical output.

pub const FALLBACK_TRUNCATION_LIMIT: usize = 500;

pub fn truncate_for_fallback(_text: &str) -> String {
    todo!("phase 2")
}
