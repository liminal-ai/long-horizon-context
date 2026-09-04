mod fixtures;

use std::path::Path;
use std::time::Instant;

use fixtures::{
    DerivedThreadOptions, derived_thread_fixture, open_raw, poison_message_block_json, temp_store,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::persist::DbReadTransaction;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, ViewCompactParams, ViewProfilePercentages,
};
use lhc::thread_view::internal::bounded_source::create_bounded_selection;
use lhc::thread_view::internal::select::SelectionConfig;
use lhc::thread_view::internal::walk::walk_arrangement;
use lhc::thread_view::{
    CompactOpts, InstallPreparedOptions, compact, describe, install_prepared_compact,
    prepare_compact,
};
use lhc::threads::ThreadRef;

static ALGORITHM_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PINNED_CREATED_AT: &str = "2026-08-23T12:34:56.789Z";

fn params(lower_bound: f64, full: f64, smooth: f64, detailed: f64, brief: f64) -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(lower_bound),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(full),
                smooth: Some(smooth),
                detailed: Some(detailed),
                brief: Some(brief),
            }),
            newest_closed_protection: None,
        }),
        signal: None,
        compact_point_upper_bound: None,
    }
}

fn select_algorithm(legacy: bool) {
    // SAFETY: every mutation in this test binary is serialized by ALGORITHM_ENV.
    unsafe {
        if legacy {
            std::env::set_var("LHC_COMPACT_ALGORITHM", "legacy");
        } else {
            std::env::remove_var("LHC_COMPACT_ALGORITHM");
        }
    }
}

fn file_ref(path: &Path) -> ThreadRef {
    ThreadRef::file_path(path.to_string_lossy().into_owned())
}

#[tokio::test]
async fn frozen_legacy_and_bounded_prepare_install_match_with_created_at_pinned() {
    let _guard = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let legacy_path = store.thread_path(Some("frozen-legacy"));
    let bounded_path = store.thread_path(Some("frozen-bounded"));
    std::fs::copy(&fixture.file_path, &legacy_path).expect("freeze legacy copy");
    std::fs::copy(&fixture.file_path, &bounded_path).expect("freeze bounded copy");
    let opts = params(900.0, 20.0, 15.0, 5.0, 60.0);

    select_algorithm(true);
    let OpResult::Ok {
        value: legacy_prepared,
    } = prepare_compact(file_ref(&legacy_path), opts.clone()).await
    else {
        panic!("legacy prepare failed");
    };
    let OpResult::Ok {
        value: legacy_receipt,
    } = install_prepared_compact(
        file_ref(&legacy_path),
        legacy_prepared.clone(),
        InstallPreparedOptions {
            created_at: Some(PINNED_CREATED_AT.into()),
            ..Default::default()
        },
    )
    .await
    else {
        panic!("legacy install failed");
    };

    select_algorithm(false);
    let OpResult::Ok {
        value: bounded_prepared,
    } = prepare_compact(file_ref(&bounded_path), opts).await
    else {
        panic!("bounded prepare failed");
    };
    let OpResult::Ok {
        value: bounded_receipt,
    } = install_prepared_compact(
        file_ref(&bounded_path),
        bounded_prepared.clone(),
        InstallPreparedOptions {
            created_at: Some(PINNED_CREATED_AT.into()),
            ..Default::default()
        },
    )
    .await
    else {
        panic!("bounded install failed");
    };

    assert_eq!(bounded_prepared, legacy_prepared);
    assert_eq!(bounded_receipt, legacy_receipt);
    assert_eq!(
        describe(file_ref(&bounded_path)).await,
        describe(file_ref(&legacy_path)).await
    );
    select_algorithm(false);
}

#[tokio::test]
async fn poison_on_an_unvisited_historical_block_is_bounded_but_selected_poison_is_visible() {
    let _guard = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let db = open_raw(&fixture.file_path);
    let historical = db
        .prepare("SELECT message_id FROM message WHERE turn_id = 't1' ORDER BY source_event_order LIMIT 1")
        .get()
        .and_then(|row| row.get("message_id").and_then(|value| value.as_str()).map(str::to_string))
        .expect("historical message");
    db.close();
    let selected_path = store.thread_path(Some("poison-selected"));
    std::fs::copy(&fixture.file_path, &selected_path).expect("selected poison copy");
    poison_message_block_json(&fixture.file_path, &historical);
    let legacy_path = store.thread_path(Some("poison-legacy"));
    let bounded_path = store.thread_path(Some("poison-bounded"));
    std::fs::copy(&fixture.file_path, &legacy_path).expect("legacy poison copy");
    std::fs::copy(&fixture.file_path, &bounded_path).expect("bounded poison copy");
    let tail_only = params(400.0, 50.0, 50.0, 0.0, 0.0);

    select_algorithm(false);
    assert!(
        compact(file_ref(&bounded_path), tail_only.clone())
            .await
            .is_ok()
    );
    select_algorithm(true);
    let legacy = compact(file_ref(&legacy_path), tail_only).await;
    assert!(!legacy.is_ok());

    // Force the selected smooth rung to hydrate raw messages, then poison one
    // of those selected rows. The bounded plan must surface the malformed JSON.
    let selected_db = open_raw(&selected_path);
    selected_db
        .prepare(
            "DELETE FROM derivation WHERE subject_kind = 'turn'
             AND derivation_type IN ('turn_rendering', 'detailed_turn_compression')",
        )
        .run(&[]);
    let transaction = DbReadTransaction {
        db: &selected_db,
        thread_id: "poison-selected".into(),
        file_path: selected_path.to_string_lossy().into_owned(),
    };
    let mut plan = create_bounded_selection(&selected_db, &transaction, true, None);
    let selection = walk_arrangement(
        &mut plan.source,
        &SelectionConfig {
            lower_bound: 900.0,
            percentages: ViewProfilePercentages {
                full: 20.0,
                smooth: 15.0,
                detailed: 5.0,
                brief: 60.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: None,
        },
    )
    .expect("selection");
    let selected_turn = selection
        .entries
        .iter()
        .find(|entry| entry.band.as_str() == "smooth")
        .map(|entry| entry.subject_id.clone())
        .expect("selected smooth turn");
    let selected_message = selected_db
        .prepare(
            "SELECT message_id FROM message WHERE turn_id = ? ORDER BY source_event_order LIMIT 1",
        )
        .get_params(&[SqlParam::from(selected_turn.as_str())])
        .and_then(|row| {
            row.get("message_id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .expect("selected message");
    drop(plan);
    drop(transaction);
    selected_db.close();
    poison_message_block_json(selected_path.to_str().expect("path"), &selected_message);
    select_algorithm(false);
    assert!(
        !compact(
            file_ref(&selected_path),
            params(900.0, 20.0, 15.0, 5.0, 60.0),
        )
        .await
        .is_ok()
    );
    select_algorithm(false);
}

#[tokio::test]
async fn mature_fixture_reports_bounded_content_work_shape() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let db = open_raw(&fixture.file_path);
    db.exec("BEGIN");
    let insert_event = db.prepare(
        "INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, 'assistant_text', ?, 'mature', 'mature', '{}', '2026-08-23T00:00:00.000Z')",
    );
    let insert_turn = db.prepare(
        "INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order)
         VALUES (?, ?, 'closed', ?, ?)",
    );
    let insert_message = db.prepare(
        "INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
         VALUES (?, ?, 'assistant_text', 10, 'mature', 'mature', ?)",
    );
    let insert_block = db.prepare(
        "INSERT INTO message_block (message_id, block_index, block_type, content)
         VALUES (?, 0, 'text', '{\"text\":\"mature raw payload\"}')",
    );
    let insert_derivation = db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
         VALUES ('turn', ?, 'turn_rendering', 'ready', 'mature rendering')",
    );
    for index in 0_i64..5_000 {
        let order = 10_000 + index;
        let turn_id = format!("mature-t-{index:05}");
        let message_id = format!("mature-m-{index:05}");
        let key = format!("mature-e-{index:05}");
        insert_event.run(&[SqlParam::from(order), SqlParam::from(key.as_str())]);
        insert_turn.run(&[
            SqlParam::from(turn_id.as_str()),
            SqlParam::from(10_000 + index),
            SqlParam::from(order),
            SqlParam::from(order),
        ]);
        insert_message.run(&[
            SqlParam::from(message_id.as_str()),
            SqlParam::from(order),
            SqlParam::from(turn_id.as_str()),
        ]);
        insert_block.run(&[SqlParam::from(message_id.as_str())]);
        insert_derivation.run(&[SqlParam::from(turn_id.as_str())]);
    }
    db.exec("COMMIT");
    let transaction = DbReadTransaction {
        db: &db,
        thread_id: "mature".into(),
        file_path: fixture.file_path.clone(),
    };
    let started = Instant::now();
    let mut plan = create_bounded_selection(&db, &transaction, true, None);
    let selection = walk_arrangement(
        &mut plan.source,
        &SelectionConfig {
            lower_bound: 10_000.0,
            percentages: ViewProfilePercentages {
                full: 20.0,
                smooth: 15.0,
                detailed: 5.0,
                brief: 60.0,
            },
            newest_closed_protection: None,
            compact_point_upper_bound: None,
        },
    )
    .expect("mature selection");
    let elapsed = started.elapsed();
    let stats = plan.source.stats.clone();
    eprintln!(
        "mature-load turns=5012 selected_entries={} hydrated_block_rows={} excerpt_hydrations={} derivation_content_reads={} compact_point_rows={} queries={} wall_ms={}",
        selection.entries.len(),
        stats.message_block_rows_read,
        stats.turn_excerpt_hydrations,
        stats.derivation_content_reads,
        stats.compact_point_rows_scanned,
        stats.queries,
        elapsed.as_millis(),
    );
    assert_eq!(stats.message_block_rows_read, 0);
    assert_eq!(stats.turn_excerpt_hydrations, 0);
    assert_eq!(stats.chunk_material_resolutions, 0);
    assert!(stats.derivation_content_reads <= selection.entries.len() + 1);
    assert!(stats.compact_point_rows_scanned < 5_012);
    // Turn parts: on a clean thread the bounded plan recomposes each smooth
    // turn whose stored rendering is ready (one counted construction per such
    // entry, F1 cap) and reads the installed transition once — bounded by the
    // smooth band's entry count, never by conversation length.
    let smooth_entries = selection
        .entries
        .iter()
        .filter(|entry| entry.band == lhc::shared_tech::view::Band::Smooth)
        .count();
    assert!(stats.queries < 600 + smooth_entries);
    drop(plan);
    drop(transaction);
    db.close();
}
