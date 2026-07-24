//! Ported from packages/lhc/src/shared-tech/tool-result-rendering.ts.
//!
//! Deterministic truncation for composed tool activity (call args and result
//! floors). Pure: no inference, DB, clock, or config, so identical source text
//! always yields identical output.

use super::js_json::{js_len, js_slice};

pub const FALLBACK_TRUNCATION_LIMIT: usize = 500;

pub fn truncate_for_fallback(text: &str) -> String {
    // TS: text.length / text.slice — UTF-16 code units.
    if js_len(text) <= FALLBACK_TRUNCATION_LIMIT {
        return text.to_string();
    }
    let dropped = js_len(text) - FALLBACK_TRUNCATION_LIMIT;
    format!(
        "{}… [truncated {} chars]",
        js_slice(text, 0, Some(FALLBACK_TRUNCATION_LIMIT as i64)),
        dropped
    )
}
