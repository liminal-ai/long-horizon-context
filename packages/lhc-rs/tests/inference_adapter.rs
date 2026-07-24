//! Ported from packages/lhc/test/inference-adapter.test.ts. Phase 1.
//!
//! Epic 05 Story 3 — TC-2.1 (AC-2.1, AC-2.2, AC-2.5) and TC-2.3 (AC-2.4).

mod fixtures;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, Derivation, SdkConfig, SdkMode, ToolOutcome,
};
use lhc::shared_tech::inference_types::{
    DerivationGuards, DetailedTurnCompressionGuards, InferenceConfig, ModelCall, ModelCallInput,
    ModelCallResult,
};
use lhc::shared_tech::logging::{DerivationLogEventKind, DerivationLogQuery};
use lhc::shared_tech::scheduler::DrainStoppedBecause;
use lhc::threads::NewThreadInput;
use lhc::{Lhc, OpResult, ThreadRef, create_deterministic_inference_callbacks, init_lhc};
use regex::Regex;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, DERIVATION_TYPES, INFERENCE_DERIVATION_TYPES,
    InferenceAssignments, InferenceDerivationType, TempStore, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, canned_responses, kind, read_derived_forms, recording_call, scripted_call,
    temp_store, valid_assignments, valid_event,
};

/// Tiny target: each placed turn crosses it, so turn 1's chunk closes during
/// the drain and the two chunk-summary kinds run too.
const CHUNK_POLICY: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 5,
    max_projected_tokens: 4400,
};

fn marker_pattern() -> Regex {
    Regex::new(r"^(smoothed|toolcall|toolresult|rendering|projection|detailed|brief)\(")
        .expect("marker regex")
}

/// The adversarial canned set: the tool lanes' text claims failure while the
/// record's tool result carries isError: false.
fn adversarial_responses() -> HashMap<String, String> {
    let mut responses = canned_responses();
    responses.insert(
        "tool_result_summary".into(),
        "error: the tool produced nothing and the run failed".into(),
    );
    responses
}

async fn seed_seven_kinds(sdk: &Lhc, store: &TempStore) -> String {
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
    let fixture_contents = "contents of fixture.txt ".repeat(1500);
    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path_str),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "please inspect the fixture file".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "call-adapter-1".into(),
                            tool_name: "read_file".into(),
                            arguments: serde_json::json!({"path": "fixture.txt"})
                                .as_object()
                                .unwrap()
                                .clone(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: "call-adapter-1".into(),
                            content: fixture_contents,
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "the fixture file holds fixture text".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "thanks, now summarize it".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "summarized".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(result.is_ok());
    file_path_str
}

async fn drain_all(sdk: &Lhc, file_path: &str) -> Vec<Derivation> {
    let drained = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    assert!(drained.is_ok());
    if let OpResult::Ok { value } = &drained {
        assert_eq!(value.stopped_because, DrainStoppedBecause::Empty);
        assert_eq!(value.remaining, 0);
    }
    read_derived_forms(file_path)
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

fn inference_sdk(call: ModelCall) -> (Lhc, InferenceAssignments) {
    let assignments = valid_assignments(None);
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments.to_string_keyed()),
            timeout_ms: None,
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
    });
    (sdk, assignments)
}

#[tokio::test]
#[ignore = "TC-2.1 exercises the real adapter end to end; mirrors TS it.skip"]
async fn a_seeded_drain_lands_every_kind_ready_with_its_lanes_canned_content_and_assignment_provenance()
 {
    let store = temp_store();
    let responses = adversarial_responses();
    let bundle = recording_call(&responses);
    let (sdk, assignments) = inference_sdk(bundle.call);
    let forms = drain_all(&sdk, &seed_seven_kinds(&sdk, &store).await).await;

    for kind_name in DERIVATION_TYPES {
        let ready: Vec<_> = forms
            .iter()
            .filter(|form| form.derivation_type == *kind_name && form.state.as_str() == "ready")
            .collect();
        assert!(!ready.is_empty());
    }
    for kind in InferenceDerivationType::ALL {
        let kind_name = kind.as_str();
        let ready: Vec<_> = forms
            .iter()
            .filter(|form| form.derivation_type == kind_name && form.state.as_str() == "ready")
            .collect();
        for form in ready {
            assert_eq!(form.content.as_deref(), Some(responses[kind_name].as_str()));
            let assignment = assignments.get(*kind);
            let provenance = form
                .metadata
                .as_ref()
                .and_then(|m| m.provenance.as_ref())
                .expect("provenance");
            assert_eq!(provenance.provider, assignment.provider);
            assert_eq!(provenance.model, assignment.model);
            assert_eq!(provenance.prompt, assignment.prompt);
        }
    }
    store.cleanup();
}

#[tokio::test]
#[ignore = "TC-2.1 exercises the real adapter end to end; mirrors TS it.skip"]
async fn outcomes_are_stamped_from_the_record_disagreeing_with_the_adversarial_canned_text() {
    let store = temp_store();
    let responses = adversarial_responses();
    let bundle = recording_call(&responses);
    let (sdk, _) = inference_sdk(bundle.call);
    let forms = drain_all(&sdk, &seed_seven_kinds(&sdk, &store).await).await;

    let form = forms
        .iter()
        .find(|row| row.derivation_type == "tool_result_summary" && row.state.as_str() == "ready");
    assert_eq!(
        form.and_then(|f| f.metadata.as_ref())
            .and_then(|m| m.outcome),
        Some(ToolOutcome::Succeeded)
    );
    assert!(
        form.and_then(|f| f.content.as_ref())
            .is_some_and(|c| c.contains("failed"))
    );
    let rendering = forms.iter().find(|row| {
        row.subject_id == "t1"
            && row.derivation_type == "turn_rendering"
            && row.state.as_str() == "ready"
    });
    assert!(rendering.is_some());
    assert!(
        rendering
            .and_then(|r| r.content.as_ref())
            .is_some_and(|c| c.contains("⇒ succeeded"))
    );
    store.cleanup();
}

#[tokio::test]
#[ignore = "TC-2.1 exercises the real adapter end to end; mirrors TS it.skip"]
async fn handler_equivalence_deterministic_inference_callbacks_land_the_same_rows_with_marker_content_and_no_provenance()
 {
    let store_a = temp_store();
    let store_b = temp_store();
    let bundle = recording_call(&adversarial_responses());
    let (adapter_sdk, _) = inference_sdk(bundle.call);
    let adapter_forms = drain_all(
        &adapter_sdk,
        &seed_seven_kinds(&adapter_sdk, &store_a).await,
    )
    .await;

    let deterministic_sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
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
        chunk_policy: Some(CHUNK_POLICY),
        view: None,
    });
    let deterministic_forms = drain_all(
        &deterministic_sdk,
        &seed_seven_kinds(&deterministic_sdk, &store_b).await,
    )
    .await;

    let row_key = |d: &Derivation| -> String {
        format!(
            "{}|{}|{}|{}",
            d.subject_kind.as_str(),
            d.subject_id,
            d.derivation_type,
            d.state.as_str()
        )
    };
    let mut det_keys: Vec<_> = deterministic_forms.iter().map(row_key).collect();
    let mut ad_keys: Vec<_> = adapter_forms.iter().map(row_key).collect();
    det_keys.sort();
    ad_keys.sort();
    assert_eq!(det_keys, ad_keys);

    let marker = marker_pattern();
    for form in &deterministic_forms {
        assert_eq!(form.state.as_str(), "ready");
        if INFERENCE_DERIVATION_TYPES.contains(&form.derivation_type.as_str()) {
            assert!(form.content.as_ref().is_some_and(|c| marker.is_match(c)));
        }
        assert!(
            form.metadata
                .as_ref()
                .and_then(|m| m.provenance.as_ref())
                .is_none()
        );
    }
    for form in &adapter_forms {
        // TS `expect(form.content).not.toMatch(MARKER)` — content must be
        // Some(string) before the negative marker check (None must not pass).
        let content = form
            .content
            .as_ref()
            .expect("adapter form content must be Some(string) before negative marker check");
        assert!(
            !marker.is_match(content),
            "adapter content unexpectedly matched deterministic marker: {content}"
        );
    }
    store_a.cleanup();
    store_b.cleanup();
}

#[tokio::test]
async fn a_whitespace_only_success_fails_on_the_first_attempt_as_empty_output() {
    let store = temp_store();
    let calls = Arc::new(AtomicUsize::new(0));
    let log: Arc<Mutex<Vec<ModelCallInput>>> = Arc::new(Mutex::new(Vec::new()));
    let script = scripted_call(vec![ModelCallResult::Ok { text: "  ".into() }]);
    let script = Arc::new(script);
    let calls_c = Arc::clone(&calls);
    let log_c = Arc::clone(&log);
    let call: ModelCall = Box::new(move |input| {
        let script = Arc::clone(&script);
        let calls_c = Arc::clone(&calls_c);
        let log_c = Arc::clone(&log_c);
        Box::pin(async move {
            calls_c.fetch_add(1, Ordering::SeqCst);
            log_c.lock().expect("log").push(input.clone());
            script(input).await
        })
    });
    let (sdk, _) = inference_sdk(call);
    let file_path = seed_smoothing_only(&sdk, &store).await;
    let forms = drain_all(&sdk, &file_path).await;

    let smoothed = forms
        .iter()
        .find(|form| form.derivation_type == "smoothed_prompt");
    assert_eq!(smoothed.map(|f| f.state.as_str()), Some("failed"));
    assert!(
        smoothed
            .and_then(|f| f.reason.as_ref())
            .is_some_and(|r| r.contains("empty_output"))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let derivation_log = sdk
        .logging
        .query_derivation_log(
            ThreadRef::file_path(&file_path),
            DerivationLogQuery {
                subject_kind: None,
                subject_id: Some("m1".into()),
                derivation_type: Some("smoothed_prompt".into()),
                event_kind: None,
            },
        )
        .await;
    assert!(derivation_log.is_ok());
    if let OpResult::Ok { value } = derivation_log {
        let failed = value
            .iter()
            .find(|entry| entry.event_kind == DerivationLogEventKind::InferenceFailed);
        assert!(failed.is_some());
        let failed = failed.expect("inference_failed");
        assert_eq!(failed.event_kind, DerivationLogEventKind::InferenceFailed);
        // Exact payload key set (TS `payload: { reason, requestMessages }`).
        let mut keys: Vec<_> = failed.payload.keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["reason".to_string(), "requestMessages".to_string()]
        );
        let reason = failed
            .payload
            .get("reason")
            .and_then(|v| v.as_str())
            .expect("reason must be a string");
        assert!(reason.contains("empty_output"));
        let request_messages = failed
            .payload
            .get("requestMessages")
            .expect("requestMessages present");
        assert!(request_messages.is_array() || request_messages.is_object());
        let logged = log.lock().expect("log");
        let expected = serde_json::to_value(&logged[0].messages).expect("messages json");
        assert_eq!(request_messages, &expected);
    }
    store.cleanup();
}

#[tokio::test]
async fn success_text_is_shaped_surrounding_whitespace_never_reaches_the_form_content() {
    let store = temp_store();
    let (sdk, _) = inference_sdk(scripted_call(vec![ModelCallResult::Ok {
        text: "\n  shaped result text  \n".into(),
    }]));
    let forms = drain_all(&sdk, &seed_smoothing_only(&sdk, &store).await).await;

    let smoothed = forms
        .iter()
        .find(|form| form.derivation_type == "smoothed_prompt");
    assert_eq!(smoothed.map(|f| f.state.as_str()), Some("ready"));
    assert_eq!(
        smoothed.and_then(|f| f.content.as_deref()),
        Some("shaped result text")
    );
    store.cleanup();
}
