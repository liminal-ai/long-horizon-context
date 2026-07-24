//! Ported from packages/lhc/src/shared-tech/persist.ts. Phase 1 skeleton.
//!
//! LAYERING NOTE: this module imports the threads domain — faithful to the TS,
//! where persist.ts is the sanctioned exception to "shared-tech may not import
//! the domains" (derivation.ts comment).
//!
//! Transaction callbacks are lifetime-coupled boxed futures so an async
//! operation may borrow the transaction across `.await` (TS
//! `persist.ts:136-155,175-178`).

use std::future::Future;
use std::pin::Pin;

use crate::threads::ThreadRef;
#[allow(unused_imports)] // Phase 2 bodies; imported to mirror TS dependency graph
use crate::threads::internal::create::open_thread_database;
#[allow(unused_imports)]
use crate::threads::internal::registry::{
    open_registry_for_read, resolve_registry_path, select_thread_row, select_thread_rows_by_prefix,
};

use std::sync::Arc;

#[allow(unused_imports)]
use super::context::{resolve_instance_poke, run_with_thread_touch_suppressed};
use super::derivation::Clock;
#[allow(unused_imports)]
use super::errors::{ErrorResult, OpResult, storage_failure};
use super::storage::Db;

pub struct PostCommitHook {
    pub add: Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>,
}

pub struct PostCommitHookSet {
    pub add: Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>,
    pub flush: Box<dyn Fn() + Send + Sync>,
}

pub struct DbReadTransaction {
    pub db: Db,
    pub thread_id: String,
    pub file_path: String,
}

pub struct DbWriteTransaction {
    pub db: Db,
    pub thread_id: String,
    pub file_path: String,
    pub clock: Clock,
    pub post_commit_hook: PostCommitHook,
    /// `Arc`: enqueue clones this into `'static` post-commit ops
    /// (phase-review H2).
    pub poke: Arc<dyn Fn(&str) + Send + Sync>,
}

/// TS `DbReadTransaction | DbWriteTransaction` — borrowed so the outer
/// transaction controller retains ownership for COMMIT/ROLLBACK.
/// Used by logging's `writeLog` / `appendDerivationLog` which discriminate via
/// `"postCommitHook" in transaction`.
pub enum DbTransaction<'a> {
    Read(&'a DbReadTransaction),
    Write(&'a DbWriteTransaction),
}

pub fn create_post_commit_hook_set() -> PostCommitHookSet {
    todo!("phase 2")
}

fn thread_not_found<T>(_thread_id: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn file_not_found<T>(_file_path: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn ambiguous_thread_id<T>(_prefix: &str, _match_ids: &[String]) -> OpResult<T> {
    todo!("phase 2")
}

fn invalid_thread_ref<T>(_reason: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn detail(_cause: &dyn std::fmt::Display) -> String {
    todo!("phase 2")
}

fn is_blank_path(_file_path: &str) -> bool {
    todo!("phase 2")
}

struct ResolvedThreadFile {
    #[allow(dead_code)]
    file_path: String,
}

async fn resolve_thread_file(_thread_ref: ThreadRef) -> OpResult<ResolvedThreadFile> {
    todo!("phase 2")
}

fn read_thread_id(_db: &Db, _file_path: &str) -> OpResult<String> {
    todo!("phase 2")
}

/// TS `createDbReadTransaction` — PARTIAL stub.
///
/// Callback may borrow the transaction across `.await` via a lifetime-coupled
/// boxed future (no unconstrained separate `Fut` parameter).
pub async fn create_db_read_transaction<T, F>(_thread_ref: ThreadRef, _operation: F) -> OpResult<T>
where
    F: for<'a> FnOnce(&'a DbReadTransaction) -> Pin<Box<dyn Future<Output = T> + 'a>>,
{
    todo!("phase 2")
}

/// TS `createDbWriteTransaction` — PARTIAL stub.
///
/// Callback may borrow the transaction across `.await` via a lifetime-coupled
/// boxed future (no unconstrained separate `Fut` parameter).
pub async fn create_db_write_transaction<T, F>(
    _thread_ref: ThreadRef,
    _operation: F,
    _clock: Option<Clock>,
) -> OpResult<T>
where
    F: for<'a> FnOnce(&'a DbWriteTransaction) -> Pin<Box<dyn Future<Output = T> + 'a>>,
{
    todo!("phase 2")
}
