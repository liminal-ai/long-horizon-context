//! Ported from packages/lhc/test/smoothed-prompt-guards.test.ts. Phase 1.

mod fixtures;

use std::sync::{Arc, Mutex};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName, TempStore,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    read_derived_forms, temp_store, valid_event,
};
use lhc::messages::clean_prompt;
use lhc::shared_tech::derivation::{
    BoxFuture, Derivation, DerivationState, LeaseConfig, SdkConfig, SdkMode,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{
    DerivationGuards, InferenceConfig, ModelCall, ModelCallInput, ModelCallResult,
    SmoothedPromptGuards,
};
use lhc::shared_tech::logging::{LogLevel, LogQuery};
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::count_live_items;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, threads};

fn token_text(min_tokens: i64) -> String {
    let mut text = String::new();
    while estimate_tokens(&text) < min_tokens {
        text.push_str("guardword ");
    }
    text.trim().to_string()
}

fn recording_model_call(text: &str) -> (ModelCall, Arc<Mutex<Vec<ModelCallInput>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = Arc::clone(&log);
    let text = text.to_string();
    let call: ModelCall = Box::new(move |input: ModelCallInput| {
        let log2 = Arc::clone(&log2);
        let text = text.clone();
        Box::pin(async move {
            log2.lock().unwrap().push(input);
            ModelCallResult::Ok { text }
        }) as BoxFuture<_>
    });
    (call, log)
}

fn sdk_with_model_call(
    model_text: &str,
    guards: Option<DerivationGuards>,
) -> (Lhc, Arc<Mutex<Vec<ModelCallInput>>>) {
    let (call, log) = recording_model_call(model_text);
    (
        init_lhc(SdkConfig {
            inference_callbacks: None,
            inference: Some(InferenceConfig {
                call,
                assignments: None,
                timeout_ms: None,
                max_input_chars: None,
            }),
            mode: SdkMode::Manual,
            clock: None,
            guards,
            tool_result: None,
            lease: Some(LeaseConfig { duration_ms: 200 }),
            chunk_policy: None,
            view: None,
        }),
        log,
    )
}

async fn new_thread(store: &TempStore) -> String {
    match threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

async fn send_prompt(sdk: &Lhc, file_path: &str, text: &str) {
    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(file_path),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload { text: text.into() }),
                    ..Default::default()
                },
            )],
        )
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }
}

async fn send_closed_turn(sdk: &Lhc, file_path: &str, text: &str) {
    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload { text: text.into() }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "answer".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, Default::default()),
            ],
        )
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }
}

async fn drain(sdk: &Lhc, file_path: &str) {
    match sdk.work.drain(ThreadRef::file_path(file_path), None).await {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn derivation(file_path: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|r| r.subject_id == "m1" && r.derivation_type == "smoothed_prompt")
}

fn live_work_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn delete_work_item(file_path: &str, work_item_id: &str) {
    let db = open_raw(file_path);
    db.prepare("DELETE FROM work_item WHERE work_item_id = ?")
        .run(&[SqlParam::from(work_item_id)]);
    db.close();
}

#[tokio::test]
async fn uses_the_default_700_token_cap_and_stores_the_cleaned_floor_as_ready_without_inference() {
    let store = temp_store();
    let prompt = token_text(900);
    let model_text = token_text(200);
    let (sdk, log) = sdk_with_model_call(&model_text, None);
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, &prompt).await;
    drain(&sdk, &file_path).await;

    assert_eq!(sdk.config.guards.smoothed_prompt.max_inference_tokens, 700);
    assert_eq!(log.lock().unwrap().len(), 0);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
    assert!(deriv.metadata.is_none());
    assert_eq!(live_work_count(&file_path), 0);
}

#[tokio::test]
async fn respects_a_custom_cap_from_top_level_sdkconfig_guards() {
    let store = temp_store();
    let prompt = token_text(600);
    let (sdk, log) = sdk_with_model_call(
        &token_text(200),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(500),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, &prompt).await;
    drain(&sdk, &file_path).await;

    assert_eq!(sdk.config.guards.smoothed_prompt.max_inference_tokens, 500);
    assert_eq!(log.lock().unwrap().len(), 0);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
    assert_eq!(live_work_count(&file_path), 0);
}

#[tokio::test]
async fn runs_inference_when_the_prompt_is_below_the_configured_cap() {
    let store = temp_store();
    let prompt = token_text(600);
    let model_text = token_text(200);
    let (sdk, log) = sdk_with_model_call(
        &model_text,
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(1000),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, &prompt).await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 1);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(deriv.content.as_deref(), Some(model_text.as_str()));
}

#[tokio::test]
async fn discards_suspiciously_short_smoothing_output_stores_discard_metadata_and_logs_a_warning() {
    let store = temp_store();
    let prompt = token_text(500);
    let short_model_text = token_text(50);
    // TS: messages.cleanPrompt(prompt) — module export (not sdk.messages).
    let cleaned = clean_prompt(&prompt);
    assert!(
        (estimate_tokens(&short_model_text) as f64) < 0.15 * (estimate_tokens(&cleaned) as f64)
    );
    let (sdk, log) = sdk_with_model_call(&short_model_text, None);
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, &prompt).await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 1);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
    assert_eq!(
        deriv
            .metadata
            .as_ref()
            .and_then(|m| m.discard_reason.as_deref()),
        Some("suspicious_output_ratio")
    );
    assert_eq!(live_work_count(&file_path), 0);

    let logs = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: Some(LogLevel::Warning),
                derivation_type: Some("smoothed_prompt".into()),
                subject_id: Some("m1".into()),
                reason: None,
            },
        )
        .await;
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert_eq!(value.len(), 1);
    assert_eq!(value[0].level, LogLevel::Warning);
    assert_eq!(value[0].reason.as_deref(), Some("suspicious_output_ratio"));
    assert_eq!(
        value[0].floor_used.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
}

#[tokio::test]
async fn resolves_guard_defaults_for_direct_callback_hosts() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;
    let prompt = token_text(900);

    send_prompt(&sdk, &file_path, &prompt).await;
    drain(&sdk, &file_path).await;

    assert_eq!(sdk.config.guards.smoothed_prompt.max_inference_tokens, 700);
    assert!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
}

#[tokio::test]
async fn turn_construction_uses_the_guard_cap_for_pending_prompt_smoothing() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;
    let prompt = token_text(900);

    send_closed_turn(&sdk, &file_path, &prompt).await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let derived = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;

    assert!(derived.is_ok());
    assert!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some(sdk.messages.clean_prompt(&prompt).as_str())
    );
    assert_eq!(live_work_count(&file_path), 0);
}

#[tokio::test]
async fn turn_construction_preserves_an_already_ready_smoothed_prompt_without_calling_smoothing_inference()
 {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&store).await;
    let prompt = token_text(500);

    send_closed_turn(&sdk, &file_path, &prompt).await;
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    let db = open_raw(&file_path);
    db.prepare(
        "UPDATE derivation
         SET state = 'ready', content = ?, reason = NULL, metadata = NULL, derived_at = ?
         WHERE subject_kind = 'message'
           AND subject_id = 'm1'
           AND derivation_type = 'smoothed_prompt'",
    )
    .run(&[
        SqlParam::from("competing ready value"),
        SqlParam::from("2026-06-22T12:00:00.000Z"),
    ]);
    db.close();

    let calls_before_turn = captured.snapshot().len();
    let derived = sdk
        .turns
        .derive_turn(ThreadRef::file_path(&file_path), "t1")
        .await;
    assert!(derived.is_ok());
    assert!(
        captured.snapshot()[calls_before_turn..]
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(deriv.content.as_deref(), Some("competing ready value"));
    assert!(deriv.metadata.is_none());

    let logs = sdk
        .logging
        .query(
            ThreadRef::file_path(&file_path),
            LogQuery {
                level: Some(LogLevel::Warning),
                derivation_type: Some("smoothed_prompt".into()),
                subject_id: Some("m1".into()),
                reason: None,
            },
        )
        .await;
    assert!(logs.is_ok());
    let OpResult::Ok { value } = logs else {
        return;
    };
    assert!(value.is_empty());
}

#[tokio::test]
async fn stores_a_bracketed_marker_prompt_verbatim_without_calling_inference() {
    let store = temp_store();
    let (sdk, log) = sdk_with_model_call("should never be produced", None);
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, "[Request interrupted by user]").await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 0);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some("[Request interrupted by user]")
    );
    assert!(deriv.metadata.is_none());
    assert_eq!(live_work_count(&file_path), 0);
}

#[tokio::test]
async fn skips_inference_for_a_marker_with_surrounding_whitespace() {
    let store = temp_store();
    let (sdk, log) = sdk_with_model_call("should never be produced", None);
    let file_path = new_thread(&store).await;

    send_prompt(
        &sdk,
        &file_path,
        "  [Request interrupted by user for tool use]\n",
    )
    .await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 0);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(
        deriv.content.as_deref(),
        Some("[Request interrupted by user for tool use]")
    );
}

#[tokio::test]
async fn still_smooths_a_prompt_that_merely_contains_brackets() {
    let store = temp_store();
    let model_text = "please fix the flaky test in ci.yml";
    // Default guards (None) — TS does not pass maxInferenceTokens here.
    let (sdk, log) = sdk_with_model_call(model_text, None);
    let file_path = new_thread(&store).await;

    send_prompt(
        &sdk,
        &file_path,
        "please fix the [flaky] test in ci.yml, it keeps failing intermittently on main",
    )
    .await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 1);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(deriv.content.as_deref(), Some(model_text));
}

#[tokio::test]
async fn still_smooths_when_brackets_wrap_more_than_eighty_characters() {
    let store = temp_store();
    let inner = "x".repeat(100);
    let model_text = "long bracketed content smoothed";
    // Default guards (None) — TS does not pass maxInferenceTokens here.
    let (sdk, log) = sdk_with_model_call(model_text, None);
    let file_path = new_thread(&store).await;

    send_prompt(&sdk, &file_path, &format!("[{inner}]")).await;
    drain(&sdk, &file_path).await;

    assert_eq!(log.lock().unwrap().len(), 1);
    let deriv = derivation(&file_path).expect("deriv");
    assert_eq!(deriv.state, DerivationState::Ready);
    assert_eq!(deriv.content.as_deref(), Some(model_text));
}
