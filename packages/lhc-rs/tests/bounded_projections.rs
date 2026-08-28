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
    FRONTIER_LAST_EVENT_SQL, FRONTIER_METADATA_SQL, FRONTIER_VIEW_BOUNDARY_SQL,
    KEY_CURSOR_WITNESS_SQL, KEY_WALK_SNAPSHOT_SQL, page_sql_shapes, prefix_upper_bound,
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

/// "v1:<snapshot>:<traversed>:<lastKey>" — split so a test can tamper with one
/// field of an otherwise authentic, server-issued cursor.
fn cursor_parts(cursor: &str) -> (String, String, String) {
    let mut parts = cursor.splitn(4, ':');
    assert_eq!(parts.next(), Some("v1"), "cursor version");
    let snapshot = parts.next().expect("snapshot field").to_string();
    let traversed = parts.next().expect("traversed field").to_string();
    let last_key = parts.next().expect("key field").to_string();
    (snapshot, traversed, last_key)
}

fn retamper(
    cursor: &str,
    snapshot: Option<&str>,
    traversed: Option<&str>,
    last_key: Option<&str>,
) -> String {
    let (s, t, k) = cursor_parts(cursor);
    format!(
        "v1:{}:{}:{}",
        snapshot.unwrap_or(&s),
        traversed.unwrap_or(&t),
        last_key.unwrap_or(&k)
    )
}

async fn first_page_cursor(file_path: &str) -> String {
    let first = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(file_path),
            page("legacy:", Some(10), None),
        )
        .await,
    );
    first.cursor.expect("a continuation")
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
async fn excludes_keys_appended_mid_walk_earlier_or_later_from_that_snapshot() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let first = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(10), None),
        )
        .await,
    );
    let mut seen: Vec<String> = first
        .keys
        .iter()
        .map(|k| k.idempotency_key.clone())
        .collect();
    let mut cursor = first.cursor.clone().expect("a continuation");

    // One key sorts before the cursor's last returned key (legacy:009) and one
    // sorts after every seeded key: neither may enter this walk, and the
    // earlier one must not be silently skipped over either.
    record(
        &file_path,
        &[keyed_note("legacy:0055"), keyed_note("legacy:900")],
    )
    .await;

    let complete;
    loop {
        let result = unwrap_ok(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page("legacy:", Some(10), Some(cursor.clone())),
            )
            .await,
        );
        seen.extend(result.keys.iter().map(|k| k.idempotency_key.clone()));
        match result.cursor {
            None => {
                complete = result.complete;
                break;
            }
            Some(next) => cursor = next,
        }
    }
    // Exactly the snapshot, in order, with nothing omitted and nothing added.
    let expected: Vec<String> = (0..LEGACY_TOTAL)
        .map(|i| format!("legacy:{i:03}"))
        .collect();
    assert_eq!(seen, expected);
    assert!(complete);

    // The appends are in the archive — they simply belong to a later walk.
    let fresh = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", Some(LEGACY_KEY_PAGE_LIMIT), None),
        )
        .await,
    );
    let fresh_keys: Vec<String> = fresh
        .keys
        .iter()
        .map(|k| k.idempotency_key.clone())
        .collect();
    assert!(fresh.complete);
    assert_eq!(fresh_keys.len(), LEGACY_TOTAL + 2);
    assert!(fresh_keys.contains(&"legacy:0055".to_string()));
    assert!(fresh_keys.contains(&"legacy:900".to_string()));
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
        // Every page is pinned to the walk's snapshot.
        assert!(sql.contains("event_order <= ?"), "{sql}");
    }
    // The cursor witness is indexed, non-payload and bounded by the total
    // lookup cap: it never counts the whole history.
    assert!(!KEY_CURSOR_WITNESS_SQL.contains("payload"));
    assert!(KEY_CURSOR_WITNESS_SQL.contains("LIMIT ?"));
    assert!(!KEY_WALK_SNAPSHOT_SQL.contains("payload"));
    assert!(KEY_WALK_SNAPSHOT_SQL.ends_with("ORDER BY event_order DESC LIMIT 1"));
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
async fn refuses_an_empty_prefix_and_every_malformed_foreign_or_out_of_range_cursor() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(ref_of(&file_path), page("", None, None)).await,
    );
    let over_cap = format!("v1:5:{}:legacy:001", LEGACY_KEY_TOTAL_LOOKUP_CAP + 1);
    for cursor in [
        "",
        "abc",
        // Pre-version grammar and wrong versions.
        "3:legacy:001",
        "1:5:legacy:001",
        "v0:5:1:legacy:001",
        "v2:5:1:legacy:001",
        // Missing fields.
        "v1:legacy:001",
        "v1:5:legacy:001",
        // Non-decimal, signed and exponent forms in either integer field.
        "v1:x:1:legacy:001",
        "v1:5:x:legacy:001",
        "v1:-1:1:legacy:001",
        "v1:5:-1:legacy:001",
        "v1:1e3:1:legacy:001",
        "v1:5:1e3:legacy:001",
        // Traversed outside 1..cap.
        "v1:5:0:legacy:001",
        over_cap.as_str(),
        // First unsafe integer, and an overflowing one, in either field.
        "v1:9007199254740992:1:legacy:001",
        "v1:5:9007199254740992:legacy:001",
        "v1:99999999999999999999:1:legacy:001",
        "v1:5:99999999999999999999:legacy:001",
    ] {
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
            page("legacy:", None, Some("v1:25:3:other:001".into())),
        )
        .await,
    );
    assert!(reason.contains("different prefix"));
    store.cleanup();
}

#[tokio::test]
async fn refuses_a_cursor_whose_last_key_is_absent_from_the_snapshot() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let authentic = first_page_cursor(&file_path).await;
    // Same authentic snapshot and count, a key that was never recorded: the
    // continuation must refuse rather than resume past the missing key.
    let forged = retamper(&authentic, None, None, Some("legacy:250"));
    let reason = expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", None, Some(forged)),
        )
        .await,
    );
    assert!(reason.contains("not in this walk's snapshot"), "{reason}");
    store.cleanup();
}

#[tokio::test]
async fn refuses_a_reset_or_mismatched_traversed_count() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let authentic = first_page_cursor(&file_path).await;
    assert_eq!(cursor_parts(&authentic).1, "10");

    let cap = LEGACY_KEY_TOTAL_LOOKUP_CAP.to_string();
    for traversed in ["0", "1", "9", "11", cap.as_str()] {
        expect_invalid_bounds(
            intake_stream::list_event_keys_by_prefix(
                ref_of(&file_path),
                page(
                    "legacy:",
                    None,
                    Some(retamper(&authentic, None, Some(traversed), None)),
                ),
            )
            .await,
        );
    }

    // The untouched cursor still works, so the refusals are about the count.
    unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("legacy:", None, Some(authentic)),
        )
        .await,
    );
    store.cleanup();
}

#[tokio::test]
async fn refuses_a_cursor_whose_snapshot_the_archive_never_reached() {
    let store = temp_store();
    let file_path = legacy_thread(&store).await;
    let authentic = first_page_cursor(&file_path).await;
    let reason = expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page(
                "legacy:",
                None,
                Some(retamper(&authentic, Some("999999"), None, None)),
            ),
        )
        .await,
    );
    assert!(reason.contains("ahead of the thread frontier"), "{reason}");
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

// ── total lookup cap at its exact boundary ───────────────────────────────
//
// Seeded through the public intake API and walked with none but server-issued
// cursors: the cap is proven by real rows, not by a hand-written count no walk
// could ever have emitted.

async fn seed_cap_keys(file_path: &str, from: i64, to_exclusive: i64) {
    let mut base = from;
    while base < to_exclusive {
        let upper = (base + 250).min(to_exclusive);
        let events: Vec<MessageEventInput> = (base..upper)
            .map(|i| keyed_note(&format!("cap:{i:04}")))
            .collect();
        record(file_path, &events).await;
        base = upper;
    }
}

async fn walk_cap_prefix(file_path: &str) -> (Vec<String>, EventKeyPage) {
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let result = unwrap_ok(
            intake_stream::list_event_keys_by_prefix(
                ref_of(file_path),
                page("cap:", Some(LEGACY_KEY_PAGE_LIMIT), cursor.clone()),
            )
            .await,
        );
        seen.extend(result.keys.iter().map(|k| k.idempotency_key.clone()));
        match result.cursor.clone() {
            None => return (seen, result),
            Some(next) => cursor = Some(next),
        }
    }
}

#[tokio::test]
async fn completes_exactly_at_the_cap_and_degrades_one_row_past_it() {
    let store = temp_store();
    let file_path = fresh_thread(&store, "cap-boundary").await;
    seed_cap_keys(&file_path, 0, LEGACY_KEY_TOTAL_LOOKUP_CAP).await;
    let (seen, exact) = walk_cap_prefix(&file_path).await;
    assert_eq!(seen.len() as i64, LEGACY_KEY_TOTAL_LOOKUP_CAP);
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len() as i64, LEGACY_KEY_TOTAL_LOOKUP_CAP);
    assert!(exact.complete);
    assert!(!exact.cap_exhausted);
    assert_eq!(exact.cursor, None);

    // One more matching row: the walk must stop after the cap and say so.
    seed_cap_keys(
        &file_path,
        LEGACY_KEY_TOTAL_LOOKUP_CAP,
        LEGACY_KEY_TOTAL_LOOKUP_CAP + 1,
    )
    .await;
    let (over_seen, over) = walk_cap_prefix(&file_path).await;
    assert_eq!(over_seen.len() as i64, LEGACY_KEY_TOTAL_LOOKUP_CAP);
    assert!(!over.complete);
    assert!(over.cap_exhausted);
    assert_eq!(over.cursor, None);
    assert!(!over_seen.contains(&format!("cap:{LEGACY_KEY_TOTAL_LOOKUP_CAP:04}")));

    // A cursor pointing past the cap — authentic snapshot, real key, rank
    // 2001 — is refused rather than resumed: no walk may reach that row.
    let first_page = unwrap_ok(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("cap:", Some(LEGACY_KEY_PAGE_LIMIT), None),
        )
        .await,
    );
    let authentic = first_page.cursor.expect("a continuation");
    let beyond_cap = retamper(
        &authentic,
        None,
        None,
        Some(&format!("cap:{LEGACY_KEY_TOTAL_LOOKUP_CAP:04}")),
    );
    let reason = expect_invalid_bounds(
        intake_stream::list_event_keys_by_prefix(
            ref_of(&file_path),
            page("cap:", None, Some(beyond_cap)),
        )
        .await,
    );
    assert!(
        reason.contains("rank exceeds LEGACY_KEY_TOTAL_LOOKUP_CAP"),
        "{reason}"
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
