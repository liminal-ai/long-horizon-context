//! Ported from packages/lhc/test/fixtures/drain-runner.ts.
//!
//! Spawnable drain runner for the process-boundary suite (TC-1.3 / TC-1.4).
//! Argument: one JSON config — `{ threadPath, leaseMs, holdMs, holdFrom }`.
//! Helpers other than `process_main` are file-private (TS `RunnerConfig` /
//! `sleep` / `main` are not exported). `process_main` is `pub(crate)` so the
//! auto-discovered `examples/drain_runner.rs` wrapper can call it; fixtures
//! are outside `src`, so it is not a library export.

#![allow(dead_code)] // private helpers; process suites invoke via example spawn

use std::io::{Write, stderr, stdout};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use futures::FutureExt;
use lhc::sdk::{Lhc, init_lhc};
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorResult, OpResult};
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::scheduler::DrainReport;
use lhc::threads::ThreadRef;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::inference_callbacks_double::create_inference_callbacks_double;
use super::work_handlers::{TestHandlerHooks, TestHandlerStartItem, register_test_work_handlers};

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

/// Producer-specific DrainReport value: TS constructs
/// `{ ran, stoppedBecause, remaining }` then appends `claimExpiresAt`.
/// Frozen `DrainReport` field declaration order is unchanged; only this
/// runner's emitted bytes use construction order.
fn drain_report_runtime_value(report: &DrainReport) -> Value {
    let ran = serde_json::to_value(&report.ran).expect("DrainRanEntry to_value");
    let mut map = Map::new();
    map.insert("ran".into(), ran);
    map.insert(
        "stoppedBecause".into(),
        Value::String(report.stopped_because.as_str().to_string()),
    );
    map.insert("remaining".into(), Value::Number(report.remaining.into()));
    if let Some(expires) = &report.claim_expires_at {
        map.insert("claimExpiresAt".into(), Value::String(expires.clone()));
    }
    Value::Object(map)
}

fn error_result_value(error: &ErrorResult) -> Value {
    serde_json::to_value(error).expect("ErrorResult to_value")
}

/// Outer OpResult order: `{ ok, value }` / `{ ok, error }`.
fn op_result_drain_json(result: &OpResult<DrainReport>) -> Value {
    match result {
        OpResult::Ok { value } => {
            let mut map = Map::new();
            map.insert("ok".into(), Value::Bool(true));
            map.insert("value".into(), drain_report_runtime_value(value));
            Value::Object(map)
        }
        OpResult::Err { error } => {
            let mut map = Map::new();
            map.insert("ok".into(), Value::Bool(false));
            map.insert("error".into(), error_result_value(error));
            Value::Object(map)
        }
    }
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn fail_runner(detail: &str) -> i32 {
    let line = format!("drain-runner failed: {detail}\n");
    let _ = stderr().write_all(line.as_bytes());
    let _ = stderr().flush();
    1
}

/// TS `main().catch` writes one stderr line — silence Rust's default panic
/// hook so contained panics do not also emit unlabelled `panicked at` frames.
fn with_silent_panic_hook<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let out = f();
    std::panic::set_hook(prev);
    out
}

/// Process-boundary protocol (stdout markers, exit codes). Returns exit status.
///
/// TS `main().catch(...)`: parse/SDK/registration/drain/stringify failures and
/// Rust panics while polling the inner future all become stderr
/// `drain-runner failed: <detail>` and exit 1. Normal `DRAIN_DONE` uses
/// `report.ok ? 0 : 1`.
async fn run_protocol(args: &[String]) -> i32 {
    let fut = AssertUnwindSafe(run_protocol_inner(args));
    match fut.catch_unwind().await {
        Ok(Ok(code)) => code,
        Ok(Err(detail)) => fail_runner(&detail),
        Err(payload) => fail_runner(&panic_detail(payload)),
    }
}

async fn run_protocol_inner(args: &[String]) -> Result<i32, String> {
    let raw = args
        .first()
        .ok_or_else(|| "drain-runner: missing JSON config argument".to_string())?;
    let config: RunnerConfig =
        serde_json::from_str(raw).map_err(|e| format!("drain-runner: invalid JSON config: {e}"))?;

    let double = create_inference_callbacks_double();
    let sdk: Lhc = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig {
            duration_ms: config.lease_ms,
        }),
        chunk_policy: None,
        view: None,
    });

    let started = Arc::new(AtomicI64::new(0));
    let hold_from = config.hold_from;
    let hold_ms = config.hold_ms;
    let started_hook = Arc::clone(&started);
    let on_handler_start = Arc::new(move |item: TestHandlerStartItem| {
        let started_hook = Arc::clone(&started_hook);
        Box::pin(async move {
            let n = started_hook.fetch_add(1, Ordering::SeqCst) + 1;
            let line = format!("HANDLER_START {n} {}\n", item.work_item_id);
            let _ = stdout().write_all(line.as_bytes());
            let _ = stdout().flush();
            if n >= hold_from {
                sleep(hold_ms).await;
            }
        }) as lhc::shared_tech::derivation::BoxFuture<()>
    });

    register_test_work_handlers(
        &sdk,
        double.to_callbacks(),
        Some(TestHandlerHooks {
            on_handler_start: Some(on_handler_start),
        }),
    );

    let report = sdk
        .work
        .drain(ThreadRef::file_path(&config.thread_path), None)
        .await;
    let report_json = js_json_stringify_of(&op_result_drain_json(&report))
        .map_err(|e| format!("drain report stringify: {e}"))?;
    let line = format!("DRAIN_DONE {report_json}\n");
    let _ = stdout().write_all(line.as_bytes());
    let _ = stdout().flush();
    Ok(if report.is_ok() { 0 } else { 1 })
}

/// Sync process entry — mirrors TS `main().catch(...)`.
///
/// `pub(crate)` for the path-included example crate only (not re-exported
/// from the fixture barrel; not visible on the `lhc` library).
pub(crate) fn process_main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = with_silent_panic_hook(|| {
        let built = std::panic::catch_unwind(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
        });
        let rt = match built {
            Ok(Ok(rt)) => rt,
            Ok(Err(e)) => {
                return fail_runner(&format!("drain-runner runtime: {e}"));
            }
            Err(payload) => {
                return fail_runner(&panic_detail(payload));
            }
        };
        rt.block_on(run_protocol(&args))
    });
    std::process::exit(code);
}
