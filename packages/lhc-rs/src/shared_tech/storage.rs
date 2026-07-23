//! Ported from packages/lhc/src/shared-tech/storage.ts. Phase 1 skeleton.
//!
//! REAL adapter surface (Wave 0/1 sqlite seam — fixture exception to the
//! `todo!("phase 2")` skeleton rule):
//! - `open_database` — open + pragma setup
//! - `Db::{path, exec, prepare, close}`
//! - `PreparedStatement::{get, get_params, all, run}`
//!
//! These mirror the node:sqlite `DatabaseSync` / `StatementSync` surface that
//! `openRaw` and logging-surface fixtures exercise. All other storage helpers
//! remain Phase 2 stubs.

use rusqlite::{Connection, params_from_iter};

use super::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};

pub const CURRENT_THREAD_SCHEMA_VERSION: i64 = 4;

/// The one database handle the rest of the crate sees.
pub struct Db {
    pub(crate) conn: Connection,
    path: String,
}

/// Minimal node:sqlite `StatementSync` stand-in for fixture probes.
/// REAL methods: [`Self::get`], [`Self::get_params`], [`Self::all`], [`Self::run`].
pub struct PreparedStatement<'a> {
    conn: &'a Connection,
    sql: String,
}

impl PreparedStatement<'_> {
    fn row_to_map(row: &rusqlite::Row<'_>) -> Option<serde_json::Map<String, serde_json::Value>> {
        let names: Vec<String> = row
            .as_ref()
            .column_names()
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(i).ok()?;
            map.insert(name.clone(), sqlite_value_to_json(value));
        }
        Some(map)
    }

    pub fn get(&self) -> Option<serde_json::Map<String, serde_json::Value>> {
        self.get_params(&[])
    }

    /// TS `StatementSync.get(...params)`.
    pub fn get_params(
        &self,
        params: &[&dyn rusqlite::types::ToSql],
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let mut stmt = self.conn.prepare(&self.sql).ok()?;
        let mut rows = stmt.query(params_from_iter(params.iter().copied())).ok()?;
        let row = rows.next().ok()??;
        Self::row_to_map(row)
    }

    /// TS `StatementSync.all(...params)`.
    pub fn all(
        &self,
        params: &[&dyn rusqlite::types::ToSql],
    ) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let Ok(mut stmt) = self.conn.prepare(&self.sql) else {
            return Vec::new();
        };
        let Ok(mut rows) = stmt.query(params_from_iter(params.iter().copied())) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        while let Ok(Some(row)) = rows.next() {
            if let Some(map) = Self::row_to_map(row) {
                out.push(map);
            }
        }
        out
    }

    /// TS `StatementSync.run(...params)`.
    pub fn run(&self, params: &[&dyn rusqlite::types::ToSql]) {
        self.conn
            .execute(&self.sql, params_from_iter(params.iter().copied()))
            .expect("sqlite run failed");
    }
}

impl Db {
    /// TS `databasePathFor(db)` — path this handle was opened with.
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn exec(&self, sql: &str) {
        self.conn.execute_batch(sql).expect("sqlite exec failed");
    }

    pub fn prepare(&self, sql: &str) -> PreparedStatement<'_> {
        PreparedStatement {
            conn: &self.conn,
            sql: sql.to_string(),
        }
    }

    pub fn close(self) {
        drop(self);
    }
}

fn sqlite_value_to_json(value: rusqlite::types::Value) -> serde_json::Value {
    match value {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::json!(i),
        rusqlite::types::Value::Real(f) => serde_json::json!(f),
        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(b) => serde_json::Value::Array(
            b.into_iter()
                .map(|byte| serde_json::Value::Number(byte.into()))
                .collect(),
        ),
    }
}

/// TS `openDatabase(path)`. REAL — Wave 0/1 sqlite seam.
pub fn open_database(path: &str) -> OpResult<Db> {
    match Connection::open(path) {
        Ok(conn) => {
            let db = Db {
                conn,
                path: path.to_string(),
            };
            db.exec("PRAGMA journal_mode = WAL;");
            db.exec("PRAGMA foreign_keys = ON;");
            db.exec("PRAGMA busy_timeout = 5000;");
            db.exec("PRAGMA synchronous = NORMAL;");
            OpResult::Ok { value: db }
        }
        Err(err) => OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::StorageFailure,
                reason: err.to_string(),
                event_index: None,
            },
        },
    }
}

pub fn get_schema_version(_db: &Db) -> OpResult<i64> {
    todo!("phase 2")
}
