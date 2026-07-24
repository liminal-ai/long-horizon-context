//! Ported from packages/lhc/test/inference-classification.test.ts. Phase 1.
//!
//! Model-call failures preserve stable reason classes. safe_call contains
//! thrown host exceptions as `other` and races the adapter-owned timeout as
//! `timeout`, so host behavior cannot crash a drain.

mod fixtures;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use lhc::shared_tech::classify::safe_call;
use lhc::shared_tech::derivation::{ChunkPolicyConfig, Derivation, SdkConfig, SdkMode};
use lhc::shared_tech::inference_types::{
    DerivationGuards, DetailedTurnCompressionGuards, InferenceConfig, ModelCall,
    ModelCallFailureKind, ModelCallInput, ModelCallMessage, ModelCallMessageRole, ModelCallResult,
};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainReport, DrainStoppedBecause};
use lhc::threads::NewThreadInput;
use lhc::{Lhc, OpResult, ThreadRef, init_lhc};

use fixtures::{
    FAKE_MODEL_PREFIX, TempStore, TurnEndOverrides, UserPromptOverrides, UserPromptPayload,
    canned_responses, hanging_call, kind, read_derived_forms, recording_call, scripted_call,
    temp_store, throwing_call, valid_assignments, valid_event,
};

const CHUNK_POLICY: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 5,
    max_projected_tokens: 4400,
};

fn probe_input() -> ModelCallInput {
    ModelCallInput {
        provider: "prov-probe".into(),
        model: "model-probe".into(),
        messages: vec![ModelCallMessage {
            role: ModelCallMessageRole::User,
            content: "probe".into(),
        }],
        thinking: None,
    }
}

fn inference_sdk(call: ModelCall, timeout_ms: Option<i64>) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(valid_assignments(None)),
            timeout_ms,
            max_input_chars: None,
        }),
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
        chunk_policy: Some(CHUNK_POLICY),
        view: None,
    })
}

async fn seed_smoothing_only(sdk: &Lhc, store: &TempStore) -> String {
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path_str.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path_str),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "only a prompt to smooth".into(),
                    }),
                    ..Default::default()
                },
            )],
        )
        .await;
    assert!(result.is_ok());
    file_path_str
}

async fn drain_normally(sdk: &Lhc, file_path: &str) -> (DrainReport, Vec<Derivation>) {
    let drained = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    assert!(drained.is_ok());
    let OpResult::Ok { value } = drained else {
        panic!("drain failed");
    };
    assert_eq!(value.stopped_because, DrainStoppedBecause::Empty);
    assert_eq!(value.remaining, 0);
    (value, read_derived_forms(file_path))
}

fn counting_call(inner: ModelCall) -> (ModelCall, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let inner = Arc::new(inner);
    let calls_c = Arc::clone(&calls);
    let call: ModelCall = Box::new(move |input| {
        let inner = Arc::clone(&inner);
        let calls_c = Arc::clone(&calls_c);
        Box::pin(async move {
            calls_c.fetch_add(1, Ordering::SeqCst);
            inner(input).await
        })
    });
    (call, calls)
}

#[tokio::test]
async fn auth_fails_on_the_first_attempt_with_a_stable_kind_led_reason() {
    let store = temp_store();
    let (call, calls) = counting_call(scripted_call(vec![ModelCallResult::Err {
        kind: ModelCallFailureKind::Auth,
        message: "invalid api key".into(),
    }]));
    let sdk = inference_sdk(call, None);
    let (report, forms) = drain_normally(&sdk, &seed_smoothing_only(&sdk, &store).await).await;

    let smoothed = forms
        .iter()
        .find(|form| form.derivation_type == "smoothed_prompt");
    assert_eq!(smoothed.map(|f| f.state.as_str()), Some("failed"));
    assert_eq!(
        smoothed.and_then(|f| f.reason.as_deref()),
        Some("auth: invalid api key")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(report.ran.len(), 1);
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    store.cleanup();
}

#[tokio::test]
async fn network_fails_on_the_first_attempt_with_a_provider_failure_led_reason() {
    let store = temp_store();
    let (call, calls) = counting_call(scripted_call(vec![ModelCallResult::Err {
        kind: ModelCallFailureKind::Network,
        message: "connection reset".into(),
    }]));
    let sdk = inference_sdk(call, None);
    let (report, forms) = drain_normally(&sdk, &seed_smoothing_only(&sdk, &store).await).await;

    let smoothed = forms
        .iter()
        .find(|form| form.derivation_type == "smoothed_prompt");
    assert_eq!(smoothed.map(|f| f.state.as_str()), Some("failed"));
    let reason = smoothed.and_then(|f| f.reason.as_deref()).unwrap_or("");
    assert!(reason.starts_with("provider_failure"));
    assert!(reason.contains("network"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(report.ran[0].disposition, DrainDisposition::FailedTerminal);
    store.cleanup();
}

#[tokio::test]
async fn a_hanging_host_classifies_timeout_under_the_adapter_owned_race_and_the_drain_continues() {
    let store = temp_store();
    let hanging_lane = format!("{FAKE_MODEL_PREFIX}smoothed_prompt");
    let bundle = recording_call(&canned_responses());
    let canned = Arc::new(bundle.call);
    let hang = Arc::new(hanging_call());
    let call: ModelCall = Box::new(move |input| {
        let canned = Arc::clone(&canned);
        let hang = Arc::clone(&hang);
        let hanging_lane = hanging_lane.clone();
        Box::pin(async move {
            if input.model == hanging_lane {
                hang(input).await
            } else {
                canned(input).await
            }
        })
    });
    let sdk = inference_sdk(call, Some(50));
    let file_path = store.thread_path(None);
    let file_path_str = file_path.to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path_str.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    let seeded = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path_str),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "a prompt whose smoothing hangs".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(seeded.is_ok());

    let (_report, forms) = drain_normally(&sdk, &file_path_str).await;
    let smoothed = forms
        .iter()
        .find(|form| form.derivation_type == "smoothed_prompt");
    assert_eq!(smoothed.map(|f| f.state.as_str()), Some("ready"));
    assert_eq!(
        forms
            .iter()
            .find(|form| form.derivation_type == "turn_rendering")
            .map(|f| f.state.as_str()),
        Some("ready")
    );
    assert_eq!(
        forms
            .iter()
            .find(|form| form.derivation_type == "detailed_turn_compression")
            .map(|f| f.state.as_str()),
        Some("ready")
    );
    store.cleanup();
}

#[tokio::test]
async fn passes_a_structured_success_through_untouched() {
    let result = safe_call(
        &scripted_call(vec![ModelCallResult::Ok {
            text: "plain success".into(),
        }]),
        probe_input(),
        1000,
    )
    .await;
    assert_eq!(
        result,
        ModelCallResult::Ok {
            text: "plain success".into()
        }
    );
}

#[tokio::test]
async fn passes_a_structured_failure_through_untouched() {
    let result = safe_call(
        &scripted_call(vec![ModelCallResult::Err {
            kind: ModelCallFailureKind::RateLimit,
            message: "throttled".into(),
        }]),
        probe_input(),
        1000,
    )
    .await;
    assert_eq!(
        result,
        ModelCallResult::Err {
            kind: ModelCallFailureKind::RateLimit,
            message: "throttled".into(),
        }
    );
}

#[tokio::test]
async fn classifies_a_thrown_exception_as_other_carrying_the_message() {
    let result = safe_call(
        &throwing_call(Box::new(std::io::Error::other("kaboom"))),
        probe_input(),
        1000,
    )
    .await;
    match result {
        ModelCallResult::Err { kind, message } => {
            assert_eq!(kind, ModelCallFailureKind::Other);
            assert!(message.contains("kaboom"));
        }
        ModelCallResult::Ok { .. } => panic!("expected failure"),
    }
}

#[tokio::test]
async fn classifies_a_synchronously_throwing_host_as_other_the_promise_contract_is_not_trusted() {
    let sync: ModelCall = Box::new(|_input| {
        panic!("sync kaboom");
    });
    let result = safe_call(&sync, probe_input(), 1000).await;
    match result {
        ModelCallResult::Err { kind, message } => {
            assert_eq!(kind, ModelCallFailureKind::Other);
            assert!(message.contains("sync kaboom"));
        }
        ModelCallResult::Ok { .. } => panic!("expected failure"),
    }
}

#[tokio::test]
async fn classifies_a_never_settling_host_as_timeout_after_the_race() {
    let result = safe_call(&hanging_call(), probe_input(), 50).await;
    match result {
        ModelCallResult::Err { kind, message } => {
            assert_eq!(kind, ModelCallFailureKind::Timeout);
            assert!(message.contains("50"));
        }
        ModelCallResult::Ok { .. } => panic!("expected failure"),
    }
}
