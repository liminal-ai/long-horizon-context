//! Ported from packages/lhc/test/fixtures/view-seam.ts. Phase 1.
//!
//! Epic 03 Story 0 view-domain test seams. Lives in fixtures/ — the one
//! directory sanctioned to reach below the SDK surface (boundary check
//! exempt).
//!
//! The injection facility (FC-0.6): re-export of the thread-view seam so
//! tests install crash/failure hooks at compact's write path between sweep
//! and view write (TC-2.4). Uninstalled, production fires are no-ops.
//!
//! [`seed_view_boundary`] is a sanctioned below-SDK write — REAL (same
//! sanctioning as corrupt.rs).

use std::time::{SystemTime, UNIX_EPOCH};

use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{SqlParam, open_database};

pub use lhc::thread_view::internal::seam::{
    ViewInjectionHook, ViewInjectionPoint, fire_view_injection, set_view_injection_hook,
};

/// ISO-8601 UTC with millisecond precision (`YYYY-MM-DDTHH:MM:SS.mmmZ`),
/// matching JS `Date.toISOString()`.
fn iso_millis_now() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch");
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    // Manual formatting avoids a chrono dep (dev fixtures only).
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400) as u32;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

/// Howard Hinnant civil-from-days (proleptic Gregorian) for UTC dates.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

/// Sanctioned below-SDK write (same sanctioning as corrupt.ts): seeds the
/// view_boundary row to an arbitrary position for mid-tail context reads.
/// UPDATE-only on purpose: thread creation seeded the singleton row.
///
/// SQL verbatim from TS:
///   `UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1`
pub fn seed_view_boundary(file_path: &str, position: i64) {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("seed_view_boundary open failed: {}", error.reason),
    };
    db.prepare("UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1")
        .run(&[
            SqlParam::from(position),
            SqlParam::from(iso_millis_now().as_str()),
        ]);
    let changed = db
        .prepare("SELECT changes() AS n")
        .get()
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    if changed != 1 {
        panic!(
            "fixture seedViewBoundary hit {changed} rows; expected the thread-creation singleton"
        );
    }
    db.close();
}
