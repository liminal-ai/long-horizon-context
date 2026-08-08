//! Bodies are token-budgeted; receipts are per-id. Without an id cap the
//! model-visible result is unbounded — arbitrarily many missing ids would
//! each earn a receipt despite the body budget (validator P0, 2026-08-08).
//! Ported from packages/lhc/test/retrieval-id-cap.test.ts.

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TempStore, TurnEndOverrides,
    UserPromptOverrides, UserPromptPayload, kind, temp_store, valid_event,
};
use lhc::retrieval::MAX_RETRIEVAL_IDS_PER_CALL;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc};

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
