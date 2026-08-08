//! Bodies are token-budgeted; receipts are per-id. Without an id cap the
//! model-visible result is unbounded — arbitrarily many missing ids would
//! each earn a receipt despite the body budget (validator P0, 2026-08-08).
//! Ported from packages/lhc/test/retrieval-id-cap.test.ts.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TempStore, TurnEndOverrides,
    UserPromptOverrides, UserPromptPayload, kind, temp_store, valid_event,
};
use lhc::retrieval::{MAX_RETRIEVAL_IDS_PER_CALL, UnservedReason};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::{js_len, js_slice};
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{
    DEFAULT_RETRIEVAL_TOKEN_BUDGET, Lhc, clamp_id_echo, create_deterministic_inference_callbacks,
    init_lhc,
};

async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => path,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn manual_sdk() -> Lhc {
    init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

async fn seed_one_turn(sdk: &Lhc, file_path: &str) {
    let sent = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "only question".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("only answer")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(sent.is_ok(), "intake failed");
    let drained = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    assert!(drained.is_ok(), "drain failed");
}

#[tokio::test]
async fn refuses_over_cap_calls_whole_naming_the_cap() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    let ids: Vec<String> = (0..MAX_RETRIEVAL_IDS_PER_CALL + 1)
        .map(|i| format!("t{}", i + 1))
        .collect();
    let result = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &ids, None)
        .await;
    assert!(!result.is_ok(), "over-cap must refuse whole");
    if let OpResult::Err { error } = result {
        assert!(
            error.reason.contains("too many ids"),
            "reason must name over-cap: {}",
            error.reason
        );
        assert!(
            error.reason.contains(&MAX_RETRIEVAL_IDS_PER_CALL.to_string()),
            "reason must name the cap: {}",
            error.reason
        );
        assert!(
            error.reason.contains("split the request"),
            "reason must teach split: {}",
            error.reason
        );
        let expected = format!(
            "get_turns: too many ids — {} requested, cap is {MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request",
            MAX_RETRIEVAL_IDS_PER_CALL + 1
        );
        assert_eq!(error.reason, expected);
    }
}

#[tokio::test]
async fn counts_deduped_ids_not_raw_ids() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    // MAX+10 raw copies of t1 → one deduped id; must not trip the cap.
    let ids: Vec<String> = std::iter::repeat_n("t1".to_string(), MAX_RETRIEVAL_IDS_PER_CALL + 10)
        .collect();
    let result = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &ids, None)
        .await;
    assert!(
        result.is_ok(),
        "dedupe before count must not trip cap: {:?}",
        result
    );
}

#[tokio::test]
async fn accepts_exactly_the_cap_of_unique_ids() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    let ids: Vec<String> = (0..MAX_RETRIEVAL_IDS_PER_CALL)
        .map(|i| format!("t{}", i + 1))
        .collect();
    let result = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &ids, None)
        .await;
    assert!(
        result.is_ok(),
        "exactly {MAX_RETRIEVAL_IDS_PER_CALL} unique ids must pass: {result:?}"
    );
}

#[tokio::test]
async fn refuses_oversized_ids_per_id_as_invalid_with_echo_clamped() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    // 40k-digit tail: fails ^[tm]\d{1,12}$; echo into receipts/impressions clamped.
    let monster = format!("t{}", "9".repeat(40_000));
    let expected_echo = clamp_id_echo(&monster);
    // Exact 32 UTF-16 code units + ellipsis (ASCII here: 32 chars + …).
    assert_eq!(js_len(&expected_echo[..expected_echo.len() - "…".len()]), 32);
    assert!(expected_echo.ends_with('…'));
    assert_eq!(
        &expected_echo[..32],
        &monster[..32],
        "prefix must be exact first 32 code units of the raw id"
    );

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &[monster.clone(), "t1".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("call must succeed with per-id invalid: {result:?}");
    };
    let invalid = receipt
        .unserved
        .iter()
        .find(|u| u.reason == UnservedReason::Invalid)
        .expect("invalid unserved row");
    assert_eq!(invalid.id, expected_echo);
    assert_eq!(receipt.served.len(), 1);

    let impressions = sdk
        .retrieval
        .list_impressions(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: impressions } = impressions else {
        panic!("list_impressions failed");
    };
    let inv_row = impressions
        .iter()
        .find(|r| r.reason.as_deref() == Some("invalid"))
        .expect("invalid impression");
    assert_eq!(
        inv_row.entity_id, expected_echo,
        "impression entity_id must equal receipt echo"
    );
    assert_eq!(inv_row.entity_id, invalid.id);
    assert!(!inv_row.served);
}

/// (a) Caller budget > DEFAULT is clamped AND a body larger than DEFAULT is
/// actually sliced at DEFAULT — not merely reported as a ceiling.
#[tokio::test]
async fn budget_ceiling_actually_slices_oversized_body_at_default() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    // Body well above 8000 tokens (not just a tiny turn with a high request).
    let big_body: String = (0..2000)
        .map(|i| {
            format!("line {i}: the quick brown fox jumps over the lazy dog and pads tokens")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let raw_tokens = estimate_tokens(&big_body);
    assert!(
        raw_tokens > DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        "fixture body must exceed DEFAULT ({DEFAULT_RETRIEVAL_TOKEN_BUDGET}), got {raw_tokens}"
    );

    let sent = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "dump everything".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new(format!(
                            "full dump follows\n{big_body}"
                        ))),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(sent.is_ok(), "intake failed");
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok(), "drain failed");

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(10_000_000.0),
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed: {result:?}");
    };
    assert_eq!(receipt.token_budget, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
    assert_eq!(receipt.served.len(), 1);
    let turn = &receipt.served[0];
    let slice = turn
        .slice
        .as_ref()
        .expect("oversized body must produce a slice receipt under ceiling");
    assert_eq!(slice.from_token, 0);
    assert_eq!(
        slice.to_token, DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        "slice must end at DEFAULT ceiling, got {}",
        slice.to_token
    );
    assert!(
        slice.total_tokens > DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        "total must exceed ceiling so this is a real slice"
    );
    assert_eq!(turn.tokens, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
    assert_eq!(
        estimate_tokens(&turn.text),
        DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        "served body text must be exactly DEFAULT tokens"
    );
}

/// (c) Digit-boundary of `^[tm]\d{1,12}$`.
#[tokio::test]
async fn digit_boundary_12_valid_13_invalid() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    let id12 = format!("t{}", "1".repeat(12));
    let id13 = format!("t{}", "1".repeat(13));
    assert_eq!(id12.len(), 13); // 't' + 12 digits
    assert_eq!(id13.len(), 14); // 't' + 13 digits

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &[id12.clone(), id13.clone(), "t1".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed: {result:?}");
    };

    // 12-digit id is shape-valid (may be not_found); must not be invalid.
    assert!(
        !receipt
            .unserved
            .iter()
            .any(|u| u.id == id12 && u.reason == UnservedReason::Invalid),
        "12-digit id must be shape-valid: {:?}",
        receipt.unserved
    );
    assert!(
        receipt.unserved.iter().any(|u| u.id == id12 && u.reason == UnservedReason::NotFound)
            || receipt.served.iter().any(|t| t.turn_id == id12),
        "12-digit id should resolve as not_found or served, not invalid"
    );

    let inv13 = receipt
        .unserved
        .iter()
        .find(|u| u.reason == UnservedReason::Invalid)
        .expect("13-digit id must be invalid");
    assert_eq!(inv13.id, id13); // short enough that echo is unclamped

    // t1 still served.
    assert_eq!(receipt.served.len(), 1);
    assert_eq!(receipt.served[0].turn_id, "t1");
}

/// (d) Echo clamp counts UTF-16 code units (TS `.slice(0, 32)`).
#[test]
fn echo_clamp_counts_utf16_code_units_byte_identical_with_ts() {
    // Each 🚀 is one Unicode scalar but two UTF-16 code units (surrogate pair).
    // Pure rockets keep the 32-unit cut on a pair boundary (js_slice drops a
    // lone high surrogate if the cut splits a pair — avoid that in this fixture).
    // 20 rockets = 40 UTF-16 units → clamp takes 16 rockets (32 units) + ellipsis.
    let id = "🚀".repeat(20);
    assert_eq!(js_len(&id), 40);
    let got = clamp_id_echo(&id);
    let expected = format!("{}…", js_slice(&id, 0, Some(32)));
    assert_eq!(got, expected);
    let prefix_slice = js_slice(&id, 0, Some(32));
    assert_eq!(js_len(&prefix_slice), 32);
    assert!(got.ends_with('…'));
    // Prefix is exactly first 32 UTF-16 units of raw id (not 32 Unicode scalars).
    let prefix = &got[..got.len() - "…".len()];
    assert_eq!(prefix, prefix_slice);
    assert_eq!(prefix.chars().count(), 16);
    assert_eq!(js_len(prefix), 32);

    // Mid-pair cut still clamps cleanly (may yield <32 units after surrogate strip).
    let misaligned = format!("x{}", "🚀".repeat(20));
    let mid = clamp_id_echo(&misaligned);
    assert_eq!(mid, format!("{}…", js_slice(&misaligned, 0, Some(32))));
    assert!(mid.ends_with('…'));
    assert!(js_len(&js_slice(&misaligned, 0, Some(32))) <= 32);

    // ASCII path: 40k digits after 't' → exact 32-char ASCII prefix + ellipsis.
    let monster = format!("t{}", "9".repeat(40_000));
    let ascii = clamp_id_echo(&monster);
    assert_eq!(ascii, format!("{}…", &monster[..32]));
    assert_eq!(&ascii[..32], &monster[..32]);
}

#[tokio::test]
async fn clamps_caller_token_budget_to_the_contract_ceiling() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_one_turn(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(10_000_000.0),
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed: {result:?}");
    };
    assert!(
        receipt.token_budget <= DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        "token_budget must clamp to DEFAULT ({}), got {}",
        DEFAULT_RETRIEVAL_TOKEN_BUDGET,
        receipt.token_budget
    );
    assert_eq!(receipt.token_budget, DEFAULT_RETRIEVAL_TOKEN_BUDGET);
}
