//! Ported from packages/lhc/test/threads.test.ts. Phase 1.
//!
//! Flow 1: thread creation, registry, resolution (TC-1.1, 1.2, 1.3, 1.5, 1.6
//! plus lazy-init and read-path-equivalence supplementals). TC-1.4 is owned by
//! Story 2 and lives in tests/intake.rs.

mod fixtures;

use std::fs;
use std::path::PathBuf;

use fixtures::{open_raw, temp_store};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{
    ListThreadsInput, NewThreadInput, ResolveInput, ResolvedThreadPath, ThreadInfo, ThreadRef,
};
use lhc::{TOKEN_ESTIMATOR_ID, threads};
use regex::Regex;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn read_metadata(thread_path: &str) -> (String, String, String) {
    let db = open_raw(thread_path);
    let row = db
        .prepare("SELECT thread_id, created_at, token_estimator FROM thread_metadata")
        .get()
        .expect("metadata row");
    let thread_id = row
        .get("thread_id")
        .and_then(|v| v.as_str())
        .expect("thread_id")
        .to_string();
    let created_at = row
        .get("created_at")
        .and_then(|v| v.as_str())
        .expect("created_at")
        .to_string();
    let token_estimator = row
        .get("token_estimator")
        .and_then(|v| v.as_str())
        .expect("token_estimator")
        .to_string();
    db.close();
    (thread_id, created_at, token_estimator)
}

fn registry_rows(registry_path: &str) -> Vec<(String, String, Option<String>, String)> {
    let db = open_raw(registry_path);
    let rows = db
        .prepare(
            "SELECT thread_id, file_path, title, created_at FROM threads ORDER BY created_at, thread_id",
        )
        .all(&[]);
    let out = rows
        .into_iter()
        .map(|row| {
            let thread_id = row
                .get("thread_id")
                .and_then(|v| v.as_str())
                .expect("thread_id")
                .to_string();
            let file_path = row
                .get("file_path")
                .and_then(|v| v.as_str())
                .expect("file_path")
                .to_string();
            let title = match row.get("title") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(s)) => Some(s.clone()),
                other => panic!("title column: {other:?}"),
            };
            let created_at = row
                .get("created_at")
                .and_then(|v| v.as_str())
                .expect("created_at")
                .to_string();
            (thread_id, file_path, title, created_at)
        })
        .collect();
    db.close();
    out
}

/// TS: `new Date(metadata.created_at).toISOString() === metadata.created_at`
///
/// Calendar-valid parse + round-trip (test-only; no chrono in production).
fn assert_iso8601_ms_z(created_at: &str) {
    assert!(
        iso8601_ms_z_round_trips(created_at),
        "created_at must round-trip like Date.toISOString(): {created_at}"
    );
}

fn iso8601_ms_z_round_trips(s: &str) -> bool {
    match parse_iso8601_ms_z(s) {
        Some(parts) => format_iso8601_ms_z(parts) == s,
        None => false,
    }
}

#[derive(Clone, Copy)]
struct IsoParts {
    year: u32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millis: u32,
}

fn parse_iso8601_ms_z(s: &str) -> Option<IsoParts> {
    // YYYY-MM-DDTHH:mm:ss.sssZ
    let re = Regex::new(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$").unwrap();
    let caps = re.captures(s)?;
    let year: u32 = caps.get(1)?.as_str().parse().ok()?;
    let month: u32 = caps.get(2)?.as_str().parse().ok()?;
    let day: u32 = caps.get(3)?.as_str().parse().ok()?;
    let hour: u32 = caps.get(4)?.as_str().parse().ok()?;
    let minute: u32 = caps.get(5)?.as_str().parse().ok()?;
    let second: u32 = caps.get(6)?.as_str().parse().ok()?;
    let millis: u32 = caps.get(7)?.as_str().parse().ok()?;
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 || millis > 999 {
        return None;
    }
    let max_day = days_in_month(year, month)?;
    if !(1..=max_day).contains(&day) {
        return None;
    }
    Some(IsoParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millis,
    })
}

fn days_in_month(year: u32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if is_leap_year(year) { 29 } else { 28 }),
        _ => None,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn format_iso8601_ms_z(p: IsoParts) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        p.year, p.month, p.day, p.hour, p.minute, p.second, p.millis
    )
}

#[tokio::test]
async fn tc_1_1_create_at_a_fresh_path_file_metadata_row_registry_row() {
    let store = temp_store();
    let thread_path = path_str(&store.thread_path(None));
    let result = threads::new_thread(NewThreadInput {
        file_path: thread_path.clone(),
        title: Some("first thread".into()),
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;

    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert_eq!(value.file_path, thread_path);
    let id_re = Regex::new(r"^th_[a-z0-9]+$").unwrap();
    assert!(id_re.is_match(&value.thread_id));
    assert!(fs::metadata(&thread_path).is_ok());

    // AC-1.3: the id reads back from the file alone, no registry involved.
    let (meta_id, created_at, token_estimator) = read_metadata(&thread_path);
    assert_eq!(meta_id, value.thread_id);
    assert_eq!(token_estimator, TOKEN_ESTIMATOR_ID);
    assert_iso8601_ms_z(&created_at);

    let rows = registry_rows(&path_str(&store.registry_path));
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0],
        (
            value.thread_id,
            thread_path,
            Some("first thread".into()),
            created_at
        )
    );
    store.cleanup();
}

#[tokio::test]
async fn tc_1_2_occupied_path_refused_file_untouched_registry_unchanged() {
    let store = temp_store();
    let first = threads::new_thread(NewThreadInput {
        file_path: path_str(&store.thread_path(None)),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(first.is_ok());

    let occupied = store.dir.join("occupied.bin");
    let original_bytes = "pre-existing content that must survive";
    fs::write(&occupied, original_bytes).unwrap();

    let result = threads::new_thread(NewThreadInput {
        file_path: path_str(&occupied),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.code, ErrorCode::PathExists);
        assert_eq!(error.error_class, ErrorClass::CallerError);
    }

    assert_eq!(fs::read_to_string(&occupied).unwrap(), original_bytes);
    assert_eq!(registry_rows(&path_str(&store.registry_path)).len(), 1);
    store.cleanup();
}

#[tokio::test]
async fn tc_1_3_resolve_known_id_returns_path_and_metadata_unknown_id_fails_thread_not_found() {
    let store = temp_store();
    let thread_path = path_str(&store.thread_path(None));
    let created = threads::new_thread(NewThreadInput {
        file_path: thread_path.clone(),
        title: Some("resolvable".into()),
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok());
    let OpResult::Ok { value: created } = created else {
        return;
    };

    let known = threads::resolve(ResolveInput {
        thread_id: created.thread_id.clone(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(known.is_ok());
    if let OpResult::Ok { value } = &known {
        assert_eq!(value.thread_id, created.thread_id);
        assert_eq!(value.file_path, thread_path);
        assert_eq!(value.title.as_deref(), Some("resolvable"));
        assert_eq!(value.created_at, read_metadata(&thread_path).1);
    }

    let unknown = threads::resolve(ResolveInput {
        thread_id: "th_does_not_exist".into(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(!unknown.is_ok());
    if let OpResult::Err { error } = unknown {
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
        assert_eq!(error.error_class, ErrorClass::CallerError);
    }
    store.cleanup();
}

#[tokio::test]
async fn tc_1_5_listing_returns_all_rows_absent_registry_lists_empty_without_creating_a_file() {
    let store = temp_store();
    let mut created: Vec<(String, String)> = Vec::new();
    for title in ["one", "two", "three"] {
        let result = threads::new_thread(NewThreadInput {
            file_path: path_str(&store.thread_path(Some(title))),
            title: Some(title.into()),
            cwd: None,
            registry_path: Some(path_str(&store.registry_path)),
        })
        .await;
        assert!(result.is_ok());
        if let OpResult::Ok { value } = result {
            created.push((value.thread_id, value.file_path));
        }
    }

    let listed = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = &listed {
        assert_eq!(value.len(), 3);
        let by_id: std::collections::HashMap<&str, &ThreadInfo> = value
            .iter()
            .map(|info| (info.thread_id.as_str(), info))
            .collect();
        for (index, title) in ["one", "two", "three"].iter().enumerate() {
            let info = by_id.get(created[index].0.as_str());
            assert!(info.is_some());
            let info = info.unwrap();
            assert_eq!(info.file_path, created[index].1);
            assert_eq!(info.title.as_deref(), Some(*title));
            assert!(!info.created_at.is_empty());
        }
    }

    let absent_path = path_str(&store.dir.join("never-written.sqlite"));
    let empty = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(absent_path.clone()),
    }))
    .await;
    assert!(empty.is_ok());
    if let OpResult::Ok { value } = empty {
        assert!(value.is_empty());
    }
    assert!(!PathBuf::from(&absent_path).exists());
    store.cleanup();
}

#[tokio::test]
async fn tc_1_6_registry_insert_failure_compensates_thread_file_deleted_no_registry_no_orphan_row()
{
    let store = temp_store();
    let blocker = store.dir.join("blocker");
    fs::write(&blocker, "a regular file where a directory must be").unwrap();
    let bad_registry = path_str(&blocker.join("registry.sqlite"));

    let thread_path = path_str(&store.thread_path(None));
    let result = threads::new_thread(NewThreadInput {
        file_path: thread_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(bad_registry.clone()),
    })
    .await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.error_class, ErrorClass::SystemError);
        assert_eq!(error.code, ErrorCode::StorageFailure);
    }

    assert!(!PathBuf::from(&thread_path).exists());
    assert!(!PathBuf::from(&bad_registry).exists());
    assert_eq!(
        fs::read_to_string(&blocker).unwrap(),
        "a regular file where a directory must be"
    );
    store.cleanup();
}

#[tokio::test]
async fn lazy_init_supplemental_resolve_against_an_absent_registry_returns_thread_not_found_and_creates_nothing()
 {
    let store = temp_store();
    let absent_path = path_str(&store.dir.join("absent-registry.sqlite"));
    let result = threads::resolve(ResolveInput {
        thread_id: "th_anything".into(),
        registry_path: Some(absent_path.clone()),
    })
    .await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
    }
    assert!(!PathBuf::from(&absent_path).exists());
    store.cleanup();
}

#[tokio::test]
async fn read_path_equivalence_resolve_thread_ref_lands_id_and_path_references_on_the_same_file() {
    let store = temp_store();
    let thread_path = path_str(&store.thread_path(None));
    let created = threads::new_thread(NewThreadInput {
        file_path: thread_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok());
    let OpResult::Ok { value: created } = created else {
        return;
    };

    let by_id = threads::resolve_thread_ref(ThreadRef::Id(lhc::threads::ThreadRefId {
        thread_id: created.thread_id.clone(),
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    let by_path = threads::resolve_thread_ref(ThreadRef::file_path(thread_path.clone())).await;
    assert!(by_id.is_ok());
    assert!(by_path.is_ok());
    if let (OpResult::Ok { value: id_val }, OpResult::Ok { value: path_val }) = (&by_id, &by_path) {
        let ResolvedThreadPath { file_path: id_path } = id_val;
        let ResolvedThreadPath {
            file_path: path_path,
        } = path_val;
        assert_eq!(id_path, &thread_path);
        assert_eq!(path_path, &thread_path);

        // Both reads reach the same thread: identical metadata through either ref.
        assert_eq!(read_metadata(id_path).0, created.thread_id);
        assert_eq!(read_metadata(path_path).0, created.thread_id);
    }

    let unknown = threads::resolve_thread_ref(ThreadRef::Id(lhc::threads::ThreadRefId {
        thread_id: "th_unknown".into(),
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(!unknown.is_ok());
    if let OpResult::Err { error } = unknown {
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
    }
    store.cleanup();
}
