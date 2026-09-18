//! Serving-model budgets change without rewriting raw o200k evidence.
mod fixtures;

use fixtures::{
    DerivedThreadOptions, create_inference_callbacks_double, derived_thread_fixture, open_raw,
    temp_store,
};
use lhc::shared_tech::derivation::SdkMode;
use lhc::shared_tech::view::{PartialViewProfilePercentages, ViewCompactParams};
use lhc::thread_view::CompactOpts;
use lhc::{Lhc, OpResult, SdkConfig, SdkViewConfig, ThreadRef, init_lhc_for_model};

fn ok<T: std::fmt::Debug>(result: OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{error:?}"),
    }
}
fn sdk(model: &str, threshold: f64) -> Lhc {
    init_lhc_for_model(
        SdkConfig {
            inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
            inference: None,
            mode: SdkMode::Manual,
            clock: None,
            guards: None,
            tool_result: None,
            lease: None,
            chunk_policy: None,
            view: Some(SdkViewConfig {
                profiles: None,
                visibility: None,
                compact_threshold: Some(threshold),
            }),
        },
        model,
    )
}
fn weigh(raw: i64) -> i64 {
    (raw * 21 + 19) / 20
}
fn rows(path: &str) -> serde_json::Value {
    let db = open_raw(path);
    serde_json::json!({
        "messages": db.prepare("SELECT * FROM message ORDER BY message_id").all(&[]),
        "events": db.prepare("SELECT * FROM event ORDER BY event_order").all(&[]),
        "derivations": db.prepare("SELECT * FROM derivation ORDER BY subject_id, derivation_type").all(&[]),
        "bands": db.prepare("SELECT * FROM thread_view_band ORDER BY band").all(&[]),
    })
}
fn compact_options() -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(1000.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(20.0),
                smooth: Some(15.0),
                detailed: Some(5.0),
                brief: Some(60.0),
            }),
            newest_closed_protection: None,
        }),
        signal: None,
        compact_point_upper_bound: None,
    }
}

#[tokio::test]
async fn model_switch_and_reopen_change_threshold_without_rewriting_raw_rows() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let reference = ThreadRef::file_path(fixture.file_path.clone());
    let raw_status = ok(fixture.sdk.thread_view.status(reference.clone()).await);
    let threshold = raw_status.tail_tokens as f64 + 1.0;
    let openai = sdk("gpt-5.5", threshold);
    let grok = sdk("grok-4.6", threshold);
    let before = rows(&fixture.file_path);
    let original = ok(openai.thread_view.status(reference.clone()).await);
    let weighted = ok(grok.thread_view.status(reference.clone()).await);
    assert!(!original.compact_recommended);
    assert!(weighted.compact_recommended);
    assert_eq!(weighted.tail_tokens, weigh(original.tail_tokens));
    assert_eq!(
        weighted.visibility.zone_tokens,
        weigh(original.visibility.zone_tokens)
    );
    grok.set_model("unknown");
    assert_eq!(
        ok(grok.thread_view.status(reference.clone()).await),
        original
    );
    grok.set_model("grok-4.3"); // Approved TS prefix mapping, including 4.3.
    let (again, independent) = tokio::join!(
        grok.thread_view.status(reference.clone()),
        openai.thread_view.status(reference.clone())
    );
    assert_eq!(ok(again), weighted);
    assert_eq!(ok(independent), original);
    drop(grok);
    let reopened = sdk("grok-4.6", threshold);
    assert_eq!(ok(reopened.thread_view.status(reference).await), weighted);
    assert_eq!(rows(&fixture.file_path), before);
}

#[tokio::test]
async fn compact_weights_derived_renderings_once_and_stores_raw_band_counts() {
    let store = temp_store();
    let fixture = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let reference = ThreadRef::file_path(fixture.file_path.clone());
    fixture.sdk.set_model("grok-4.6");
    let before = rows(&fixture.file_path);
    let receipt = ok(fixture
        .sdk
        .thread_view
        .compact(reference.clone(), compact_options())
        .await);
    assert!(
        receipt.tail_tokens <= 200,
        "weighted full-tail target: {}",
        receipt.tail_tokens
    );
    let db = open_raw(&fixture.file_path);
    let bands = db
        .prepare("SELECT band, rendered_text, token_count FROM thread_view_band")
        .all(&[]);
    assert!(
        !bands.is_empty(),
        "fixture exercises derived/chunk renderings"
    );
    for band in &bands {
        let raw = lhc::estimate_tokens(band["rendered_text"].as_str().unwrap());
        assert_eq!(band["token_count"], raw);
        let counted = match band["band"].as_str().unwrap() {
            "brief" => receipt.bands.brief.tokens,
            "detailed" => receipt.bands.detailed.tokens,
            "smooth" => receipt.bands.smooth.tokens,
            other => panic!("unexpected band {other}"),
        };
        assert_eq!(counted, weigh(raw));
    }
    let after = rows(&fixture.file_path);
    assert_eq!(after["messages"], before["messages"]);
    assert_eq!(after["events"], before["events"]);
    assert_eq!(after["derivations"], before["derivations"]);
    let grok_view = ok(fixture.sdk.inspect.view(reference.clone()).await);
    let context = ok(fixture
        .sdk
        .thread_view
        .get_llm_request_context(reference.clone())
        .await);
    let measured: i64 = context
        .messages
        .iter()
        .map(|message| {
            let text: String = message
                .content
                .iter()
                .map(|part| part.text.as_str())
                .collect();
            weigh(lhc::estimate_tokens(&text))
        })
        .sum();
    assert_eq!(grok_view.load_cost.total, measured);
    fixture.sdk.set_model("o200k");
    let raw_view = ok(fixture.sdk.inspect.view(reference.clone()).await);
    assert!(grok_view.load_cost.total > raw_view.load_cost.total);
    assert_eq!(rows(&fixture.file_path), after);
}

#[tokio::test]
async fn grok_capture_keeps_raw_estimates_and_token_windows() {
    use fixtures::{UserPromptOverrides, UserPromptPayload, kind, valid_event};
    let store = temp_store();
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let model = sdk("grok-4.6", 100.0);
    ok(model
        .threads
        .new_thread(lhc::threads::NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await);
    let reference = ThreadRef::file_path(path.clone());
    assert_eq!(
        ok(model.thread_view.status(reference.clone()).await).tail_tokens,
        0
    );
    let text = "special <|endoftext|> café 世界 repeated words";
    let event = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload { text: text.into() }),
            ..Default::default()
        },
    );
    ok(model
        .intake_stream
        .message_events(reference.clone(), &[event])
        .await);
    let db = open_raw(&path);
    let raw = lhc::estimate_tokens(text);
    let stored = db.prepare("SELECT token_estimate FROM message").all(&[]);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0]["token_estimate"], raw);
    let window = lhc::slice_tokens(text, 2, 4);
    assert_eq!(
        ok(model.thread_view.status(reference.clone()).await).tail_tokens,
        weigh(raw)
    );
    model.set_model("gpt-5.5");
    assert_eq!(
        ok(model.thread_view.status(reference).await).tail_tokens,
        raw
    );
    assert_eq!(lhc::slice_tokens(text, 2, 4), window);
    assert_eq!(window.total_tokens, raw);
}
