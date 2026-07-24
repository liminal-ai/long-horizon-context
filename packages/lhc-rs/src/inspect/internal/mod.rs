//! Ported from packages/lhc/src/inspect/internal/.
//!
//! Composition helpers for the inspect surface (health, overview, view-report).
//! Module wiring only — no aggregate `pub use` (callers import submodule paths).

pub mod health;
pub mod overview;
pub mod view_report;
