//! Ported from packages/lhc/src/shared-tech/storage.ts. Phase 1 skeleton.
//!
//! REAL adapter surface (Wave 0/1 sqlite seam — fixture exception to the
//! `todo!("phase 2")` skeleton rule):
//! - `open_database` — open + pragma setup
//! - `Db::{path, exec, prepare, close}`
//! - `PreparedStatement::{get, get_params, all, run}`
//! - [`SqlParam`] — crate-owned bind values so tests never name rusqlite
//!
//! These mirror the node:sqlite `DatabaseSync` / `StatementSync` surface that
//! `openRaw` and logging-surface fixtures exercise. All other storage helpers
//! remain Phase 2 stubs.
//!
//! BOUNDARY: `rusqlite` may appear only in this file.

use rusqlite::{Connection, ToSql, params_from_iter};

use super::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};

pub const CURRENT_THREAD_SCHEMA_VERSION: i64 = 4;

/// Crate-owned SQL bind value. Tests and non-storage modules bind through this
/// type — they must not name `rusqlite`.
#[derive(Debug, Clone)]
pub enum SqlParam {
    Null,
    I64(i64),
    F64(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<i64> for SqlParam {
    fn from(v: i64) -> Self {
        SqlParam::I64(v)
    }
}

impl From<f64> for SqlParam {
    fn from(v: f64) -> Self {
        SqlParam::F64(v)
    }
}

impl From<String> for SqlParam {
    fn from(v: String) -> Self {
        SqlParam::Text(v)
    }
}

impl From<&str> for SqlParam {
    fn from(v: &str) -> Self {
        SqlParam::Text(v.to_string())
    }
}

impl From<Option<i64>> for SqlParam {
    fn from(v: Option<i64>) -> Self {
        match v {
            Some(n) => SqlParam::I64(n),
            None => SqlParam::Null,
        }
    }
}

impl From<Option<&str>> for SqlParam {
    fn from(v: Option<&str>) -> Self {
        match v {
            Some(s) => SqlParam::Text(s.to_string()),
            None => SqlParam::Null,
        }
    }
}

impl From<Option<String>> for SqlParam {
    fn from(v: Option<String>) -> Self {
        match v {
            Some(s) => SqlParam::Text(s),
            None => SqlParam::Null,
        }
    }
}

impl ToSql for SqlParam {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        match self {
            SqlParam::Null => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Null,
            )),
            SqlParam::I64(n) => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Integer(*n),
            )),
            SqlParam::F64(n) => Ok(rusqlite::types::ToSqlOutput::Owned(
                rusqlite::types::Value::Real(*n),
            )),
            SqlParam::Text(s) => Ok(rusqlite::types::ToSqlOutput::Borrowed(
                rusqlite::types::ValueRef::Text(s.as_bytes()),
            )),
            SqlParam::Blob(b) => Ok(rusqlite::types::ToSqlOutput::Borrowed(
                rusqlite::types::ValueRef::Blob(b),
            )),
        }
    }
}

/// The one database handle the rest of the crate sees.
///
/// The connection sits behind a `Mutex` so `Db: Sync` — drain/handler futures
/// hold `&Db` across await points and must stay `Send` for `tokio::spawn`
/// (phase-review H5). Uncontended per-statement locking; rusqlite stays
/// confined to this module.
pub struct Db {
    pub(crate) conn: std::sync::Mutex<Connection>,
    path: String,
}

impl Db {
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Minimal node:sqlite `StatementSync` stand-in for fixture probes.
/// REAL methods: [`Self::get`], [`Self::get_params`], [`Self::all`], [`Self::run`].
pub struct PreparedStatement<'a> {
    db: &'a Db,
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
        params: &[SqlParam],
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare(&self.sql).ok()?;
        let mut rows = stmt.query(params_from_iter(params.iter())).ok()?;
        let row = rows.next().ok()??;
        Self::row_to_map(row)
    }

    /// TS `StatementSync.all(...params)`.
    pub fn all(&self, params: &[SqlParam]) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let conn = self.db.lock();
        let Ok(mut stmt) = conn.prepare(&self.sql) else {
            return Vec::new();
        };
        let Ok(mut rows) = stmt.query(params_from_iter(params.iter())) else {
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
    pub fn run(&self, params: &[SqlParam]) {
        self.db
            .lock()
            .execute(&self.sql, params_from_iter(params.iter()))
            .expect("sqlite run failed");
    }
}

impl Db {
    /// TS `databasePathFor(db)` — path this handle was opened with.
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn exec(&self, sql: &str) {
        self.lock().execute_batch(sql).expect("sqlite exec failed");
    }

    pub fn prepare(&self, sql: &str) -> PreparedStatement<'_> {
        PreparedStatement {
            db: self,
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
                conn: std::sync::Mutex::new(conn),
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
