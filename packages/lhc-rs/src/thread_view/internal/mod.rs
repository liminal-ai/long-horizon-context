//! Ported from packages/lhc/src/thread-view/internal/.
//!
//! Wave 6: all ten internal modules. Module wiring only — no aggregate
//! `pub use` (callers import submodule paths; parent `thread_view` re-exports
//! the public surface).

pub mod assemble;
pub mod boundary;
pub mod compact_compute;
pub(crate) mod exact_i64;
pub mod materialize;
pub mod profiles;
pub mod protected_boundary;
pub mod render;
pub mod seam;
pub mod select;
pub mod session_view;
pub mod snapshot;
