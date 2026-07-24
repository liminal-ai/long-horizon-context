//! Ported from packages/lhc/src/intake-stream/internal/pipeline.ts.
//!
//! Wave 2 PARTIAL: test seams only. Walk / record bodies land with intake.

use std::sync::{Mutex, OnceLock};

use crate::shared_tech::derivation::Clock;
use crate::shared_tech::storage::Db;

/// Called after each event is processed inside the walk (TS `IntakeWalkHook`).
pub type IntakeWalkHook = Box<dyn Fn(&Db, i64) + Send + Sync>;

fn walk_hook_slot() -> &'static Mutex<Option<IntakeWalkHook>> {
    static SLOT: OnceLock<Mutex<Option<IntakeWalkHook>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn clock_slot() -> &'static Mutex<Option<Clock>> {
    static SLOT: OnceLock<Mutex<Option<Clock>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// TS `setIntakeWalkHook` — REAL test seam (stores module state only).
pub fn set_intake_walk_hook(hook: Option<IntakeWalkHook>) {
    *walk_hook_slot().lock().expect("intake walk hook") = hook;
}

/// TS `setIntakeClock` — REAL test seam (stores module state only).
pub fn set_intake_clock(clock: Option<Clock>) {
    *clock_slot().lock().expect("intake clock") = clock;
}
