//! Ported from packages/lhc/src/shared-tech/storage.ts. Phase 1 skeleton.
//!
//! REAL adapter surface (Wave 0/1 sqlite seam — fixture exception to the
//! `todo!("phase 2")` skeleton rule):
//! - `open_database` — open + pragma setup
//! - `Db::{path, exec, prepare, close}`
//! - `PreparedStatement::{get, get_params, all, run}`
//! - [`SqlParam`] — crate-owned bind values so tests never name rusqlite
//! - [`StatementRunResult`] — node:sqlite `StatementSync.run` result
//!
//! These mirror the node:sqlite `DatabaseSync` / `StatementSync` surface that
//! `openRaw` and logging-surface fixtures exercise. All other storage helpers
//! remain Phase 2 stubs.
//!
//! BOUNDARY: `rusqlite` may appear only in this file.

use rusqlite::{Connection, ToSql, params_from_iter};

use super::errors::{OpResult, storage_failure};

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

/// node:sqlite `StatementSync.run` result — `{ changes, lastInsertRowid }`.
///
/// Amended Phase 2 Wave 1 repair-r1 (Lee/Fable): the Wave 0 storage seam
/// mirrors `node:sqlite`; this is the documented StatementSync.run result
/// shape, not an invented LHC surface. Callers that need hit/miss semantics
/// read `changes` directly — do **not** use a `SELECT changes()` substitute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementRunResult {
    pub changes: i64,
    pub last_insert_rowid: i64,
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
    fn row_to_map(
        row: &rusqlite::Row<'_>,
    ) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let names: Vec<String> = row
            .as_ref()
            .column_names()
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(i).map_err(|err| err.to_string())?;
            map.insert(name.clone(), sqlite_value_to_json(value));
        }
        Ok(map)
    }

    pub fn get(&self) -> Option<serde_json::Map<String, serde_json::Value>> {
        self.get_params(&[])
    }

    /// TS `StatementSync.get(...params)`.
    ///
    /// Error channel (M2 / node:sqlite parity): sqlite prepare/query/step/
    /// row-read failures panic with the underlying sqlite detail (TS throws).
    /// `None` means only "no row", never a swallowed sqlite error.
    pub fn get_params(
        &self,
        params: &[SqlParam],
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(&self.sql)
            .unwrap_or_else(|err| panic!("{err}"));
        let mut rows = stmt
            .query(params_from_iter(params.iter()))
            .unwrap_or_else(|err| panic!("{err}"));
        match rows.next() {
            Ok(Some(row)) => Some(Self::row_to_map(row).unwrap_or_else(|err| panic!("{err}"))),
            Ok(None) => None,
            Err(err) => panic!("{err}"),
        }
    }

    /// TS `StatementSync.all(...params)`.
    ///
    /// Error channel (M2): sqlite failures panic with underlying detail
    /// (TS throws). An empty `Vec` means zero rows, never a swallowed
    /// prepare/query error.
    pub fn all(&self, params: &[SqlParam]) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare(&self.sql)
            .unwrap_or_else(|err| panic!("{err}"));
        let mut rows = stmt
            .query(params_from_iter(params.iter()))
            .unwrap_or_else(|err| panic!("{err}"));
        let mut out = Vec::new();
        loop {
            match rows.next() {
                Ok(Some(row)) => {
                    out.push(Self::row_to_map(row).unwrap_or_else(|err| panic!("{err}")));
                }
                Ok(None) => break,
                Err(err) => panic!("{err}"),
            }
        }
        out
    }

    /// TS `StatementSync.run(...params)` → `{ changes, lastInsertRowid }`.
    ///
    /// Error channel (M2): sqlite failures panic with underlying detail
    /// (TS throws). Returns the exact affected-row count and last insert
    /// row id from this execution (Lee/Fable StatementRunResult amendment).
    pub fn run(&self, params: &[SqlParam]) -> StatementRunResult {
        let conn = self.db.lock();
        let changes = conn
            .execute(&self.sql, params_from_iter(params.iter()))
            .unwrap_or_else(|err| panic!("{err}")) as i64;
        let last_insert_rowid = conn.last_insert_rowid();
        StatementRunResult {
            changes,
            last_insert_rowid,
        }
    }
}

impl Db {
    /// TS `databasePathFor(db)` — path this handle was opened with.
    /// Empty string is a known path (distinct from an absent WeakMap entry).
    pub fn path(&self) -> &str {
        &self.path
    }

    /// TS `DatabaseSync.exec(sql)`. Error channel (M2): sqlite failures panic
    /// with underlying detail (TS throws).
    pub fn exec(&self, sql: &str) {
        self.lock()
            .execute_batch(sql)
            .unwrap_or_else(|err| panic!("{err}"));
    }

    /// TS `DatabaseSync.prepare(sql)`.
    ///
    /// Compiles under the mutex so invalid SQL fails at `prepare` (node:sqlite
    /// parity), then retains the SQL string for later get/all/run execution.
    pub fn prepare(&self, sql: &str) -> PreparedStatement<'_> {
        {
            let conn = self.lock();
            let _stmt = conn.prepare(sql).unwrap_or_else(|err| panic!("{err}"));
        }
        PreparedStatement {
            db: self,
            sql: sql.to_string(),
        }
    }

    /// TS `DatabaseSync.close()`. Close errors panic with underlying detail.
    pub fn close(self) {
        let Db { conn, path: _ } = self;
        let conn = conn
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err((_conn, err)) = conn.close() {
            panic!("{err}");
        }
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
///
/// Error channel (M2): TS `openDatabase` throws on open failure. The frozen
/// Phase 1 public shape wraps open in [`OpResult`] so operation-boundary
/// openers (`ThreadDbOpener`, `HandlerRunContext.open_db`) can return a
/// structured `storage_failure` without panicking. Pragma setup failures
/// still panic (TS would throw after a successful open).
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
        Err(err) => storage_failure(&err.to_string()),
    }
}

/// TS `getSchemaVersion(db)` returns a number (throws on sqlite failure).
/// Frozen Phase 1 shape is [`OpResult<i64>`]: success is `Ok { value }`;
/// sqlite failures on the prepare/get path panic inside [`PreparedStatement`]
/// (TS throw), and are not collapsed into `OpResult::Err`.
pub fn get_schema_version(db: &Db) -> OpResult<i64> {
    let row = db.prepare("PRAGMA user_version").get();
    let version = match row.as_ref().and_then(|m| m.get("user_version")) {
        None | Some(serde_json::Value::Null) => 0,
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|u| u as i64))
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(other) => other
            .as_i64()
            .or_else(|| other.as_f64().map(|f| f as i64))
            .unwrap_or(0),
    };
    OpResult::Ok { value: version }
}
