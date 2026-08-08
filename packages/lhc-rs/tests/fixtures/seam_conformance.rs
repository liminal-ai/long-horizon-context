//! Ported from packages/lhc/test/fixtures/seam-conformance.ts. Phase 1.
//!
//! Parameterized seam-contract assertions (Epic 05 DD-13): the same helpers
//! run against the scripted fakes (TC-1.2) and, unchanged, against the real
//! host (TC-4.3). `probe_input` and `assert_model_call_contract` are REAL.
//! SDK-driving helpers are Phase 1 not-implemented at the first behavior
//! boundary (`todo!("phase 2")`).

use std::sync::{Arc, Mutex};

use lhc::Lhc;
use lhc::sdk::init_lhc;
use lhc::shared_tech::derivation::{ChunkPolicyConfig, Derivation, SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{
    DerivationGuards, DetailedTurnCompressionGuards, InferenceConfig, ModelCall, ModelCallInput,
    ModelCallMessage, ModelCallMessageRole, ModelCallResult, ThinkingLevel,
};
use lhc::shared_tech::scheduler::DrainStoppedBecause;
use lhc::threads::{NewThreadInput, ThreadRef};

use super::TempStore;
use super::model_call::{
    DERIVATION_TYPES, INFERENCE_DERIVATION_TYPES, InferenceAssignments, InferenceDerivationType,
};
use super::threads::read_derived_forms;
use super::{
    AssistantTextOverrides, AssistantTextPayload, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, kind, valid_event,
};

/// TS `const FAILURE_KINDS = new Set([...])` — private immutable vocabulary.
const FAILURE_KINDS: &[&str] = &[
    "rate_limit",
    "timeout",
    "network",
    "empty_output",
    "other",
    "auth",
    "invalid_request",
];

/// Partial override bag for [`probe_input`] (TS `Partial<ModelCallInput>`).
#[derive(Debug, Clone, Default)]
pub struct ProbeInputOverrides {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub messages: Option<Vec<ModelCallMessage>>,
    /// Canonical thinking vocabulary — never a bare string.
    pub thinking: Option<ThinkingLevel>,
}

/// Pure data construction — REAL.
pub fn probe_input(overrides: ProbeInputOverrides) -> ModelCallInput {
    ModelCallInput {
        provider: overrides
            .provider
            .unwrap_or_else(|| "probe-provider".into()),
        model: overrides.model.unwrap_or_else(|| "probe-model".into()),
        messages: overrides.messages.unwrap_or_else(|| {
            vec![
                ModelCallMessage {
                    role: ModelCallMessageRole::System,
                    content: "You answer with one word.".into(),
                },
                ModelCallMessage {
                    role: ModelCallMessageRole::User,
                    content: "Say ok.".into(),
                },
            ]
        }),
        thinking: overrides.thinking,
    }
}

/// AC-1.2 result contract on one probe call — REAL (host boundary only).
pub async fn assert_model_call_contract(call: &ModelCall, probe: Option<ModelCallInput>) {
    let probe = probe.unwrap_or_else(|| probe_input(ProbeInputOverrides::default()));
    let result = call(probe).await;
    match result {
        ModelCallResult::Ok { text } => {
            // TS `typeof result.text === "string"`
            let _: &str = text.as_str();
        }
        ModelCallResult::Err { kind, message } => {
            assert!(
                FAILURE_KINDS.contains(&kind.as_str()),
                "failure kind \"{}\" is not in the failure vocabulary",
                kind.as_str()
            );
            // TS `typeof result.message === "string"`
            let _: &str = message.as_str();
        }
    }
}

/// TS `RoutingRunResult` — named Rust return with `file_path`.
pub struct RoutingRunResult {
    pub sdk: Lhc,
    pub file_path: String,
    pub derivations: Vec<Derivation>,
    /// Shared log for concurrent capture; Phase 2 fills it via structuredClone.
    pub log: Arc<Mutex<Vec<ModelCallInput>>>,
}

/// Private TS `seedAllSevenKinds`.
#[allow(dead_code)]
async fn seed_all_seven_kinds(sdk: &Lhc, store: &TempStore) -> String {
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(
        created.is_ok(),
        "conformance fixture: thread creation failed"
    );
    let mut args = serde_json::Map::new();
    args.insert(
        "path".into(),
        serde_json::Value::String("fixture.txt".into()),
    );
    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
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
                            tool_call_id: "call-seam-1".into(),
                            tool_name: "read_file".into(),
                            arguments: args,
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: "call-seam-1".into(),
                            content: ("contents of fixture.txt ".repeat(1500)),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new(
                            "the fixture file holds fixture text",
                        )),
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
                        payload: Some(AssistantTextPayload::new("summarized")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(result.is_ok(), "conformance fixture: intake batch failed");
    file_path
}

/// TC-1.2 routing assertions extracted for TC-4.3 reuse.
pub async fn assert_routing_through_sdk(
    call: ModelCall,
    assignments: InferenceAssignments,
    store: &TempStore,
) -> RoutingRunResult {
    let log: Arc<Mutex<Vec<ModelCallInput>>> = Arc::new(Mutex::new(Vec::new()));
    let log_for_call = Arc::clone(&log);
    let logged: ModelCall = Arc::new(move |input| {
        let call = Arc::clone(&call);
        let log_for_call = Arc::clone(&log_for_call);
        Box::pin(async move {
            log_for_call
                .lock()
                .expect("routing log")
                .push(input.clone());
            call(input).await
        })
    });

    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call: logged,
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
        chunk_policy: Some(ChunkPolicyConfig {
            target_projected_tokens: 5,
            max_projected_tokens: 4400,
        }),
        view: None,
    });
    let file_path = seed_all_seven_kinds(&sdk, store).await;

    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok(), "conformance drain failed");
    let OpResult::Ok { value: drained } = drained else {
        unreachable!()
    };
    assert_eq!(
        drained.stopped_because,
        DrainStoppedBecause::Empty,
        "conformance drain left work behind"
    );
    assert_eq!(
        drained.remaining, 0,
        "conformance drain left items remaining"
    );

    let forms = read_derived_forms(&file_path);
    for kind in DERIVATION_TYPES {
        assert!(
            forms
                .iter()
                .any(|form| { form.derivation_type == *kind && form.state.as_str() == "ready" }),
            "expected at least one ready {kind} form after the drain"
        );
    }

    let captured = log.lock().expect("routing log").clone();
    assert!(
        !captured.is_empty(),
        "no calls crossed the ModelCall boundary"
    );
    for input in &captured {
        let matched: Vec<_> = InferenceDerivationType::ALL
            .iter()
            .copied()
            .filter(|kind| {
                let a = assignments.get(*kind);
                a.provider == input.provider && a.model == input.model
            })
            .collect();
        assert!(
            !matched.is_empty(),
            "call carried provider/model \"{}\"/\"{}\" matching no kind's assignment",
            input.provider,
            input.model
        );
        assert!(
            !input.messages.is_empty(),
            "a call crossed the boundary with no messages"
        );
        assert!(
            input
                .messages
                .iter()
                .any(|m| m.role == ModelCallMessageRole::User),
            "single-turn shape requires a user message"
        );
        for message in &input.messages {
            assert!(
                matches!(
                    message.role,
                    ModelCallMessageRole::System | ModelCallMessageRole::User
                ),
                "message role \"{}\" is outside the single-turn vocabulary",
                message.role.as_str()
            );
            let _: &str = message.content.as_str();
        }
    }
    for kind in InferenceDerivationType::ALL {
        let a = assignments.get(*kind);
        assert!(
            captured
                .iter()
                .any(|input| input.provider == a.provider && input.model == a.model),
            "no boundary call carried {}'s assigned provider/model lane",
            kind.as_str()
        );
    }

    RoutingRunResult {
        sdk,
        file_path,
        derivations: forms,
        log,
    }
}
