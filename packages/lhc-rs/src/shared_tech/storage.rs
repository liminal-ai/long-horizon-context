//! Ported from packages/lhc/src/shared-tech/storage.ts. Phase 1 skeleton.
//!
//! Wave 0 PARTIAL: the sqlite adapter seam. This is the ONLY module in the
//! crate that may use `rusqlite` (the port's counterpart of TS importing
//! `node:sqlite` only here) — gate-enforced. Wave 1 extends this file with
//! the rest of storage.ts (schema creation, migration walk); extend, don't
//! reshape.
//!
//! TS keeps a `WeakMap<DatabaseSync, string>` of open paths; Rust owns the
//! path inside the handle struct — same information, ownership instead of a
//! side table.

use rusqlite::Connection;

use super::errors::OpResult;

pub const CURRENT_THREAD_SCHEMA_VERSION: i64 = 4;

/// The one database handle the rest of the crate sees. Wraps the rusqlite
/// connection with the path TS tracked in its WeakMap.
pub struct Db {
    pub(crate) conn: Connection,
    path: String,
}

impl Db {
    /// TS `databasePathFor(db)`.
    pub fn path(&self) -> &str {
        &self.path
    }
}

/// TS `openDatabase(path)`: open + WAL, foreign_keys ON, busy_timeout 5000,
/// synchronous NORMAL.
pub fn open_database(path: &str) -> OpResult<Db> {
    let _ = path;
    todo!("phase 2")
}

/// TS `getSchemaVersion(db)`: `PRAGMA user_version`.
pub fn get_schema_version(db: &Db) -> OpResult<i64> {
    let _ = db;
    todo!("phase 2")
}
