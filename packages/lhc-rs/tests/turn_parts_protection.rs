//! Ported from packages/lhc/test/turn-parts-protection.test.ts.
//!
//! Flow 5 — the newest closed turn is protected by placement (AC-5.1, AC-5.2)
//! under the TDQ8 ruling: bound = min(fraction × lower bound, what the active
//! turn's minimum verbatim tail leaves), default fraction 0.6, configured in
//! the profile shape beside the band allocations. No readiness dependency;
//! never an excerpt for the newest closed turn.
mod fixtures;

use fixtures::turn_parts::{
    closed_turn_weighted, compact, describe, drain_to_zero, event, file_ref, fill, new_thread,
    opts, prompt, scalar_i64, sdk_for, send, shares, turn_end, turn_tokens,
};
use fixtures::{create_inference_callbacks_double, open_raw, temp_store};
use lhc::intake_stream::EventKind;
use lhc::shared_tech::derivation::{ChunkPolicyConfig, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{
    ProtectedRepresentation, ProtectedTurn, ReceiptPart, SdkViewConfig, ViewCompactParams,
    ViewProfileOverride,
};
use lhc::{Lhc, init_lhc};
use serde_json::json;

fn protected(turn_id: &str, representation: ProtectedRepresentation) -> Option<ProtectedTurn> {
    Some(ProtectedTurn {
        turn_id: turn_id.into(),
        representation,
    })
}

// Older history well over budget; a large research turn closes last; the
// open turn is empty (agent settled). Nothing drained: no rendering exists.
async fn research_thread(sdk: &Lhc, store: &fixtures::TempStore) -> String {
    let file_path = new_thread(sdk, store).await;
    for i in 1..=6 {
        send(
            sdk,
            &file_path,
            &closed_turn_weighted(&format!("old{i}"), 3),
        )
        .await;
    }
    send(sdk, &file_path, &closed_turn_weighted("research", 40)).await;
    file_path
}

fn slack(receipt: &lhc::shared_tech::view::CompactReceipt) -> i64 {
    receipt
        .rendered_bands
        .iter()
        .map(|b| estimate_tokens(&b.text))
        .max()
        .unwrap_or(0)
}

#[tokio::test]
async fn tc_5_1a_b_fits_the_bound_served_full_readiness_independent_older_turns_compress() {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = research_thread(&sdk, &store).await;
    let research = turn_tokens(&file_path, "t7");
    let lower_bound = (research as f64 / 0.6).ceil() as i64 + 10; // fits 0.6 × lowerBound
    let p = ViewCompactParams {
        lower_bound: Some(lower_bound as f64),
        percentages: Some(shares(20.0, 30.0, 25.0, 25.0)),
        newest_closed_protection: None,
    };
    let receipt = compact(&sdk, &file_path, p).await;
    assert_eq!(
        receipt.protected_turn,
        protected("t7", ProtectedRepresentation::Full)
    );
    // Full = verbatim: the compact point sits before t7 and t7 is not banded.
    let t7_start = scalar_i64(
        &file_path,
        "SELECT MIN(source_event_order) AS o FROM message WHERE turn_id = 't7'",
    );
    assert!(receipt.compact_point < t7_start);
    let described = describe(&file_path).await;
    assert!(!described.arrangement.iter().any(|e| e.subject_id == "t7"));
    assert!(receipt.tail_tokens >= research);
    // Precedence (4): the elders compress as needed — here the protected tail
    // consumes their shares — and the served view stays within the bound.
    assert!(receipt.total_tokens <= lower_bound + slack(&receipt));
    store.cleanup();
}

#[tokio::test]
async fn tc_5_1c_5_2a_over_the_bound_whole_rendering_composed_in_walk_never_an_excerpt() {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = research_thread(&sdk, &store).await;
    let research = turn_tokens(&file_path, "t7");
    // A full share too small for t7 (so Rule 1 bands it), smooth wide enough
    // for the older turns to render (as excerpts: nothing drained), and a
    // fraction too small for t7 to be kept full.
    let p = ViewCompactParams {
        lower_bound: Some((research * 6) as f64),
        percentages: Some(shares(8.0, 42.0, 25.0, 25.0)),
        newest_closed_protection: Some(0.1),
    };
    let overflow = compact(&sdk, &file_path, p.clone()).await;
    assert_eq!(
        overflow.protected_turn,
        protected("t7", ProtectedRepresentation::WholeRendering)
    );
    let described = describe(&file_path).await;
    let t7: Vec<_> = described
        .arrangement
        .iter()
        .filter(|e| e.subject_id == "t7")
        .collect();
    assert_eq!(t7.len(), 1);
    assert_eq!(t7[0].band, lhc::shared_tech::view::Band::Smooth);
    assert_eq!(t7[0].derivation_used, "composed_in_walk");
    assert!(!t7[0].degraded);
    // The prohibition is specific to the newest closed turn: older undrained
    // turns still take the excerpt rung.
    assert!(
        described
            .arrangement
            .iter()
            .any(|e| e.derivation_used == "message_excerpt")
    );

    // With the stored rendering ready, the stored construction is used.
    drain_to_zero(&sdk, &file_path).await;
    let stored = compact(&sdk, &file_path, p).await;
    assert_eq!(
        stored.protected_turn,
        protected("t7", ProtectedRepresentation::WholeRendering)
    );
    let again = describe(&file_path).await;
    assert_eq!(
        again
            .arrangement
            .iter()
            .find(|e| e.subject_id == "t7")
            .map(|e| e.derivation_used.as_str()),
        Some("turn_rendering")
    );
    store.cleanup();
}

#[tokio::test]
async fn precedence_under_a_planned_split_the_whole_active_turn_is_reserved_first() {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = research_thread(&sdk, &store).await;
    // Open turn with two complete stamped steps: a split would keep step 1 in
    // the tail, but keeping t7 full means no split, so the reserve is all of t8.
    send(
        &sdk,
        &file_path,
        &[
            prompt("task"),
            event(
                EventKind::AssistantText,
                json!({"text": "step 0 ".repeat(30), "stepIndex": 0}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": "step 1 ".repeat(60), "stepIndex": 1}),
            ),
        ],
    )
    .await;
    let research = turn_tokens(&file_path, "t7");
    let step1 = scalar_i64(
        &file_path,
        "SELECT token_estimate AS t FROM message WHERE turn_id = 't8' AND step_index = 1",
    );
    // lowerBound leaves less than t7 after the reserve even though
    // fraction × lowerBound alone would admit it.
    let lower_bound = step1 + research / 2;
    assert!(0.6 * lower_bound as f64 > research as f64 * 0.45);
    assert!(lower_bound - turn_tokens(&file_path, "t8") < research);
    let p = ViewCompactParams {
        lower_bound: Some(lower_bound as f64),
        percentages: Some(shares(10.0, 30.0, 30.0, 30.0)),
        newest_closed_protection: None,
    };
    let receipt = compact(&sdk, &file_path, p).await;
    assert_eq!(
        receipt.parts,
        Some(vec![ReceiptPart {
            turn_id: "t8".into(),
            from_step: 0,
            to_step: 0
        }])
    );
    assert_eq!(
        receipt.protected_turn,
        protected("t7", ProtectedRepresentation::WholeRendering)
    );
    store.cleanup();
}

#[tokio::test]
async fn m1_the_served_view_stays_within_the_bound_overrun_cascades_smooth_detailed_brief() {
    // The reviewer's reproduction: 24 chunked elders, protected R = 142,
    // open W = 303 in two complete steps, lowerBound 447 at 25/25/25/25.
    // Before the cascade this served 784 tokens (tail 445 + 72 + 156 + 111).
    let store = temp_store();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: None,
        chunk_policy: Some(ChunkPolicyConfig {
            target_projected_tokens: 30,
            max_projected_tokens: 4400,
        }),
        view: None,
    });
    let file_path = new_thread(&sdk, &store).await;
    for i in 1..=24 {
        send(
            &sdk,
            &file_path,
            &[
                prompt(&format!("elder {i}")),
                event(EventKind::AssistantText, json!({"text": fill(10)})),
                turn_end(),
            ],
        )
        .await;
    }
    send(
        &sdk,
        &file_path,
        &[
            prompt(&fill(12)),
            event(EventKind::AssistantText, json!({"text": fill(130)})),
            turn_end(),
        ],
    )
    .await;
    drain_to_zero(&sdk, &file_path).await;
    send(
        &sdk,
        &file_path,
        &[
            prompt(&fill(23)),
            event(
                EventKind::AssistantText,
                json!({"text": fill(140), "stepIndex": 0}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": fill(140), "stepIndex": 1}),
            ),
        ],
    )
    .await;
    assert_eq!(turn_tokens(&file_path, "t25"), 142);
    assert_eq!(turn_tokens(&file_path, "t26"), 303);
    let p = ViewCompactParams {
        lower_bound: Some(447.0),
        percentages: Some(shares(25.0, 25.0, 25.0, 25.0)),
        newest_closed_protection: None,
    };

    // The elders have material to compress into: closed chunks with ready
    // summaries. The empty bands below are the cascade, not absence.
    let chunks = scalar_i64(
        &file_path,
        "SELECT COUNT(*) AS n FROM chunk WHERE status = 'closed'",
    );
    let summaries = scalar_i64(
        &file_path,
        "SELECT COUNT(*) AS n FROM derivation WHERE subject_kind = 'chunk' AND state = 'ready'",
    );
    assert!(chunks > 0);
    assert!(summaries > 0);

    let receipt = compact(&sdk, &file_path, p).await;
    assert_eq!(
        receipt.protected_turn,
        protected("t25", ProtectedRepresentation::Full)
    );
    assert_eq!(receipt.parts, None);
    assert_eq!(receipt.tail_tokens, 445);
    // Overrun 333 over the full share of 111: smooth (111) and detailed (111)
    // are consumed and stay empty; brief keeps 2 tokens of share and may admit
    // its first entry — the one-entry slack.
    assert_eq!(receipt.bands.smooth.entries, 0);
    assert_eq!(receipt.bands.detailed.entries, 0);
    assert!(receipt.bands.brief.entries <= 1);
    assert!(receipt.total_tokens <= 447 + slack(&receipt));
    assert!(receipt.total_tokens < 784);
    store.cleanup();
}

#[tokio::test]
async fn the_fraction_lives_beside_the_band_allocations_and_is_validated_at_construction_and_at_compact()
 {
    let thrown = std::panic::catch_unwind(|| {
        let _ = init_lhc(SdkConfig {
            inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
            inference: None,
            mode: SdkMode::Manual,
            clock: None,
            guards: None,
            tool_result: None,
            lease: None,
            chunk_policy: None,
            view: Some(SdkViewConfig {
                profiles: Some(vec![ViewProfileOverride {
                    name: "coding".into(),
                    lower_bound: None,
                    percentages: None,
                    newest_closed_protection: Some(1.5),
                }]),
                visibility: None,
                compact_threshold: None,
            }),
        });
    });
    let message = match thrown {
        Ok(()) => panic!("expected a construction throw"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    };
    assert!(
        message.contains("newestClosedProtection must be a fraction from 0 to 1, got 1.5"),
        "{message}"
    );
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = research_thread(&sdk, &store).await;
    let bad = sdk
        .thread_view
        .compact(
            file_ref(&file_path),
            opts(ViewCompactParams {
                lower_bound: Some(1000.0),
                percentages: Some(shares(20.0, 30.0, 25.0, 25.0)),
                newest_closed_protection: Some(-0.2),
            }),
        )
        .await;
    match bad {
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::InvalidViewConfig),
        OpResult::Ok { .. } => panic!("expected invalid_view_config"),
    }
    let _ = open_raw(&file_path).close();
    let _ = SqlParam::from(0_i64);
    store.cleanup();
}
