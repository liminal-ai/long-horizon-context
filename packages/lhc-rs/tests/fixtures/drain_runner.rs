//! Ported from packages/lhc/test/fixtures/drain-runner.ts.
//!
//! Spawnable drain runner for the process-boundary suite (TC-1.3 / TC-1.4).
//! Argument: one JSON config — `{ threadPath, leaseMs, holdMs, holdFrom }`.
//!
//! File-private (TS module-local): `RunnerConfig`, `sleep`, `main`.
//! `RunnerConfig` is pure data — REAL. `sleep` / `main` are `todo!("phase 2")`.
//!
//! Phase 2 `main` needs from src (not yet): init_lhc, Lhc::work.drain, lease
//! config wiring; from fixtures: create_inference_callbacks_double,
//! register_test_work_handlers with on_handler_start hold protocol.

use serde::{Deserialize, Serialize};

/// TS `RunnerConfig` — JSON argv shape (camelCase keys). File-private.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerConfig {
    thread_path: String,
    lease_ms: i64,
    hold_ms: i64,
    /// 1-based handler-start index the hold applies from.
    hold_from: i64,
}

/// TS `function sleep(ms): Promise<void>`.
async fn sleep(_ms: i64) {
    todo!("phase 2")
}

/// TS `main` — PARTIAL: process-boundary protocol (stdout markers, exit codes)
/// lands when `init_lhc` / `register_test_work_handlers` / `work.drain` are real.
async fn main() {
    todo!("phase 2")
}
