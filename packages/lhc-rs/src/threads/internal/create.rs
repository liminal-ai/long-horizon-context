//! Ported from packages/lhc/src/threads/internal/create.ts. Phase 1 skeleton.
//!
//! Wave-later PARTIAL: only `open_thread_database` for shared_tech/persist.rs.

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::storage::Db;

/// TS `openThreadDatabase(filePath)` — validate, open, migrate, fire touch.
pub fn open_thread_database(_file_path: &str) -> OpResult<Db> {
    todo!("phase 2")
}
