//! Ported from packages/lhc/test/inference-construction.test.ts. Phase 1.
//!
//! Epic 05 Story 2 — TC-1.1 (AC-1.1, AC-1.3): the construction matrix.

mod fixtures;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;

use indexmap::IndexMap;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::inference_types::{InferenceConfig, ModelAssignment, ModelCall};
use lhc::shared_tech::scheduler::DrainStoppedBecause;
use lhc::threads::NewThreadInput;
use lhc::{OpResult, ThreadRef, init_lhc};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, ModelAssignmentOverride, TurnEndOverrides,
    UserPromptOverrides, UserPromptPayload, canned_responses, create_inference_callbacks_double,
    kind, read_derived_forms, recording_call, temp_store, valid_assignments, valid_event,
};

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "non-string panic payload".into())
}

fn expect_type_error_naming(make: impl FnOnce(), needles: &[&str]) {
    let result = std::panic::catch_unwind(AssertUnwindSafe(make));
    let Err(err) = result else {
        panic!("init_lhc must reject this config");
    };
    let msg = panic_message(err);
    // Phase 1 init_lhc is todo!("phase 2"): re-raise so the gate classifies notimpl.
    if msg.contains("phase 2") || msg.contains("not yet implemented") {
        panic!("{msg}");
    }
    for needle in needles {
        assert!(
            msg.contains(needle),
            "expected panic message to contain {needle:?}, got {msg}"
        );
    }
}

fn init_with_assignments(call: ModelCall, assignments: IndexMap<String, ModelAssignment>) {
    let _ = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
}

#[test]
fn both_inference_callbacks_and_inference_is_a_typeerror_naming_the_xor_rule() {
    let bundle = recording_call(&canned_responses());
    let double = create_inference_callbacks_double();
    expect_type_error_naming(
        move || {
            let _ = init_lhc(SdkConfig {
                inference_callbacks: Some(double.to_callbacks()),
                inference: Some(InferenceConfig {
                    call: bundle.call,
                    assignments: Some(valid_assignments(None)),
                    timeout_ms: None,
                    max_input_chars: None,
                }),
                mode: SdkMode::Manual,
                clock: None,
                guards: None,
                tool_result: None,
                lease: None,
                chunk_policy: None,
                view: None,
            });
        },
        &["exactly one of inferenceCallbacks or inference"],
    );
}

#[test]
fn neither_inference_callbacks_nor_inference_is_a_typeerror_naming_the_xor_rule() {
    expect_type_error_naming(
        || {
            let _ = init_lhc(SdkConfig {
                inference_callbacks: None,
                inference: None,
                mode: SdkMode::Manual,
                clock: None,
                guards: None,
                tool_result: None,
                lease: None,
                chunk_policy: None,
                view: None,
            });
        },
        &["exactly one of inferenceCallbacks or inference"],
    );
}

#[test]
fn an_unknown_kind_key_in_assignments_is_a_typeerror_naming_it() {
    let mut assignments = valid_assignments(None);
    assignments.insert(
        "smoothed_promptz".into(),
        ModelAssignment {
            provider: "prov-x".into(),
            model: "model-x".into(),
            prompt: "smoothing-v1".into(),
            target_min_ratio: None,
            target_max_ratio: None,
            target_aim_ratio: None,
            thinking: None,
        },
    );
    let bundle = recording_call(&canned_responses());
    expect_type_error_naming(
        move || init_with_assignments(bundle.call, assignments),
        &["unknown derivation type \"smoothed_promptz\""],
    );
}

#[test]
fn an_unknown_prompt_name_on_an_inference_assignment_is_a_typeerror_naming_kind_and_prompt() {
    let mut overrides = HashMap::new();
    overrides.insert(
        "tool_result_summary".into(),
        ModelAssignmentOverride {
            prompt: Some("tool-result-v99".into()),
            ..Default::default()
        },
    );
    let assignments = valid_assignments(Some(&overrides));
    let bundle = recording_call(&canned_responses());
    expect_type_error_naming(
        move || init_with_assignments(bundle.call, assignments),
        &[
            "tool_result_summary",
            "unknown template \"tool-result-v99\"",
        ],
    );
}

#[test]
fn an_empty_provider_string_on_an_inference_assignment_is_a_typeerror_naming_field_and_kind() {
    let mut overrides = HashMap::new();
    overrides.insert(
        "smoothed_prompt".into(),
        ModelAssignmentOverride {
            provider: Some("".into()),
            ..Default::default()
        },
    );
    let assignments = valid_assignments(Some(&overrides));
    let bundle = recording_call(&canned_responses());
    expect_type_error_naming(
        move || init_with_assignments(bundle.call, assignments),
        &["smoothed_prompt.provider must be a non-empty string"],
    );
}

#[test]
fn an_empty_model_string_on_an_inference_assignment_is_a_typeerror_naming_field_and_kind() {
    let mut overrides = HashMap::new();
    overrides.insert(
        "chunk_summary_brief".into(),
        ModelAssignmentOverride {
            model: Some("  ".into()),
            ..Default::default()
        },
    );
    let assignments = valid_assignments(Some(&overrides));
    let bundle = recording_call(&canned_responses());
    expect_type_error_naming(
        move || init_with_assignments(bundle.call, assignments),
        &["chunk_summary_brief.model must be a non-empty string"],
    );
}

#[tokio::test]
async fn constructs_and_a_seeded_drain_lands_a_form_ready_with_the_hosts_text() {
    let store = temp_store();
    let responses = canned_responses();
    let bundle = recording_call(&responses);
    let log = bundle.log;
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call: bundle.call,
            assignments: Some(valid_assignments(None)),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });

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
    let batch = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path_str),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "construct me a context".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "constructing".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(batch.is_ok());

    let drained = sdk
        .work
        .drain(ThreadRef::file_path(&file_path_str), None)
        .await;
    assert!(drained.is_ok());
    if let OpResult::Ok { value } = &drained {
        assert_eq!(value.stopped_because, DrainStoppedBecause::Empty);
        assert_eq!(value.remaining, 0);
    }

    let smoothed = read_derived_forms(&file_path_str)
        .into_iter()
        .find(|form| form.derivation_type == "smoothed_prompt" && form.subject_id == "m1");
    assert_eq!(smoothed.as_ref().map(|f| f.state.as_str()), Some("ready"));
    assert_eq!(
        smoothed.and_then(|f| f.content),
        Some(responses["smoothed_prompt"].clone())
    );
    assert!(!log.lock().expect("log").is_empty());
    store.cleanup();
}
