//! Ported from packages/lhc/src/threads/internal/. Phase 1 skeleton.
//!
//! create / registry symbols used by the threads domain and by
//! `shared_tech::persist` (sanctioned persist↔threads cycle).

pub mod create;
pub mod registry;
