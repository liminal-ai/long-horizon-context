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

/// Percent-encode a filesystem path for a SQLite URI (keeps `/`, `.`, `_`, `-`).
fn sqlite_uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    for &b in path.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'-' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// INTERNAL — side-effect-free open for `peekThreadId`.
///
/// Uses a SQLite URI with `mode=ro` + `immutable=1` so WAL coordination cannot
/// create `-wal`/`-shm` sidecars or write locking state (plain
/// `SQLITE_OPEN_READ_ONLY` is insufficient for WAL files). No pragma/schema
/// mutations. Preserves underlying open-error detail via [`storage_failure`].
/// Not a crate-root or SDK API — `rusqlite` stays here.
///
/// **Contract:** main-file / immutable only — does **not** see uncheckpointed
/// WAL frames. Thread-file identity validation must use
/// [`open_database_for_thread_validation`] instead; do not weaken this opener.
pub(crate) fn open_database_read_only(path: &str) -> OpResult<Db> {
    let uri = format!("file:{}?mode=ro&immutable=1", sqlite_uri_encode_path(path));
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_URI
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(&uri, flags) {
        Ok(conn) => OpResult::Ok {
            value: Db {
                conn: std::sync::Mutex::new(conn),
                path: path.to_string(),
            },
        },
        Err(err) => storage_failure(&err.to_string()),
    }
}

/// Handle from [`open_database_for_thread_validation`]: Db over a private
/// copy plus cleanup of the temp directory on drop (after close).
pub(crate) struct ThreadValidationDb {
    db: Option<Db>,
    temp_dir: Option<std::path::PathBuf>,
}

impl ThreadValidationDb {
    pub fn db(&self) -> &Db {
        self.db.as_ref().expect("ThreadValidationDb still open")
    }

    /// Close the SQLite handle (may panic like [`Db::close`]); temp cleanup
    /// still runs on drop.
    pub fn close(&mut self) {
        if let Some(db) = self.db.take() {
            db.close();
        }
    }
}

impl Drop for ThreadValidationDb {
    fn drop(&mut self) {
        if let Some(db) = self.db.take() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| db.close()));
        }
        if let Some(dir) = self.temp_dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Process-local sequence for validation temp roots (repair-r2 / Amendment F).
static VALIDATION_TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Bound on source-epoch stability retries. Exhaustion is [`storage_failure`],
/// never a false `thread_not_found` for a still-valid source.
const VALIDATION_EPOCH_RETRIES: u32 = 128;

/// Fingerprint of the source main + WAL (+ rollback journal) epoch.
///
/// **Invariant:** a private copy is coherent iff the source fingerprint taken
/// immediately before the copy equals the fingerprint taken immediately after.
/// Independent main-then-WAL copies are **not** atomic across a checkpoint;
/// stability detection + retry is required. SHM is intentionally omitted —
/// stale `-shm` paired with a mismatched main/WAL is worse than letting
/// SQLite rebuild a private wal-index from the coherent main+WAL pair.
///
/// Content hash (not mtime): a no-op `wal_checkpoint` can bump mtimes without
/// changing bytes; mtime-based fingerprints would exhaust retries and
/// misclassify a stable valid source as `storage_failure`.
#[derive(Clone, PartialEq, Eq, Debug)]
struct SourceEpoch {
    main: (u64, u64),
    wal: Option<(u64, u64)>,
    journal: Option<(u64, u64)>,
}

fn file_content_fp(path: &std::path::Path) -> std::io::Result<Option<(u64, u64)>> {
    use std::hash::{Hash, Hasher};
    use std::io::Read;
    if !path.exists() {
        return Ok(None);
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buf = [0u8; 64 * 1024];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        len += n as u64;
        buf[..n].hash(&mut hasher);
    }
    Ok(Some((len, hasher.finish())))
}

fn fingerprint_source(main: &std::path::Path) -> Result<SourceEpoch, String> {
    let main_fp = file_content_fp(main)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unable to open database file".to_string())?;
    let wal = file_content_fp(&std::path::PathBuf::from(format!("{}-wal", main.display())))
        .map_err(|e| e.to_string())?;
    let journal = file_content_fp(&std::path::PathBuf::from(format!(
        "{}-journal",
        main.display()
    )))
    .map_err(|e| e.to_string())?;
    Ok(SourceEpoch {
        main: main_fp,
        wal,
        journal,
    })
}

fn create_validation_temp_dir() -> OpResult<std::path::PathBuf> {
    use std::sync::atomic::Ordering;
    let pid = std::process::id();
    loop {
        let seq = VALIDATION_TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("lhc-thread-validate-{pid}-{seq}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return OpResult::Ok { value: dir },
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return storage_failure(&format!("could not prepare validation copy: {err}"));
            }
        }
    }
}

fn clear_dir_files(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// Copy main + WAL (+ journal) under a stable source epoch. Does **not** copy
/// `-shm`. Retries when the source epoch changes mid-copy.
fn copy_coherent_validation_snapshot(
    src_main: &std::path::Path,
    temp_dir: &std::path::Path,
    file_name: &str,
) -> Result<(), String> {
    let dest_main = temp_dir.join(file_name);
    let src_wal = std::path::PathBuf::from(format!("{}-wal", src_main.display()));
    let src_journal = std::path::PathBuf::from(format!("{}-journal", src_main.display()));
    let dest_wal = temp_dir.join(format!("{file_name}-wal"));
    let dest_journal = temp_dir.join(format!("{file_name}-journal"));
    // Never trust/copy SHM into the private snapshot.
    let dest_shm = temp_dir.join(format!("{file_name}-shm"));

    for _attempt in 0..VALIDATION_EPOCH_RETRIES {
        clear_dir_files(temp_dir);
        let before = fingerprint_source(src_main)?;

        std::fs::copy(src_main, &dest_main).map_err(|e| e.to_string())?;

        if before.wal.is_some() {
            if src_wal.exists() {
                std::fs::copy(&src_wal, &dest_wal).map_err(|e| e.to_string())?;
            }
        }
        if before.journal.is_some() {
            if src_journal.exists() {
                std::fs::copy(&src_journal, &dest_journal).map_err(|e| e.to_string())?;
            }
        }
        let _ = std::fs::remove_file(&dest_shm);

        let after = fingerprint_source(src_main)?;
        if after == before {
            return Ok(());
        }
        // Epoch moved (checkpoint / WAL append / truncate) — retry.
    }
    Err("could not prepare validation copy: source database changed under copy".to_string())
}

/// INTERNAL — WAL-aware, non-mutating open for `validateThreadFile`.
///
/// TS `new DatabaseSync(path, { readOnly: true })` sees live WAL frames.
/// A direct `mode=ro` open on the candidate can rewrite `-shm` bytes (Node
/// does too); this path instead takes an **epoch-stable** private copy of
/// main + `-wal` (+ `-journal` when present) — never `-shm` — into an
/// exclusively created temp directory and opens that copy with `mode=ro`
/// **without** `immutable=1`.
///
/// **Coherence invariant:** fingerprint(main, wal, journal) before the copy
/// must equal fingerprint after; otherwise retry (bounded). Independent
/// main-then-WAL copies without that check can tear across a checkpoint
/// (old main + emptied WAL → false `no lhc schema version`).
///
/// Distinct from [`open_database_read_only`] — do not reuse that immutable
/// peek opener here.
pub(crate) fn open_database_for_thread_validation(path: &str) -> OpResult<ThreadValidationDb> {
    use std::path::Path;

    let src = Path::new(path);
    if !src.exists() {
        return storage_failure("unable to open database file");
    }

    let temp_dir = match create_validation_temp_dir() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };

    let file_name = match src.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return storage_failure("could not prepare validation copy: invalid path");
        }
    };

    if let Err(detail) = copy_coherent_validation_snapshot(src, &temp_dir, &file_name) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return storage_failure(&detail);
    }

    let dest_main = temp_dir.join(&file_name);
    let dest_str = match dest_main.to_str() {
        Some(s) => s.to_string(),
        None => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return storage_failure("could not prepare validation copy: non-utf8 path");
        }
    };
    let uri = format!("file:{}?mode=ro", sqlite_uri_encode_path(&dest_str));
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_URI
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(&uri, flags) {
        Ok(conn) => OpResult::Ok {
            value: ThreadValidationDb {
                db: Some(Db {
                    conn: std::sync::Mutex::new(conn),
                    path: dest_str,
                }),
                temp_dir: Some(temp_dir),
            },
        },
        Err(err) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            storage_failure(&err.to_string())
        }
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
