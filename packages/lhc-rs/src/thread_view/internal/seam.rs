//! Ported from packages/lhc/src/thread-view/internal/seam.ts.
//!
//! Test injection facility for compact's write path. Production code carries
//! the point as a no-op unless a test installs a hook:
//! - `"compact-write"` fires between the sweep and the view-write transaction.
//! - `"compact-install-before-validate"` fires inside BEGIN IMMEDIATE before
//!   source validation (install TOCTOU / in-txn proofs).
//!
//! Tests reach the setters through `tests/fixtures/view_seam.rs` (the one
//! directory sanctioned to import below the SDK surface); production code
//! only ever fires.
//!
//! REAL — the hook table *is* the seam (no deferred behavior).

use std::sync::{Arc, Mutex, MutexGuard};

use crate::shared_tech::storage::Db;

/// TS `ViewInjectionPoint`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ViewInjectionPoint {
    CompactWrite,
    /// Fires inside BEGIN IMMEDIATE before source validation (install TOCTOU).
    CompactInstallBeforeValidate,
}

impl ViewInjectionPoint {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewInjectionPoint::CompactWrite => "compact-write",
            ViewInjectionPoint::CompactInstallBeforeValidate => "compact-install-before-validate",
        }
    }
}

/// TS `ViewInjectionHook = () => void` for points that do not pass a db handle.
///
/// [`Arc`] so [`fire_view_injection`] can clone the hook out of the mutex
/// before invoking it (hook panics must not poison the table lock).
pub type ViewInjectionHook = Arc<dyn Fn() + Send + Sync>;

/// Hook that receives the open thread db (TS `ctx?: { db }`).
pub type ViewInjectionDbHook = Arc<dyn Fn(&Db) + Send + Sync>;

static COMPACT_WRITE_HOOK: Mutex<Option<ViewInjectionHook>> = Mutex::new(None);
static INSTALL_BEFORE_VALIDATE_HOOK: Mutex<Option<ViewInjectionDbHook>> = Mutex::new(None);

fn compact_write_lock() -> MutexGuard<'static, Option<ViewInjectionHook>> {
    COMPACT_WRITE_HOOK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn install_before_validate_lock() -> MutexGuard<'static, Option<ViewInjectionDbHook>> {
    INSTALL_BEFORE_VALIDATE_HOOK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// TS `setViewInjectionHook` for zero-arg points (`compact-write`).
pub fn set_view_injection_hook(point: ViewInjectionPoint, hook: Option<ViewInjectionHook>) {
    match point {
        ViewInjectionPoint::CompactWrite => {
            *compact_write_lock() = hook;
        }
        ViewInjectionPoint::CompactInstallBeforeValidate => {
            panic!(
                "set_view_injection_hook: compact-install-before-validate requires set_view_injection_db_hook"
            );
        }
    }
}

/// Install a db-aware hook for `compact-install-before-validate`.
pub fn set_view_injection_db_hook(point: ViewInjectionPoint, hook: Option<ViewInjectionDbHook>) {
    match point {
        ViewInjectionPoint::CompactInstallBeforeValidate => {
            *install_before_validate_lock() = hook;
        }
        ViewInjectionPoint::CompactWrite => {
            panic!("set_view_injection_db_hook: compact-write uses set_view_injection_hook");
        }
    }
}

/// TS `fireViewInjection` — no-op when nothing is installed. An installed
/// hook's panic propagates to the call site on purpose — that is the injected
/// failure the call site must survive. The hook is cloned under the table lock
/// and invoked outside it so a panic cannot poison subsequent set/clear/fire.
pub fn fire_view_injection(point: ViewInjectionPoint) {
    let hook = {
        let guard = compact_write_lock();
        match point {
            ViewInjectionPoint::CompactWrite => guard.clone(),
            ViewInjectionPoint::CompactInstallBeforeValidate => None,
        }
    };
    if let Some(hook) = hook {
        hook();
    }
}

/// Fire a db-aware injection point (must run inside an open write transaction).
pub fn fire_view_injection_with_db(point: ViewInjectionPoint, db: &Db) {
    let hook = {
        let guard = install_before_validate_lock();
        match point {
            ViewInjectionPoint::CompactInstallBeforeValidate => guard.clone(),
            ViewInjectionPoint::CompactWrite => None,
        }
    };
    if let Some(hook) = hook {
        hook(db);
    }
}
