//! The two-state Smart Compact plan selector.

use std::sync::Once;

pub const COMPACT_ALGORITHM_ENV_VAR: &str = "LHC_COMPACT_ALGORITHM";
pub const LEGACY_COMPACT_ALGORITHM: &str = "legacy";
pub const LEGACY_COMPACT_DIAGNOSTIC: &str = "LHC_COMPACT_ALGORITHM=legacy: Smart Compact is running the legacy eager selector, which reads every live message and every closed chunk's fallback material before selecting. Unset it to restore the bounded selector.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactAlgorithm {
    Bounded,
    Legacy,
}

pub fn resolve_compact_algorithm() -> CompactAlgorithm {
    match std::env::var(COMPACT_ALGORITHM_ENV_VAR) {
        Ok(value) if value == LEGACY_COMPACT_ALGORITHM => CompactAlgorithm::Legacy,
        _ => CompactAlgorithm::Bounded,
    }
}

pub fn emit_legacy_compact_diagnostic() {
    static EMIT: Once = Once::new();
    EMIT.call_once(|| {
        eprintln!("LhcCompactAlgorithmWarning: {LEGACY_COMPACT_DIAGNOSTIC}");
    });
}
