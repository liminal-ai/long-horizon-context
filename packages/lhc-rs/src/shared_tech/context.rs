//! Ported from packages/lhc/src/shared-tech/context.ts.
//!
//! Per-SDK-instance delivery seam. Each SDK runs every one of its operations
//! inside run_with_instance_seam, so code reached deep inside — enqueue's poke and
//! open_thread_database's touch — delivers to that SDK's scheduler in background
//! mode or to a no-op in manual mode, isolated from any other SDK in the process.
//!
//! TS uses `AsyncLocalStorage`; Rust counterpart is `tokio::task_local`.

use std::sync::{Arc, Mutex};

use super::derivation::ResolvedSdkConfig;
use super::storage::Db;
use super::view::ResolvedViewConfig;

pub type SchedulerPoke = Box<dyn Fn(&str) + Send + Sync>;
pub type ThreadTouch = Box<dyn Fn(&str, &Db) + Send + Sync>;

type SchedulerPokeFn = Arc<dyn Fn(&str) + Send + Sync>;
type ThreadTouchFn = Arc<dyn Fn(&str, &Db) + Send + Sync>;

/// Per-SDK-instance delivery seam.
pub struct InstanceSeam {
    pub poke: SchedulerPoke,
    pub touch: ThreadTouch,
    /// The instance's resolved view config rides the same seam the poke does, so
    /// a thread-view operation invoked through sdk.* reads this SDK's
    /// profiles/budgets/threshold. Below-SDK direct domain calls find no seam and
    /// fall back to built-in defaults at the consuming site, never here.
    pub view: Option<ResolvedViewConfig>,
    pub config: Option<ResolvedSdkConfig>,
}

tokio::task_local! {
    /// TS `AsyncLocalStorage<InstanceSeam>` — Shared via `Arc` so namespace
    /// carriers can clone the same instance seam without consuming the only
    /// `InstanceSeam`.
    static SEAM_STORE: Option<Arc<InstanceSeam>>;
    /// Touch-suppression flag for [`run_with_thread_touch_suppressed`].
    ///
    /// TS replaces `seam.touch` with a no-op via object spread
    /// (`context.ts:78-89`). Rust's frozen `InstanceSeam` holds `Box`
    /// poke/touch (not `Clone`) inside an `Arc`, so a faithful re-wrap cannot
    /// copy those boxes. The only production caller of `seam.touch` is
    /// [`fire_thread_touch`], so a task-local suppress flag checked there is
    /// observationally equivalent — provided nested
    /// [`run_with_instance_seam`] clears the flag (TS `AsyncLocalStorage.run`
    /// replaces the store; nested seams restore normal touch).
    static TOUCH_SUPPRESSED: bool;
}

// The below-SDK default seam (the former module-global poke/touch slots).
// Public setters still take `Box`; storage is `Arc` so resolve/fire can clone
// under the lock, drop the guard, then invoke (no callback-under-lock deadlock).
static SCHEDULER_POKE: Mutex<Option<SchedulerPokeFn>> = Mutex::new(None);
static THREAD_TOUCH: Mutex<Option<ThreadTouchFn>> = Mutex::new(None);

fn seam_store_get() -> Option<Arc<InstanceSeam>> {
    SEAM_STORE.try_with(|s| s.clone()).ok().flatten()
}

fn touch_suppressed() -> bool {
    TOUCH_SUPPRESSED.try_with(|s| *s).unwrap_or(false)
}

fn clone_scheduler_poke() -> Option<SchedulerPokeFn> {
    SCHEDULER_POKE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .cloned()
}

fn clone_thread_touch() -> Option<ThreadTouchFn> {
    THREAD_TOUCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .cloned()
}

/// Async (phase-review H3): a `tokio::task_local` scope from a sync closure
/// would cover only future *construction*, not polling — TS
/// `AsyncLocalStorage.run(store, asyncFn)` covers the whole async execution,
/// so the operation is a future and the scope wraps its polls.
///
/// Nested under a touch-suppressed scope: clear suppression for this seam
/// (TS replaces the ALS store; the nested seam's own `touch` must deliver).
pub async fn run_with_instance_seam<T>(
    seam: Arc<InstanceSeam>,
    operation: impl Future<Output = T>,
) -> T {
    TOUCH_SUPPRESSED
        .scope(false, SEAM_STORE.scope(Some(seam), operation))
        .await
}

pub fn set_scheduler_poke(poke: Option<SchedulerPoke>) {
    *SCHEDULER_POKE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = poke.map(Arc::from);
}

pub fn set_thread_touch(touch: Option<ThreadTouch>) {
    *THREAD_TOUCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = touch.map(Arc::from);
}

/// The poke target for a context built now: the running SDK's seam if one is
/// in scope, else the below-SDK default (null-safe). Captured onto ctx.poke so
/// the enqueue carries its target rather than reading a shared slot at fire
/// time — except, deliberately, through the default fallback for direct calls.
pub fn resolve_instance_poke() -> SchedulerPoke {
    if let Some(seam) = seam_store_get() {
        Box::new(move |thread_id| (seam.poke)(thread_id))
    } else {
        Box::new(|thread_id| {
            if let Some(poke) = clone_scheduler_poke() {
                poke(thread_id);
            }
        })
    }
}

/// The view config for the operation now running: the SDK seam's resolved
/// config when one is in scope, undefined for direct domain calls (the
/// thread-view surface defaults those itself — see InstanceSeam.view).
pub fn resolve_instance_view_config() -> Option<ResolvedViewConfig> {
    seam_store_get().and_then(|seam| seam.view.clone())
}

pub fn resolve_instance_config() -> Option<ResolvedSdkConfig> {
    seam_store_get().and_then(|seam| seam.config.clone())
}

/// Reads-only operation scope: runs fn under the current seam with the
/// thread-touch announcement suppressed, so a pure read can never schedule a
/// background scheduler's first-touch catch-up drain through open_thread_database
/// calls. Everything else on the seam carries through unchanged; direct domain
/// calls with no seam in scope delegate to below-SDK defaults, minus the touch.
/// Write paths never use this.
/// Async for the same reason as [`run_with_instance_seam`] (phase-review H3).
pub async fn run_with_thread_touch_suppressed<T>(operation: impl Future<Output = T>) -> T {
    let current = seam_store_get();
    match current {
        Some(_seam) => {
            // Seam already in scope: keep it, suppress touch via task-local flag
            // (see TOUCH_SUPPRESSED docs — Box poke/touch are not Clone).
            TOUCH_SUPPRESSED.scope(true, operation).await
        }
        None => {
            let fallback = Arc::new(InstanceSeam {
                poke: Box::new(|thread_id| {
                    if let Some(poke) = clone_scheduler_poke() {
                        poke(thread_id);
                    }
                }),
                touch: Box::new(|_file_path, _db| {}),
                view: None,
                config: None,
            });
            SEAM_STORE
                .scope(Some(fallback), TOUCH_SUPPRESSED.scope(true, operation))
                .await
        }
    }
}

/// Thread-file open announcement: open_thread_database fires this on every open,
/// before any caller transaction begins. Delivers to the SDK seam in scope if
/// any, else the below-SDK default. The background scheduler learns
/// threadId→filePath and runs first-touch catch-up off this seam.
pub fn fire_thread_touch(file_path: &str, db: &Db) {
    if touch_suppressed() {
        return;
    }
    if let Some(seam) = seam_store_get() {
        (seam.touch)(file_path, db);
        return;
    }
    if let Some(touch) = clone_thread_touch() {
        touch(file_path, db);
    }
}
