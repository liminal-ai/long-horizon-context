//! Ported from packages/lhc/test/turn-parts-replay.test.ts.
//!
//! Turn parts — recovery and reproducibility (epic Flow 8: AC-8.2, AC-8.3,
//! AC-8.4) plus the retrieval-across-the-seam and rendered-pricing seams
//! (AC-2.2, AC-1.8b). Parts live only inside the installed snapshot, so
//! "resume" is a fresh SDK reading the file, "crash before install" is a
//! prepare that never installs, and "reproducibility" is the walk re-run on
//! the frozen inputs matching the placement the receipt recorded.
mod fixtures;

use fixtures::turn_parts::{
    closed_turn, compact, context, context_texts, describe, file_ref, host_metadata, new_thread,
    new_thread_named, prepare, prompt, scalar_i64, sdk_for, send, served_json, shares, step,
    tokens_after_step, turn_end,
};
use fixtures::{open_raw, temp_store};
use lhc::Lhc;
use lhc::retrieval::RetrievedTurnSource;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{ReceiptPart, ViewCompactParams};
use lhc::thread_view::{InstallPreparedOptions, install_prepared_compact};
use serde_json::{Value, json};

async fn pressured_thread(sdk: &Lhc, store: &fixtures::TempStore) -> String {
    let file_path = new_thread(sdk, store).await;
    send(sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    send(sdk, &file_path, &events).await;
    file_path
}

fn params(lower_bound: i64) -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(lower_bound as f64),
        percentages: Some(shares(50.0, 20.0, 15.0, 15.0)),
        newest_closed_protection: Some(0.0),
    }
}

fn part(turn_id: &str, from_step: i64, to_step: i64) -> ReceiptPart {
    ReceiptPart {
        turn_id: turn_id.into(),
        from_step,
        to_step,
    }
}

fn decisions(
    parts: &Option<Vec<ReceiptPart>>,
    split_point: &Option<lhc::shared_tech::view::SplitPoint>,
    settled: &Option<lhc::shared_tech::view::SettledTurn>,
    protected: &Option<lhc::shared_tech::view::ProtectedTurn>,
    compact_point: i64,
) -> String {
    json!({
        "parts": parts,
        "splitPoint": split_point,
        "settled": settled,
        "protectedTurn": protected,
        "compactPoint": compact_point,
    })
    .to_string()
}

#[tokio::test]
async fn tc_8_3a_b_a_fresh_process_serves_the_installed_parts_byte_identically_and_the_walk_rerun_reproduces_the_receipts_placement()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let p = params(tokens_after_step(&file_path, "t2", 0) * 2);
    let receipt = compact(&sdk, &file_path, p.clone()).await;
    assert_eq!(receipt.parts, Some(vec![part("t2", 0, 0)]));
    let before = served_json(&file_path).await;

    // Resume: a new SDK instance over the same file — nothing is process-resident.
    let _resumed = sdk_for();
    assert_eq!(served_json(&file_path).await, before);
    let described = describe(&file_path).await;
    assert_eq!(described.view_id, receipt.view_id);

    // Reproducibility: the walk over a frozen copy of the inputs, under the
    // params reconstructed from the receipt alone (the stored view carries the
    // same provenance), makes the same decisions the receipt recorded, in
    // every placement field.
    let c = &receipt.config;
    assert!(c.newest_closed_protection.is_some());
    let from_receipt = ViewCompactParams {
        lower_bound: Some(c.lower_bound),
        percentages: Some(shares(c.full, c.smooth, c.detailed, c.brief)),
        newest_closed_protection: c.newest_closed_protection,
    };
    assert_eq!(from_receipt, p);
    assert_eq!(described.config.lower_bound, c.lower_bound);
    assert_eq!(
        described
            .config
            .percentages
            .iter()
            .map(|(k, v)| (k.as_str(), *v))
            .collect::<Vec<_>>(),
        vec![
            ("full", c.full),
            ("smooth", c.smooth),
            ("detailed", c.detailed),
            ("brief", c.brief)
        ]
    );
    assert_eq!(
        described.config.newest_closed_protection,
        c.newest_closed_protection
    );
    let frozen = new_thread_named(&sdk, &store, Some("frozen")).await;
    std::fs::copy(&file_path, &frozen).expect("copy");
    let rerun = prepare(&frozen, from_receipt).await;
    assert_eq!(
        decisions(
            &rerun.selection.parts,
            &rerun.selection.split_point,
            &rerun.selection.settled,
            &rerun.selection.protected_turn,
            rerun.selection.compact_point
        ),
        decisions(
            &receipt.parts,
            &receipt.split_point,
            &receipt.settled,
            &receipt.protected_turn,
            receipt.compact_point
        )
    );
    assert_eq!(
        rerun
            .bands
            .iter()
            .map(|b| b.rendered_text.clone())
            .collect::<Vec<_>>(),
        receipt
            .rendered_bands
            .iter()
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
    );

    // TC-1.8b: the part is priced by its rendered construction, not by the
    // raw estimates of the messages it covers.
    let part_entry = rerun
        .selection
        .entries
        .iter()
        .find(|e| e.part.is_some())
        .expect("part");
    assert_eq!(part_entry.tokens, estimate_tokens(&part_entry.text));
    let raw = scalar_i64(
        &file_path,
        "SELECT SUM(token_estimate) AS t FROM message WHERE turn_id = 't2' AND step_index = 0",
    );
    assert_ne!(part_entry.tokens, raw);
    store.cleanup();
}

#[tokio::test]
async fn tc_8_2a_a_compact_interrupted_before_install_leaves_the_prior_view_parts_included_serving_exactly_as_before()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let first = compact(
        &sdk,
        &file_path,
        params(tokens_after_step(&file_path, "t2", 0) * 2),
    )
    .await;
    assert_eq!(first.parts.map(|p| p.len()), Some(1));
    let before = served_json(&file_path).await;
    let stored = describe(&file_path).await;

    // More steps, tighter pressure: prepared, never installed.
    let mut more = Vec::new();
    more.extend(step(3, "delta"));
    more.extend(step(4, "echo"));
    send(&sdk, &file_path, &more).await;
    let prepared = prepare(
        &file_path,
        params(tokens_after_step(&file_path, "t2", 2) * 2),
    )
    .await;
    assert_eq!(prepared.selection.parts.as_ref().map(Vec::len), Some(2));

    let after = describe(&file_path).await;
    assert_eq!(
        js_json_stringify(&serde_json::to_value(&after).expect("json")),
        js_json_stringify(&serde_json::to_value(&stored).expect("json"))
    );
    // The tail grew (new canonical steps serve verbatim); the bands, parts, and
    // compact point did not move.
    let is_band = |text: &str| text.starts_with("[context ·");
    let bands_now: Vec<String> = context_texts(&context(&file_path).await)
        .into_iter()
        .filter(|t| is_band(t))
        .collect();
    let before_messages: Vec<Value> = serde_json::from_str(&before).expect("json");
    let bands_before: Vec<String> = before_messages
        .iter()
        .map(|m| {
            m["content"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .map(|p| p["text"].as_str().unwrap_or(""))
                        .collect::<String>()
                })
                .unwrap_or_default()
        })
        .filter(|t| is_band(t))
        .collect();
    assert_eq!(bands_before, bands_now);
    store.cleanup();
}

#[tokio::test]
async fn tc_8_4a_a_turn_that_closes_between_prepare_and_install_is_recomputed_under_newest_closed_protection_never_an_excerpt()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    // Protection off so the frozen prepare splits t2; the excerpt prohibition
    // for the newest closed turn is unconditional. A small full share so
    // that, once closed, t2 is banded rather than left in the tail by Rule
    // 1's straddle rounding.
    let p = ViewCompactParams {
        lower_bound: Some((tokens_after_step(&file_path, "t2", 0) * 2) as f64),
        percentages: Some(shares(10.0, 60.0, 15.0, 15.0)),
        newest_closed_protection: Some(0.0),
    };
    let prepared = prepare(&file_path, p).await;
    assert_eq!(prepared.selection.parts.as_ref().map(Vec::len), Some(1));

    // The turn closes (host reports turn end) before install; nothing drained.
    send(&sdk, &file_path, &[turn_end()]).await;
    let installed = install_prepared_compact(
        file_ref(&file_path),
        prepared,
        InstallPreparedOptions::default(),
    )
    .await;
    let installed = match installed {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(installed.parts, None);
    assert_eq!(
        installed
            .protected_turn
            .as_ref()
            .map(|p| p.turn_id.as_str()),
        Some("t2")
    );
    let described = describe(&file_path).await;
    let t2: Vec<_> = described
        .arrangement
        .iter()
        .filter(|e| e.subject_id == "t2")
        .collect();
    assert!(
        t2.iter()
            .all(|e| e.derivation_used != "message_excerpt" && e.part.is_none())
    );
    if installed.protected_turn.as_ref().map(|p| p.representation)
        == Some(lhc::shared_tech::view::ProtectedRepresentation::Full)
    {
        assert_eq!(t2.len(), 0);
    } else {
        assert_eq!(
            t2.iter()
                .map(|e| e.derivation_used.as_str())
                .collect::<Vec<_>>(),
            vec!["composed_in_walk"]
        );
    }
    assert_eq!(host_metadata(&file_path).await.unsettled_turn, None);
    store.cleanup();
}

#[tokio::test]
async fn tc_2_2a_b_retrieval_through_the_seam_is_exact_any_message_in_a_summarized_step_and_the_whole_split_turn_from_canonical()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let receipt = compact(
        &sdk,
        &file_path,
        params(tokens_after_step(&file_path, "t2", 0) * 2),
    )
    .await;
    assert_eq!(receipt.parts, Some(vec![part("t2", 0, 0)]));
    let db = open_raw(&file_path);
    let row = db
        .prepare(
            "SELECT m.message_id, mb.content FROM message m JOIN message_block mb ON mb.message_id = m.message_id AND mb.block_index = 0 WHERE m.turn_id = 't2' AND m.step_index = 0 AND m.kind = 'tool_result'",
        )
        .get()
        .expect("tool result row");
    db.close();
    let message_id = row["message_id"].as_str().expect("id").to_string();
    let content: Value =
        serde_json::from_str(row["content"].as_str().expect("content")).expect("json");
    let canonical = content["content"].as_str().expect("canonical").to_string();
    let exact = match sdk
        .retrieval
        .get_messages(file_ref(&file_path), &[message_id.clone()], None)
        .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(exact.served[0].message_id, message_id);
    assert!(exact.served[0].text.ends_with(&canonical));
    assert_eq!(exact.served[0].slice, None);
    let whole = match sdk
        .retrieval
        .get_turns(file_ref(&file_path), &["t2".to_string()], None)
        .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let turn = &whole.served[0];
    assert_eq!(turn.source, RetrievedTurnSource::Composed);
    assert!(turn.text.contains("step 0: alpha"));
    assert!(turn.text.contains("step 2: charlie"));
    assert!(!turn.text.contains("[seam ·"));
    let _ = SqlParam::from(0_i64);
    store.cleanup();
}
