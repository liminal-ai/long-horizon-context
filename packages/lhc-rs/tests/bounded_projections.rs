//! LIM-133: bounded archive projections (Rust parity with
//! packages/lhc/test/bounded-projections.test.ts).
//!
//! list_events stays the explicit full-archive read. thread_frontier,
//! event_key_prefix_counts and list_event_keys_by_prefix are the bounded
//! surfaces: constant or O(caller input) rows, indexed non-payload columns
//! only, and closed contracts for duplicate/overlapping prefixes, invalid
//! caps/cursors and cap exhaustion.

mod fixtures;

use std::path::Path;

use fixtures::{RuntimeNotePayload, temp_store, valid_event_for_kind, valid_runtime_note};
use lhc::intake_stream::internal::pipeline::{
    FRONTIER_LAST_EVENT_SQL, FRONTIER_METADATA_SQL, FRONTIER_VIEW_BOUNDARY_SQL, page_sql_shapes,
    prefix_upper_bound,
};
use lhc::intake_stream::{
    EventKeyPage, EventKeyPageQuery, EventKeyPrefixCount, EventKeyReference, EventKind,
    LEGACY_KEY_PAGE_LIMIT, LEGACY_KEY_TOTAL_LOOKUP_CAP, MessageEventInput,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, threads};

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn keyed_note(key: &str) -> MessageEventInput {
    valid_runtime_note(fixtures::RuntimeNoteOverrides {
        idempotency_key: Some(key.to_string()),
        payload: Some(RuntimeNotePayload {
            text: key.to_string(),
        }),
        ..Default::default()
    })
}

async fn fresh_thread(store: &fixtures::TempStore, name: &str) -> String {
    let file_path = path_str(&store.thread_path(Some(name)));
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(created.is_ok(), "fixture thread creation must succeed");
    file_path
}

async fn record(file_path: &str, events: &[MessageEventInput]) {
    let result =
        intake_stream::message_events(ThreadRef::file_path(file_path.to_string()), events).await;
    assert!(
        result.is_ok(),
        "fixture intake must succeed: {}",
        match &result {
            OpResult::Err { error } => error.reason.clone(),
            OpResult::Ok { .. } => String::new(),
        }
    );
}

fn ref_of(file_path: &str) -> ThreadRef {
    ThreadRef::file_path(file_path.to_string())
}

fn unwrap_ok<T>(result: OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok, got {:?}: {}", error.code, error.reason),
    }
}

fn expect_invalid_bounds<T>(result: OpResult<T>) -> String {
    match result {
        OpResult::Ok { .. } => panic!("expected an invalid_bounds refusal"),
        OpResult::Err { error } => {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::InvalidBounds);
            error.reason
        }
    }
}

// ── thread frontier ──────────────────────────────────────────────────────

#[tokio::test]
async fn frontier_is_constant_row_on_an_empty_archive_and_after_appends() {
    let store = temp_store();
    let file_path = fresh_thread(&store, "frontier").await;

    let empty = unwrap_ok(intake_stream::thread_frontier(ref_of(&file_path)).await);
    assert_eq!(empty.last_event_order, 0);
    assert_eq!(empty.last_recorded_at, None);
    assert_eq!(empty.view_boundary_position, 0);
    assert!(empty.thread_id.starts_with("th_"));
    assert!(!empty.created_at.is_empty());

    record(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    let after = unwrap_ok(intake_stream::thread_frontier(ref_of(&file_path)).await);
    assert_eq!(after.last_event_order, 3);
    assert!(after.last_recorded_at.is_some());
    assert_eq!(after.thread_id, empty.thread_id);
    assert_eq!(after.created_at, empty.created_at);
    store.cleanup();
}

#[tokio::test]
async fn frontier_tracks_the_recorded_event_counter_that_message_events_reports() {
    let store = temp_store();
    let file_path = fresh_thread(&store, "frontier-counter").await;
    let batch = intake_stream::message_events(
        ref_of(&file_path),
        &[keyed_note("counter:a"), keyed_note("counter:b")],
    )
    .await;
    let batch = unwrap_ok(batch);
    let frontier = unwrap_ok(intake_stream::thread_frontier(ref_of(&file_path)).await);
    assert_eq!(
        frontier.last_event_order,
        batch.thread_position.last_event_order
    );
    store.cleanup();
}

#[tokio::test]
async fn frontier_rejects_an_unusable_thread_reference() {
    let result = intake_stream::thread_frontier(ThreadRef::file_path(String::new())).await;
    let OpResult::Err { error } = result else {
        panic!("an empty file path must be refused");
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
}

#[test]
fn frontier_statements_read_no_payload_column() {
    for sql in [
        FRONTIER_METADATA_SQL,
        FRONTIER_LAST_EVENT_SQL,
        FRONTIER_VIEW_BOUNDARY_SQL,
    ] {
        assert!(!sql.contains("payload"), "{sql}");
        assert!(!sql.to_ascii_uppercase().contains("COUNT("), "{sql}");
    }
    assert!(FRONTIER_LAST_EVENT_SQL.ends_with("ORDER BY event_order DESC LIMIT 1"));
}

// ── key prefix existence and count ───────────────────────────────────────

async fn seeded_prefix_thread(store: &fixtures::TempStore) -> String {
    let file_path = fresh_thread(store, "prefixes").await;
    record(
        &file_path,
        &[
            keyed_note("codex:s1:a"),
            keyed_note("codex:s1:b"),
            keyed_note("codex:s2:a"),
            keyed_note("other:x"),
        ],
    )
    .await;
    file_path
}

#[tokio::test]
async fn prefix_counts_return_one_row_per_distinct_prefix_in_first_occurrence_order() {
    let store = temp_store();
    let file_path = seeded_prefix_thread(&store).await;
    let prefixes: Vec<String> = ["codex:s1:", "missing:", "codex:s1:", "codex:"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let counts =
        unwrap_ok(intake_stream::event_key_prefix_counts(ref_of(&file_path), &prefixes).await);
    assert_eq!(
        counts,
        vec![
            EventKeyPrefixCount {
                prefix: "codex:s1:".into(),
                exists: true,
                count: 2
            },
            EventKeyPrefixCount {
                prefix: "missing:".into(),
                exists: false,
                count: 0
            },
            // Overlap is independent: keys under codex:s1: are counted again.
            EventKeyPrefixCount {
                prefix: "codex:".into(),
                exists: true,
                count: 3
            },
        ]
    );
    assert!(counts.len() <= prefixes.len());
    store.cleanup();
}

#[tokio::test]
async fn prefix_counts_return_an_empty_result_for_an_empty_prefix_list() {
    let store = temp_store();
    let file_path = seeded_prefix_thread(&store).await;
    let counts = unwrap_ok(intake_stream::event_key_prefix_counts(ref_of(&file_path), &[]).await);
    assert!(counts.is_empty());
    store.cleanup();
}

#[tokio::test]
async fn prefix_counts_refuse_an_empty_prefix() {
    let store = temp_store();
    let file_path = seeded_prefix_thread(&store).await;
    let prefixes = vec!["codex:".to_string(), String::new()];
    expect_invalid_bounds(
        intake_stream::event_key_prefix_counts(ref_of(&file_path), &prefixes).await,
    );
    store.cleanup();
}

#[tokio::test]
async fn prefix_counts_match_the_exact_boundary_not_a_looser_range() {
    let store = temp_store();
    let file_path = seeded_prefix_thread(&store).await;
    // ';' is the byte immediately after ':' — the upper bound must exclude it.
    record(&file_path, &[keyed_note("codex;z")]).await;
    let counts = unwrap_ok(
        intake_stream::event_key_prefix_counts(ref_of(&file_path), &["codex:".to_string()]).await,
    );
    assert_eq!(counts[0].count, 3);
    store.cleanup();
}

#[tokio::test]
async fn prefix_counts_handle_non_ascii_prefixes_at_the_code_point_boundary() {
    let store = temp_store();
    let file_path = seeded_prefix_thread(&store).await;
    record(
        &file_path,
        &[
            keyed_note("ключ-é:1"),
            keyed_note("ключ-é:2"),
            keyed_note("ключ-ê:1"),
        ],
    )
    .await;
    let counts = unwrap_ok(
        intake_stream::event_key_prefix_counts(ref_of(&file_path), &["ключ-é".to_string()]).await,
    );
    assert_eq!(
        counts,
        vec![EventKeyPrefixCount {
            prefix: "ключ-é".into(),
            exists: true,
            count: 2
        }]
    );
    store.cleanup();
}

#[test]
fn prefix_upper_bound_matches_the_typescript_contract() {
    assert_eq!(prefix_upper_bound("codex:").as_deref(), Some("codex;"));
    assert_eq!(prefix_upper_bound("a").as_deref(), Some("b"));
    // Surrogate gap.
    assert_eq!(prefix_upper_bound("\u{d7ff}").as_deref(), Some("\u{e000}"));
    // Carry past U+10FFFF, then no bound at all.
    assert_eq!(prefix_upper_bound("a\u{10ffff}").as_deref(), Some("b"));
    assert_eq!(prefix_upper_bound("\u{10ffff}"), None);
    assert_eq!(prefix_upper_bound("\u{10ffff}\u{10ffff}"), None);
}

// ── legacy prefix listing ────────────────────────────────────────────────

const LEGACY_TOTAL: usize = 25;

async fn legacy_thread(store: &fixtures::TempStore) -> String {
    let file_path = fresh_thread(store, "legacy").await;
    let events: Vec<MessageEventInput> = (0..LEGACY_TOTAL)
        .map(|i| keyed_note(&format!("legacy:{i:03}")))
        .collect();
    record(&file_path, &events).await;
    file_path
}

fn page(prefix: &str, limit: Option<i64>, cursor: Option<String>) -> EventKeyPageQuery {
    EventKeyPageQuery {
        prefix: prefix.to_string(),
        cursor,
        limit,
    }
}

#[tokio::test]
async fn walks_every_key_exactly_once_in_stable_key_order_across_pages() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let result: EventKeyPage = unwrap_ok(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page("legacy:", Some(7), cursor.clone()),
            )
            .await,
        );
        pages += 1;
        assert!(result.keys.len() <= 7);
        assert!(!result.cap_exhausted);
        seen.extend(result.keys.iter().map(|k| k.idempotency_key.clone()));
        match result.cursor {
            None => {
                assert!(result.complete);
                break;
            }
            Some(next) => {
                assert!(!result.complete);
                cursor = Some(next);
            }
        }
    }
    assert_eq!(pages, 4);
    assert_eq!(seen.len(), LEGACY_TOTAL);
    let mut sorted = seen.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), LEGACY_TOTAL);
    assert_eq!(seen, sorted);
    assert_eq!(seen[0], "legacy:000");
    assert_eq!(seen[LEGACY_TOTAL - 1], "legacy:024");
    store.cleanup();
}

#[tokio::test]
async fn already_returned_rows_stay_stable_when_new_keys_are_appended_mid_walk() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let first = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(10), None),
        )
        .await,
    );
    let first_keys: Vec<String> = first
        .keys
        .iter()
        .map(|k| k.idempotency_key.clone())
        .collect();
    let mut cursor = first.cursor.clone().expect("a continuation");

    record(
        &file_path,
        &[keyed_note("legacy:900"), keyed_note("legacy:901")],
    )
    .await;

    let mut rest: Vec<String> = Vec::new();
    loop {
        let result = unwrap_ok(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page("legacy:", Some(10), Some(cursor.clone())),
            )
            .await,
        );
        rest.extend(result.keys.iter().map(|k| k.idempotency_key.clone()));
        match result.cursor {
            None => break,
            Some(next) => cursor = next,
        }
    }
    // No page repeats an earlier row, and the appended keys land after them.
    assert!(!first_keys.iter().any(|key| rest.contains(key)));
    assert!(rest.contains(&"legacy:900".to_string()));
    assert!(rest.contains(&"legacy:901".to_string()));
    let mut all: Vec<String> = first_keys
        .iter()
        .cloned()
        .chain(rest.iter().cloned())
        .collect();
    let ordered = all.clone();
    all.sort();
    assert_eq!(ordered, all);
    store.cleanup();
}

#[tokio::test]
async fn each_key_carries_its_archive_position_and_never_a_payload() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let result = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:00", Some(3), None),
        )
        .await,
    );
    for entry in &result.keys {
        let EventKeyReference {
            idempotency_key,
            event_order,
        } = entry;
        assert!(idempotency_key.starts_with("legacy:00"));
        assert!(*event_order > 0);
    }
    for sql in page_sql_shapes() {
        assert!(!sql.contains("payload"), "{sql}");
        assert!(sql.contains("LIMIT ?"), "{sql}");
    }
    store.cleanup();
}

#[tokio::test]
async fn refuses_a_limit_above_the_hard_page_cap_instead_of_clamping() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let reason = expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(LEGACY_KEY_PAGE_LIMIT + 1), None),
        )
        .await,
    );
    assert!(reason.contains("LEGACY_KEY_PAGE_LIMIT"));
    store.cleanup();
}

#[tokio::test]
async fn refuses_non_positive_limits() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    for limit in [0, -1] {
        expect_invalid_bounds(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page("legacy:", Some(limit), None),
            )
            .await,
        );
    }
    store.cleanup();
}

#[tokio::test]
async fn refuses_an_empty_prefix_and_a_malformed_or_foreign_cursor() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(ref_of(&file_path), page("", None, None)).await,
    );
    for cursor in ["", "abc", ":legacy:001", "-1:legacy:001", "1e3:legacy:001"] {
        expect_invalid_bounds(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page("legacy:", None, Some(cursor.to_string())),
            )
            .await,
        );
    }
    let reason = expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", None, Some("3:other:001".into())),
        )
        .await,
    );
    assert!(reason.contains("different prefix"));
    store.cleanup();
}

#[tokio::test]
async fn reports_cap_exhaustion_as_a_degraded_result_never_as_complete() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let near_cap = LEGACY_KEY_TOTAL_LOOKUP_CAP - 3;
    let result = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(10), Some(format!("{near_cap}:legacy:000"))),
        )
        .await,
    );
    assert_eq!(result.keys.len(), 3);
    assert!(result.cap_exhausted);
    assert!(!result.complete);
    assert_eq!(result.cursor, None);

    let past = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page(
                "legacy:",
                None,
                Some(format!("{LEGACY_KEY_TOTAL_LOOKUP_CAP}:legacy:000")),
            ),
        )
        .await,
    );
    assert_eq!(
        past,
        EventKeyPage {
            keys: Vec::new(),
            cursor: None,
            complete: false,
            cap_exhausted: true
        }
    );
    store.cleanup();
}

#[tokio::test]
async fn completes_rather_than_exhausting_when_the_prefix_ends_inside_the_cap() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let result = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(LEGACY_KEY_PAGE_LIMIT), None),
        )
        .await,
    );
    assert_eq!(result.keys.len(), LEGACY_TOTAL);
    assert!(result.complete);
    assert!(!result.cap_exhausted);
    assert_eq!(result.cursor, None);
    store.cleanup();
}

#[tokio::test]
async fn returns_an_empty_complete_page_for_a_prefix_with_no_keys() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let result = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(ref_of(&file_path), page("absent:", None, None))
            .await,
    );
    assert_eq!(
        result,
        EventKeyPage {
            keys: Vec::new(),
            cursor: None,
            complete: true,
            cap_exhausted: false
        }
    );
    store.cleanup();
}

#[tokio::test]
async fn list_events_remains_the_full_archive_read() {
    let store = temp_store();
    let file_path = fresh_thread(&store, "full-archive").await;
    let events: Vec<MessageEventInput> =
        (0..12).map(|i| keyed_note(&format!("bulk:{i}"))).collect();
    record(&file_path, &events).await;
    let listed = unwrap_ok(intake_stream::list_events(ref_of(&file_path)).await);
    assert_eq!(listed.len(), 12);
    store.cleanup();
}
