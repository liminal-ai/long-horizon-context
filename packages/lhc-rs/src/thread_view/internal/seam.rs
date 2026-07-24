//! Ported from packages/lhc/src/thread-view/internal/seam.ts.
//!
//! Test injection facility for compact's write path. Production code carries
//! the point as a no-op unless a test installs a hook: "compact-write" fires
//! between the sweep and the view-write transaction.
//! Tests reach the setters through `tests/fixtures/view_seam.rs` (the one
//! directory sanctioned to import below the SDK surface); production code
//! only ever fires.
//!
//! REAL in Phase 1 — the hook table *is* the seam (no deferred behavior).

use std::sync::{Arc, Mutex, MutexGuard};

/// TS `ViewInjectionPoint` — closed literal `"compact-write"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ViewInjectionPoint {
    CompactWrite,
}

impl ViewInjectionPoint {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewInjectionPoint::CompactWrite => "compact-write",
        }
    }
}

/// TS `ViewInjectionHook = () => void`.
///
/// [`Arc`] so [`fire_view_injection`] can clone the hook out of the mutex
/// before invoking it (hook panics must not poison the table lock).
pub type ViewInjectionHook = Arc<dyn Fn() + Send + Sync>;

static HOOKS: Mutex<Option<ViewInjectionHook>> = Mutex::new(None);

fn hooks_lock() -> MutexGuard<'static, Option<ViewInjectionHook>> {
    HOOKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// TS `setViewInjectionHook`.
pub fn set_view_injection_hook(point: ViewInjectionPoint, hook: Option<ViewInjectionHook>) {
    match point {
        ViewInjectionPoint::CompactWrite => {
            *hooks_lock() = hook;
        }
    }
}

/// TS `fireViewInjection` — no-op when nothing is installed. An installed
/// hook's panic propagates to the call site on purpose — that is the injected
/// failure the call site must survive. The hook runs outside the table lock
/// so a panic cannot poison subsequent set/clear/fire calls.
pub fn fire_view_injection(point: ViewInjectionPoint) {
    let hook = match point {
        ViewInjectionPoint::CompactWrite => hooks_lock().clone(),
    };
    if let Some(hook) = hook {
        hook();
    }
}
