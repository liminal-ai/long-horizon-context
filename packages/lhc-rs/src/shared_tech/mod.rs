//! Ported from packages/lhc/src/shared-tech/index.ts.
//!
//! Public technical surface for mechanism-only capabilities consumed by LHC
//! product domains. Sub-capabilities with their own public entrypoints
//! (`work_queue`, `token_counting`, `logging`, `prompts`) remain importable
//! directly; everything else should flow through this index.
//!
//! Not re-exported here (TS does not `export *` them from index.ts):
//! `logging`, `prompts`, `token_counting`, `work_queue`, `js_json`,
//! `thread_migrate`.

pub mod classify;
pub mod compact_continuation;
pub mod content_blocks;
pub mod context;
pub mod derivation;
pub mod deterministic;
pub mod durable_work;
pub mod errors;
pub mod inference_adapter;
pub mod inference_types;
pub mod inspect;
pub mod js_json;
pub mod logging;
pub mod persist;
pub mod prompts;
pub mod report;
pub mod scheduler;
pub mod sha256;
pub mod storage;
pub mod thread_migrate;
pub(crate) mod time;
pub mod token_counting;
pub mod tool_result_rendering;
pub mod view;
pub mod work_queue;

// ── index.ts `export *` closure (16 modules) ──────────────────────────
// Mechanical TS→Rust notes:
// - `DETERMINISTIC_MARKERS` Record → [`deterministic::deterministic_marker`]
// - `databasePathFor` → [`storage::Db::path`] (method; no free fn)
// - Nested inspect/view/durable_work supporting types are pub for Rust use
//   of the parent shapes (TS inlines them).
// - `compact_continuation` is the pure LIM-60 contract/oracle (LIM-62);
//   LIM-61 live-thread runtime is intentionally not ported here.

pub use classify::*;
pub use compact_continuation::*;
pub use content_blocks::*;
pub use context::*;
pub use derivation::*;
pub use deterministic::*;
pub use durable_work::*;
pub use errors::*;
pub use inference_adapter::*;
pub use inference_types::*;
pub use inspect::*;
pub use persist::*;
pub use report::*;
pub use scheduler::*;
pub use storage::*;
pub use tool_result_rendering::*;
pub use view::*;
