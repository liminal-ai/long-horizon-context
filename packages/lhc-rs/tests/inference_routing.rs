//! Ported from packages/lhc/test/inference-routing.test.ts. Phase 1.
//!
//! Epic 05 Story 2 — TC-1.2 (AC-1.2, AC-1.4): per-call routing through the
//! inference seam.

mod fixtures;

use std::collections::HashMap;

use lhc::shared_tech::inference_types::{ModelCallMessageRole, ModelCallResult};

use fixtures::{
    DERIVATION_TYPES, FAKE_MODEL_PREFIX, FAKE_PROVIDER_PREFIX, INFERENCE_DERIVATION_TYPES,
    ModelAssignmentOverride, ProbeInputOverrides, assert_model_call_contract,
    assert_routing_through_sdk, canned_responses, probe_input, recording_call, temp_store,
    valid_assignments,
};

#[tokio::test]
#[ignore = "TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip"]
async fn a_seeded_drain_exercises_all_seven_kinds_each_call_carrying_exactly_its_assigned_strings()
{
    let store = temp_store();
    let responses = canned_responses();
    let bundle = recording_call(&responses);
    let log = bundle.log;
    let assignments = valid_assignments(None);
    let run = assert_routing_through_sdk(bundle.call, assignments.clone(), &store).await;
    let forms = run.derivations;

    for kind_name in INFERENCE_DERIVATION_TYPES {
        let log_snapshot = log.lock().expect("log").clone();
        let lane: Vec<_> = log_snapshot
            .iter()
            .filter(|input| input.model == format!("{FAKE_MODEL_PREFIX}{kind_name}"))
            .cloned()
            .collect();
        assert!(!lane.is_empty());
        for input in &lane {
            assert_eq!(input.provider, format!("{FAKE_PROVIDER_PREFIX}{kind_name}"));
            assert_eq!(input.model, assignments[*kind_name].model);
        }
        let ready: Vec<_> = forms
            .iter()
            .filter(|form| form.derivation_type == *kind_name && form.state.as_str() == "ready")
            .collect();
        assert!(!ready.is_empty());
        for form in ready {
            assert_eq!(
                form.content.as_deref(),
                Some(responses[*kind_name].as_str())
            );
        }
    }
    for kind_name in DERIVATION_TYPES {
        assert!(
            forms
                .iter()
                .any(|form| form.derivation_type == *kind_name && form.state.as_str() == "ready")
        );
    }
    store.cleanup();
}

#[tokio::test]
#[ignore = "TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip"]
async fn every_logged_messages_value_is_single_turn_shape_system_and_user_roles_string_content() {
    let store = temp_store();
    let bundle = recording_call(&canned_responses());
    let log = bundle.log;
    let _ = assert_routing_through_sdk(bundle.call, valid_assignments(None), &store).await;

    let log_snapshot = log.lock().expect("log").clone();
    assert!(!log_snapshot.is_empty());
    for input in &log_snapshot {
        assert!(!input.messages.is_empty());
        assert!(
            input
                .messages
                .iter()
                .any(|m| m.role == ModelCallMessageRole::User)
        );
        for message in &input.messages {
            assert!(matches!(
                message.role,
                ModelCallMessageRole::System | ModelCallMessageRole::User
            ));
            // TS `typeof message.content === "string"` — pin owned String, not a vacuous borrow.
            let content: &String = &message.content;
            let _: &str = content.as_str();
        }
    }
    store.cleanup();
}

#[tokio::test]
#[ignore = "TC-1.2 exercises per-kind routing through a full seeded drain; mirrors TS it.skip"]
async fn a_three_lane_mixed_config_routes_each_call_by_item_kind_with_no_cross_kind_bleed() {
    let store = temp_store();
    let lanes = HashMap::from([
        ("smoothed_prompt", "lane-alpha"),
        ("tool_result_summary", "lane-beta"),
        ("detailed_turn_compression", "lane-beta"),
        ("chunk_summary_brief", "lane-gamma"),
    ]);
    let mut overrides = HashMap::new();
    for (kind_name, provider) in &lanes {
        overrides.insert(
            (*kind_name).to_string(),
            ModelAssignmentOverride {
                provider: Some((*provider).to_string()),
                ..Default::default()
            },
        );
    }
    let assignments = valid_assignments(Some(&overrides));
    let responses = canned_responses();
    let bundle = recording_call(&responses);
    let log = bundle.log;
    let run = assert_routing_through_sdk(bundle.call, assignments.clone(), &store).await;
    let forms = run.derivations;

    for kind_name in INFERENCE_DERIVATION_TYPES {
        let log_snapshot = log.lock().expect("log").clone();
        let calls: Vec<_> = log_snapshot
            .iter()
            .filter(|input| input.model == assignments[*kind_name].model)
            .cloned()
            .collect();
        assert!(!calls.is_empty());
        for input in &calls {
            assert_eq!(input.provider, lanes[*kind_name]);
        }
        let ready: Vec<_> = forms
            .iter()
            .filter(|form| form.derivation_type == *kind_name && form.state.as_str() == "ready")
            .collect();
        assert!(!ready.is_empty());
        for form in ready {
            assert_eq!(
                form.content.as_deref(),
                Some(responses[*kind_name].as_str())
            );
        }
    }
    store.cleanup();
}

#[tokio::test]
async fn assert_model_call_contract_holds_against_recording_call() {
    let responses = canned_responses();
    let bundle = recording_call(&responses);
    let probe = probe_input(ProbeInputOverrides {
        provider: Some(format!("{FAKE_PROVIDER_PREFIX}smoothed_prompt")),
        model: Some(format!("{FAKE_MODEL_PREFIX}smoothed_prompt")),
        ..Default::default()
    });
    // Pin response text and recorded input/log (strengthen allowlisted fixture check).
    let result = (bundle.call)(probe.clone()).await;
    match result {
        ModelCallResult::Ok { text } => {
            assert_eq!(text, responses["smoothed_prompt"]);
        }
        ModelCallResult::Err { kind, message } => {
            panic!("recordingCall probe should succeed; got {kind:?}: {message}");
        }
    }
    {
        let log = bundle.log.lock().expect("log");
        assert_eq!(log.len(), 1);
        assert_eq!(log[0], probe);
    }
    assert_model_call_contract(&bundle.call, Some(probe)).await;
}
