//! Ported from packages/lhc/src/shared-tech/context.ts. Phase 1 skeleton.
//!
//! Per-SDK-instance delivery seam. Each SDK runs every one of its operations
//! inside run_with_instance_seam, so code reached deep inside — enqueue's poke and
//! open_thread_database's touch — delivers to that SDK's scheduler in background
//! mode or to a no-op in manual mode, isolated from any other SDK in the process.
//!
//! TS uses `AsyncLocalStorage`; Rust counterpart is `tokio::task_local` (declared
//! below). Function bodies land in Phase 2.

use std::sync::Arc;

use super::derivation::ResolvedSdkConfig;
use super::storage::Db;
use super::view::ResolvedViewConfig;

pub type SchedulerPoke = Box<dyn Fn(&str) + Send + Sync>;
pub type ThreadTouch = Box<dyn Fn(&str, &Db) + Send + Sync>;

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
    /// TS `AsyncLocalStorage<InstanceSeam>` — Phase 2 reads/writes this store.
    /// Shared via `Arc` so namespace carriers can clone the same instance seam
    /// without consuming the only `InstanceSeam`.
    static SEAM_STORE: Option<Arc<InstanceSeam>>;
}

pub fn run_with_instance_seam<T>(_seam: Arc<InstanceSeam>, _operation: impl FnOnce() -> T) -> T {
    todo!("phase 2")
}

pub fn set_scheduler_poke(_poke: Option<SchedulerPoke>) {
    todo!("phase 2")
}

pub fn set_thread_touch(_touch: Option<ThreadTouch>) {
    todo!("phase 2")
}

/// The poke target for a context built now: the running SDK's seam if one is
/// in scope, else the below-SDK default (null-safe). Captured onto ctx.poke so
/// the enqueue carries its target rather than reading a shared slot at fire
/// time — except, deliberately, through the default fallback for direct calls.
pub fn resolve_instance_poke() -> SchedulerPoke {
    todo!("phase 2")
}

/// The view config for the operation now running: the SDK seam's resolved
/// config when one is in scope, undefined for direct domain calls (the
/// thread-view surface defaults those itself — see InstanceSeam.view).
pub fn resolve_instance_view_config() -> Option<ResolvedViewConfig> {
    todo!("phase 2")
}

pub fn resolve_instance_config() -> Option<ResolvedSdkConfig> {
    todo!("phase 2")
}

/// Reads-only operation scope: runs fn under the current seam with the
/// thread-touch announcement suppressed, so a pure read can never schedule a
/// background scheduler's first-touch catch-up drain through open_thread_database
/// calls. Everything else on the seam carries through unchanged; direct domain
/// calls with no seam in scope delegate to below-SDK defaults, minus the touch.
/// Write paths never use this.
pub fn run_with_thread_touch_suppressed<T>(_operation: impl FnOnce() -> T) -> T {
    todo!("phase 2")
}

/// Thread-file open announcement: open_thread_database fires this on every open,
/// before any caller transaction begins. Delivers to the SDK seam in scope if
/// any, else the below-SDK default. The background scheduler learns
/// threadId→filePath and runs first-touch catch-up off this seam.
pub fn fire_thread_touch(_file_path: &str, _db: &Db) {
    todo!("phase 2")
}
