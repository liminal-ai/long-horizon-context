//! Ported from packages/lhc/test/turn-construction-cap.test.ts.
//!
//! F1 — the bounded per-message construction cap. Construction behavior only:
//! a giant message renders as head + marked elision (naming its exact-retrieval
//! address) + tail; canonical keeps every byte, retrieval serves them, the
//! verbatim tail serves them, and derivation floors are written uncapped.
mod fixtures;

use fixtures::temp_store;
use fixtures::turn_parts::{
    compact, context, context_texts, describe, drain_to_zero, event, file_ref, giant, new_thread,
    new_thread_named, params as _params, prepare, prompt, scalar_str, sdk_for, send, shares,
    turn_end,
};
use lhc::intake_stream::EventKind;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::ViewCompactParams;
use lhc::turns::internal::compose::{CONSTRUCTION_MESSAGE_CAP_TOKENS, cap_for_construction};
use serde_json::json;

static ALGORITHM_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400.0),
        percentages: Some(shares(50.0, 50.0, 0.0, 0.0)),
        newest_closed_protection: None,
    }
}

fn params_bound(lower_bound: f64) -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(lower_bound),
        ..params()
    }
}

#[test]
fn cap_for_construction_is_identity_under_the_cap_and_a_priced_head_elision_tail_over_it() {
    let giant = giant();
    assert_eq!(cap_for_construction("short", "m9"), "short");
    let capped = cap_for_construction(&giant, "m9");
    assert!(capped.starts_with("line 0 of"));
    assert!(capped.ends_with("assistant message body"));
    let marker_line = capped
        .lines()
        .find(|l| l.starts_with("[… ") && l.ends_with(" …]"))
        .expect("elision marker line");
    assert!(marker_line.contains(" tokens elided at construction — exact content: m9 …]"));
    assert!(capped.len() < giant.len());
    assert_eq!(capped, cap_for_construction(&giant, "m9")); // deterministic
}

// The smooth band a compact under one plan serves, with one subject's arrangement rung.
async fn served_smooth(
    sdk: &lhc::Lhc,
    file_path: &str,
    legacy: bool,
    p: ViewCompactParams,
    subject_id: &str,
) -> (String, Option<String>) {
    // SAFETY: serialized by ALGORITHM_ENV within this binary.
    unsafe {
        if legacy {
            std::env::set_var("LHC_COMPACT_ALGORITHM", "legacy");
        } else {
            std::env::remove_var("LHC_COMPACT_ALGORITHM");
        }
    }
    let receipt = compact(sdk, file_path, p).await;
    unsafe { std::env::remove_var("LHC_COMPACT_ALGORITHM") };
    let described = describe(file_path).await;
    (
        receipt
            .rendered_bands
            .iter()
            .find(|b| b.band == lhc::shared_tech::view::Band::Smooth)
            .map(|b| b.text.clone())
            .unwrap_or_default(),
        described
            .arrangement
            .iter()
            .find(|e| e.subject_id == subject_id)
            .map(|e| e.derivation_used.clone()),
    )
}

async fn exact_message(sdk: &lhc::Lhc, file_path: &str, message_id: &str) -> String {
    match sdk
        .retrieval
        .get_messages(file_ref(file_path), &[message_id.to_string()], None)
        .await
    {
        OpResult::Ok { value } => value.served[0].text.clone(),
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

#[tokio::test]
async fn parts_and_served_renderings_elide_with_a_pointer_retrieval_tail_stored_rendering_and_floors_keep_every_byte()
 {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    let giant = giant();
    let giant_prompt = format!("please read this\n{giant}");
    send(
        &sdk,
        &file_path,
        &[
            prompt("t1 prompt"),
            event(EventKind::AssistantText, json!({"text": "t1 answer"})),
            turn_end(),
            prompt(&giant_prompt),
            event(
                EventKind::AssistantText,
                json!({"text": giant, "stepIndex": 0}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": "step 1 short", "stepIndex": 1}),
            ),
        ],
    )
    .await;

    // Split after step 0: the part holds the giant prompt (m4) and giant text (m5), capped.
    let prepared = prepare(&file_path, params()).await;
    let part = prepared
        .selection
        .entries
        .iter()
        .find(|e| e.part.is_some())
        .expect("part");
    assert_eq!(
        part.part,
        Some(lhc::shared_tech::view::PartRange {
            from_step: 0,
            to_step: 0
        })
    );
    assert!(part.text.contains("exact content: m4 …]"));
    assert!(part.text.contains("exact content: m5 …]"));
    assert!(part.tokens < 2 * CONSTRUCTION_MESSAGE_CAP_TOKENS + 400);

    // Retrieval serves the exact bytes the pointer names.
    assert_eq!(exact_message(&sdk, &file_path, "m5").await, giant);

    // The verbatim tail is never capped: keep the giant text in the tail by
    // not splitting (a huge budget) and read the served context.
    let uncut = compact(&sdk, &file_path, params_bound(100_000.0)).await;
    assert_eq!(uncut.parts, None);
    let texts = context_texts(&context(&file_path).await);
    assert!(texts.contains(&giant));
    assert!(!texts.iter().any(|t| t.contains("elided at construction")));

    // Close, drain: the durable artifacts both plans consume are uncapped —
    // the stored turn_rendering row and the smoothed_prompt floor.
    send(&sdk, &file_path, &[turn_end()]).await;
    drain_to_zero(&sdk, &file_path).await;
    let rendering = scalar_str(
        &file_path,
        "SELECT content FROM derivation WHERE subject_id = 't2' AND derivation_type = 'turn_rendering'",
    )
    .expect("stored rendering");
    let floor = scalar_str(
        &file_path,
        "SELECT content FROM derivation WHERE subject_id = 'm4' AND derivation_type = 'smoothed_prompt'",
    );
    assert!(!floor.unwrap_or_default().contains("elided at construction"));
    assert!(rendering.contains(&giant));
    assert!(!rendering.contains("elided at construction"));

    // The frozen differential: the same record, banded under each plan.
    // Legacy serves the stored row byte-for-byte; bounded serves it capped.
    let legacy = new_thread_named(&sdk, &store, Some("legacy")).await;
    let bounded = new_thread_named(&sdk, &store, Some("bounded")).await;
    std::fs::copy(&file_path, &legacy).expect("copy");
    std::fs::copy(&file_path, &bounded).expect("copy");
    let (legacy_text, legacy_rung) = served_smooth(&sdk, &legacy, true, params(), "t2").await;
    assert_eq!(legacy_rung.as_deref(), Some("turn_rendering"));
    assert!(legacy_text.contains(&rendering));
    assert!(!legacy_text.contains("elided at construction"));
    let (bounded_text, bounded_rung) = served_smooth(&sdk, &bounded, false, params(), "t2").await;
    assert_eq!(bounded_rung.as_deref(), Some("composed_in_walk"));
    assert!(bounded_text.contains("exact content: m5 …]"));
    assert!(!bounded_text.contains(&giant));
    store.cleanup();
}

#[tokio::test]
async fn caps_at_the_true_message_boundary_when_a_body_carries_its_own_tag_shaped_close_text() {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    // m2 is the giant message; its body carries "</m2>" early, then keeps going.
    let giant = giant();
    let lines: Vec<&str> = giant.split('\n').collect();
    let mut trap_lines: Vec<&str> = lines[..20].to_vec();
    trap_lines.push("</m2>");
    trap_lines.push("<m2>");
    trap_lines.extend_from_slice(&lines[20..]);
    let trap = trap_lines.join("\n");
    send(
        &sdk,
        &file_path,
        &[
            prompt("t1 prompt"),
            event(
                EventKind::AssistantText,
                json!({"text": trap, "stepIndex": 0}),
            ),
            event(
                EventKind::AssistantText,
                json!({"text": "step 1 short", "stepIndex": 1}),
            ),
        ],
    )
    .await;

    let prepared = prepare(&file_path, params()).await;
    let part = prepared
        .selection
        .entries
        .iter()
        .find(|e| e.part.is_some())
        .expect("part");
    assert_eq!(
        part.part,
        Some(lhc::shared_tech::view::PartRange {
            from_step: 0,
            to_step: 0
        })
    );
    // One cap over the whole body: the embedded close text sits inside the
    // kept head, the elision follows it, and nothing behind it leaks uncapped.
    let open_at = part.text.find("<m2>").expect("open tag") + 4;
    let close_at = part.text.rfind("</m2>").expect("close tag");
    let body = &part.text[open_at..close_at];
    assert_eq!(body.split("exact content: m2 …]").count(), 2);
    assert!(body.contains("line 19 of a very long"));
    assert!(body.contains("\n</m2>\n<m2>\n"));
    assert!(!body.contains("line 150 of a very long"));
    assert!(body.contains("line 299 of a very long"));
    assert!(part.tokens < CONSTRUCTION_MESSAGE_CAP_TOKENS + 400);

    // Durable and legacy bytes are exact.
    assert_eq!(exact_message(&sdk, &file_path, "m2").await, trap);
    send(&sdk, &file_path, &[turn_end()]).await;
    drain_to_zero(&sdk, &file_path).await;
    let rendering = scalar_str(
        &file_path,
        "SELECT content FROM derivation WHERE subject_id = 't1' AND derivation_type = 'turn_rendering'",
    )
    .expect("stored rendering");
    assert!(rendering.contains(&trap));
    let legacy = new_thread_named(&sdk, &store, Some("legacy-trap")).await;
    std::fs::copy(&file_path, &legacy).expect("copy");
    let (legacy_text, legacy_rung) = served_smooth(&sdk, &legacy, true, params(), "t1").await;
    assert_eq!(legacy_rung.as_deref(), Some("turn_rendering"));
    assert!(legacy_text.contains(&rendering));
    let (bounded_text, bounded_rung) = served_smooth(&sdk, &file_path, false, params(), "t1").await;
    assert_eq!(bounded_rung.as_deref(), Some("composed_in_walk"));
    assert!(bounded_text.contains("exact content: m2 …]"));
    assert!(!bounded_text.contains("line 150 of a very long"));
    let _ = _params(1);
    store.cleanup();
}
