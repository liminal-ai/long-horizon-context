mod fixtures;

use fixtures::{DerivedThreadOptions, derived_thread_fixture, open_raw, temp_store};
use lhc::thread_view::read_prepared_source_state;

#[tokio::test]
async fn selected_turn_batches_preserve_the_canonical_digest_above_the_sqlite_ceiling() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let db = open_raw(&fixture.file_path);
    let actual_turn_ids: Vec<String> = db
        .prepare("SELECT turn_id FROM turns ORDER BY turn_id")
        .all(&[])
        .into_iter()
        .map(|row| {
            row.get("turn_id")
                .and_then(|value| value.as_str())
                .expect("turn id")
                .to_string()
        })
        .collect();
    let mut over_limit = actual_turn_ids.clone();
    over_limit.extend((0..33_000).map(|index| format!("zz-dummy-{index:05}")));
    let compact_point = i64::MAX;
    let small = read_prepared_source_state(&db, compact_point, &actual_turn_ids, None);
    let batched = read_prepared_source_state(&db, compact_point, &over_limit, None);
    assert_eq!(batched.tail_digest, small.tail_digest);

    // No-global-reorder mutant: the union arrives from different batches.
    let mut shuffled = over_limit.clone();
    shuffled.reverse();
    assert_eq!(
        read_prepared_source_state(&db, compact_point, &shuffled, None).tail_digest,
        small.tail_digest
    );

    // No-dedup mutant: duplicate IDs cannot duplicate rows in the digest.
    let mut duplicated = over_limit.clone();
    duplicated.extend(actual_turn_ids.clone());
    assert_eq!(
        read_prepared_source_state(&db, compact_point, &duplicated, None).tail_digest,
        small.tail_digest
    );

    // Dropped-batch mutant: omitting a real selected turn remains visible.
    let dropped: Vec<String> = over_limit
        .iter()
        .filter(|turn_id| *turn_id != &actual_turn_ids[0])
        .cloned()
        .collect();
    assert_ne!(
        read_prepared_source_state(&db, compact_point, &dropped, None).tail_digest,
        small.tail_digest
    );
    db.close();
}
