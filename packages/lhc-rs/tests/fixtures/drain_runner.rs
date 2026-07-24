//! Ported from packages/lhc/test/fixtures/drain-runner.ts.
//!
//! Spawnable drain runner for the process-boundary suite (TC-1.3 / TC-1.4).
//! Argument: one JSON config — `{ threadPath, leaseMs, holdMs, holdFrom }`.
//!
//! File-private (TS module-local): `RunnerConfig`, `sleep`, `main`.
//! `RunnerConfig` is pure data — REAL. `sleep` is REAL. `main` stays
//! `todo!("phase 2")` until `init_lhc` is callable (still Phase 2 todo in src).

#![allow(dead_code)] // file-private runner; suite invokes via process spawn later

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
async fn sleep(ms: i64) {
    let ms = u64::try_from(ms).unwrap_or(0);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// TS `main` — PARTIAL: process-boundary protocol (stdout markers, exit codes)
/// lands when `init_lhc` is callable. `register_testing_work` / `work.drain`
/// are also still Phase 2 todos; leave main as the clear notimpl gate.
async fn main() {
    todo!("phase 2")
}
