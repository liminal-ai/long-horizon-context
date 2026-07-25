//! Ported from packages/lhc/src/shared-tech/persist.ts.
//!
//! LAYERING NOTE: this module imports the threads domain — faithful to the TS,
//! where persist.ts is the sanctioned exception to "shared-tech may not import
//! the domains" (derivation.ts comment).
//!
//! Transaction callbacks are lifetime-coupled boxed futures so an async
//! operation may borrow the transaction across `.await` (TS
//! `persist.ts:136-155,175-178`).

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::FutureExt;

use crate::threads::ThreadRef;
use crate::threads::internal::create::open_thread_database;
use crate::threads::internal::registry::{
    open_registry_for_read, resolve_registry_path, select_thread_row, select_thread_rows_by_prefix,
};

use super::context::{resolve_instance_poke, run_with_thread_touch_suppressed};
use super::derivation::Clock;
use super::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};
use super::js_json::js_trim;
use super::storage::Db;

/// One post-commit operation (TS enqueue of a thunk).
pub type PostCommitOp = Box<dyn FnOnce() + Send>;
/// Registrar that accepts a [`PostCommitOp`].
pub type PostCommitAdd = Box<dyn Fn(PostCommitOp) + Send + Sync>;

pub struct PostCommitHook {
    pub add: PostCommitAdd,
}

pub struct PostCommitHookSet {
    pub add: PostCommitAdd,
    pub flush: Box<dyn Fn() + Send + Sync>,
}

pub struct DbReadTransaction<'db> {
    pub db: &'db Db,
    pub thread_id: String,
    pub file_path: String,
}

pub struct DbWriteTransaction<'db> {
    pub db: &'db Db,
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
    Read(&'a DbReadTransaction<'a>),
    Write(&'a DbWriteTransaction<'a>),
}

fn post_commit_pair() -> (PostCommitHookSet, PostCommitHook) {
    let operations: Arc<Mutex<Vec<PostCommitOp>>> = Arc::new(Mutex::new(Vec::new()));
    let ops_add_set = operations.clone();
    let ops_add_hook = operations.clone();
    let ops_flush = operations;
    let set = PostCommitHookSet {
        add: Box::new(move |operation| {
            ops_add_set
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(operation);
        }),
        flush: Box::new(move || {
            let pending: Vec<_> = ops_flush
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .drain(..)
                .collect();
            for operation in pending {
                operation();
            }
        }),
    };
    let hook = PostCommitHook {
        add: Box::new(move |operation| {
            ops_add_hook
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(operation);
        }),
    };
    (set, hook)
}

pub fn create_post_commit_hook_set() -> PostCommitHookSet {
    post_commit_pair().0
}

fn thread_not_found<T>(thread_id: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("no thread registered with id {thread_id}"),
            event_index: None,
        },
    }
}

fn file_not_found<T>(file_path: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("no thread file exists at {file_path}"),
            event_index: None,
        },
    }
}

fn ambiguous_thread_id<T>(prefix: &str, match_ids: &[String]) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::AmbiguousThreadId,
            reason: format!(
                "thread id \"{prefix}\" is ambiguous: it matches {} threads ({}); use a longer id",
                match_ids.len(),
                match_ids.join(", ")
            ),
            event_index: None,
        },
    }
}

fn invalid_thread_ref<T>(reason: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::InvalidThreadRef,
            reason: reason.to_string(),
            event_index: None,
        },
    }
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "Box<Any>".to_string()
}

fn is_blank_path(file_path: &str) -> bool {
    js_trim(file_path).is_empty()
}

struct ResolvedThreadFile {
    file_path: String,
}

/// TS `resolveThreadFile` — registry open/select/prefix failures become
/// `storage_failure("registry read failed: …")`; registry close is a finally
/// action whose own failure propagates (`persist.ts:102-121`).
async fn resolve_thread_file(thread_ref: ThreadRef) -> OpResult<ResolvedThreadFile> {
    match thread_ref {
        ThreadRef::File(file) => {
            if is_blank_path(&file.file_path) {
                return invalid_thread_ref(
                    "filePath must be a non-empty path; received a blank string",
                );
            }
            OpResult::Ok {
                value: ResolvedThreadFile {
                    file_path: file.file_path,
                },
            }
        }
        ThreadRef::Id(id) => {
            // Open may panic (Wave 3 todos); contain into storage_failure.
            let opened = catch_unwind(AssertUnwindSafe(|| {
                let registry_path = resolve_registry_path(id.registry_path.as_deref());
                open_registry_for_read(&registry_path)
            }));
            let registry = match opened {
                Ok(registry) => registry,
                Err(payload) => {
                    return storage_failure(&format!(
                        "registry read failed: {}",
                        panic_payload_message(payload)
                    ));
                }
            };
            let Some(registry) = registry else {
                return thread_not_found(&id.thread_id);
            };

            let select = catch_unwind(AssertUnwindSafe(|| {
                let exact = select_thread_row(&registry, &id.thread_id);
                if let Some(exact) = exact {
                    OpResult::Ok {
                        value: ResolvedThreadFile {
                            file_path: exact.file_path,
                        },
                    }
                } else {
                    let matches = select_thread_rows_by_prefix(&registry, &id.thread_id);
                    if matches.len() == 1 {
                        OpResult::Ok {
                            value: ResolvedThreadFile {
                                file_path: matches[0].file_path.clone(),
                            },
                        }
                    } else if matches.len() > 1 {
                        let match_ids: Vec<String> =
                            matches.iter().map(|m| m.thread_id.clone()).collect();
                        ambiguous_thread_id(&id.thread_id, &match_ids)
                    } else {
                        thread_not_found(&id.thread_id)
                    }
                }
            }));

            // finally: registry.close() — close failure propagates (TS).
            let close_result = catch_unwind(AssertUnwindSafe(|| registry.close()));

            match close_result {
                Ok(()) => {}
                Err(close_payload) => std::panic::resume_unwind(close_payload),
            }

            match select {
                Ok(result) => result,
                Err(payload) => storage_failure(&format!(
                    "registry read failed: {}",
                    panic_payload_message(payload)
                )),
            }
        }
    }
}

fn read_thread_id(db: &Db, file_path: &str) -> OpResult<String> {
    let row = catch_unwind(AssertUnwindSafe(|| {
        db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1")
            .get()
    }));
    match row {
        Ok(None) => storage_failure(&format!("thread file at {file_path} lost its metadata row")),
        Ok(Some(map)) => match map.get("thread_id").and_then(|v| v.as_str()) {
            Some(id) => OpResult::Ok {
                value: id.to_string(),
            },
            None => storage_failure(&format!("thread file at {file_path} lost its metadata row")),
        },
        Err(payload) => storage_failure(&format!(
            "thread metadata read failed: {}",
            panic_payload_message(payload)
        )),
    }
}

fn try_exec(db: &Db, sql: &str) {
    let _ = catch_unwind(AssertUnwindSafe(|| db.exec(sql)));
}

fn try_close(db: Db) {
    let _ = catch_unwind(AssertUnwindSafe(|| db.close()));
}

/// TS `createDbReadTransaction`.
///
/// Callback may borrow the transaction across `.await` via a lifetime-coupled
/// boxed future (no unconstrained separate `Fut` parameter). The controller
/// owns `Db` for BEGIN/COMMIT/ROLLBACK/close and lends `&Db` into the bag.
pub async fn create_db_read_transaction<T, F>(thread_ref: ThreadRef, operation: F) -> OpResult<T>
where
    F: for<'a> FnOnce(&'a DbReadTransaction<'a>) -> Pin<Box<dyn Future<Output = T> + 'a>>,
{
    run_with_thread_touch_suppressed(async move {
        let resolved = resolve_thread_file(thread_ref).await;
        let OpResult::Ok {
            value: ResolvedThreadFile { file_path },
        } = resolved
        else {
            return match resolved {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };
        if !Path::new(&file_path).exists() {
            return file_not_found(&file_path);
        }
        let opened = open_thread_database(&file_path);
        let OpResult::Ok { value: db } = opened else {
            return match opened {
                OpResult::Err { error } => OpResult::Err { error },
                OpResult::Ok { .. } => unreachable!(),
            };
        };

        // try { BEGIN; metadata; await op; COMMIT } catch { fail-soft ROLLBACK; throw }
        // finally { fail-soft close }. BEGIN is inside try (persist.ts:148-171).
        let begin = catch_unwind(AssertUnwindSafe(|| db.exec("BEGIN;")));
        if let Err(payload) = begin {
            try_exec(&db, "ROLLBACK;");
            try_close(db);
            std::panic::resume_unwind(payload);
        }

        let thread_id = read_thread_id(&db, &file_path);
        let OpResult::Ok { value: thread_id } = thread_id else {
            let err = match thread_id {
                OpResult::Err { error } => error,
                OpResult::Ok { .. } => unreachable!(),
            };
            // Metadata-error ROLLBACK is *not* fail-soft in TS. If it fails,
            // that error enters the outer catch (fail-soft rollback + close),
            // then the first rollback error propagates.
            match catch_unwind(AssertUnwindSafe(|| db.exec("ROLLBACK;"))) {
                Ok(()) => {
                    try_close(db);
                    return OpResult::Err { error: err };
                }
                Err(rollback_payload) => {
                    try_exec(&db, "ROLLBACK;");
                    try_close(db);
                    std::panic::resume_unwind(rollback_payload);
                }
            }
        };

        // Bag borrows controller-owned `db`; drop bag before close.
        let body = {
            let txn = DbReadTransaction {
                db: &db,
                thread_id,
                file_path,
            };

            async {
                let fut = match catch_unwind(AssertUnwindSafe(|| operation(&txn))) {
                    Ok(fut) => fut,
                    Err(payload) => return Err(payload),
                };
                match AssertUnwindSafe(fut).catch_unwind().await {
                    Ok(value) => match catch_unwind(AssertUnwindSafe(|| db.exec("COMMIT;"))) {
                        Ok(()) => Ok(value),
                        Err(payload) => Err(payload),
                    },
                    Err(payload) => Err(payload),
                }
            }
            .await
        };

        match body {
            Ok(value) => {
                try_close(db);
                OpResult::Ok { value }
            }
            Err(payload) => {
                try_exec(&db, "ROLLBACK;");
                try_close(db);
                std::panic::resume_unwind(payload);
            }
        }
    })
    .await
}

/// TS `createDbWriteTransaction`.
///
/// Callback may borrow the transaction across `.await` via a lifetime-coupled
/// boxed future (no unconstrained separate `Fut` parameter). The controller
/// owns `Db` for BEGIN/COMMIT/ROLLBACK/close and lends `&Db` into the bag.
pub async fn create_db_write_transaction<T, F>(
    thread_ref: ThreadRef,
    operation: F,
    clock: Option<Clock>,
) -> OpResult<T>
where
    F: for<'a> FnOnce(&'a DbWriteTransaction<'a>) -> Pin<Box<dyn Future<Output = T> + 'a>>,
{
    let resolved = resolve_thread_file(thread_ref).await;
    let OpResult::Ok {
        value: ResolvedThreadFile { file_path },
    } = resolved
    else {
        return match resolved {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    if !Path::new(&file_path).exists() {
        return file_not_found(&file_path);
    }
    let opened = open_thread_database(&file_path);
    let OpResult::Ok { value: db } = opened else {
        return match opened {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };
    let (hook_set, post_commit_hook) = post_commit_pair();
    // Explicit arg wins; else the running SDK instance clock; else wall time.
    // Mirrors TS Date freeze / SdkConfig.clock for write-path stamps.
    let clock: Clock = clock
        .or_else(|| {
            crate::shared_tech::context::resolve_instance_config().map(|c| Arc::clone(&c.clock))
        })
        .unwrap_or_else(|| Arc::new(SystemTime::now));
    let poke: Arc<dyn Fn(&str) + Send + Sync> = Arc::from(resolve_instance_poke());

    // Outer try/finally (persist.ts:188-220): metadata then BEGIN IMMEDIATE.
    let thread_id = read_thread_id(&db, &file_path);
    let OpResult::Ok { value: thread_id } = thread_id else {
        try_close(db);
        return match thread_id {
            OpResult::Err { error } => OpResult::Err { error },
            OpResult::Ok { .. } => unreachable!(),
        };
    };

    let begin = catch_unwind(AssertUnwindSafe(|| db.exec("BEGIN IMMEDIATE;")));
    if let Err(payload) = begin {
        try_close(db);
        std::panic::resume_unwind(payload);
    }

    // Bag borrows controller-owned `db`; drop bag before close / flush.
    let body = {
        let txn = DbWriteTransaction {
            db: &db,
            thread_id,
            file_path,
            clock,
            post_commit_hook,
            poke,
        };

        async {
            let fut = match catch_unwind(AssertUnwindSafe(|| operation(&txn))) {
                Ok(fut) => fut,
                Err(payload) => return Err(payload),
            };
            match AssertUnwindSafe(fut).catch_unwind().await {
                Ok(value) => match catch_unwind(AssertUnwindSafe(|| db.exec("COMMIT;"))) {
                    Ok(()) => Ok(value),
                    Err(payload) => Err(payload),
                },
                Err(payload) => Err(payload),
            }
        }
        .await
    };

    match body {
        Ok(value) => {
            // Flush only after successful COMMIT; hook panic still closes first.
            let flush_result = catch_unwind(AssertUnwindSafe(|| (hook_set.flush)()));
            try_close(db);
            match flush_result {
                Ok(()) => OpResult::Ok { value },
                Err(payload) => std::panic::resume_unwind(payload),
            }
        }
        Err(payload) => {
            try_exec(&db, "ROLLBACK;");
            try_close(db);
            std::panic::resume_unwind(payload);
        }
    }
}
