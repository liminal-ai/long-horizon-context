//! Ported from packages/lhc/test/smoothing-recovery.test.ts. Phase 1.

mod fixtures;

use std::sync::{Arc, Mutex};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName, TempStore,
    UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double, kind, open_raw,
    read_derived_forms, temp_store, valid_event,
};
use lhc::intake_stream::QueuedWorkItem;
use lhc::messages::clean_prompt;
use lhc::shared_tech::derivation::{
    BoxFuture, Derivation, DerivationState, InferenceCallbacks, InferenceResult, LeaseConfig,
    SdkConfig, SdkMode,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, SmoothedPromptGuards};
use lhc::shared_tech::scheduler::DrainDisposition;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::work_queue::{WorkKind, WorkOwner, WorkSourceRef, count_live_items};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, threads};
use serde_json::json;

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

fn sdk_for(inference_callbacks: InferenceCallbacks, guards: Option<DerivationGuards>) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 200 }),
        chunk_policy: None,
        view: None,
    })
}

async fn send(sdk: &Lhc, file_path: &str, batch: &[lhc::intake_stream::MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("{}", error.reason);
    }
}

async fn drain(sdk: &Lhc, file_path: &str) -> lhc::shared_tech::scheduler::DrainReport {
    match sdk.work.drain(ThreadRef::file_path(file_path), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn form_of(file_path: &str, subject_id: &str, derivation_type: &str) -> Option<Derivation> {
    read_derived_forms(file_path)
        .into_iter()
        .find(|f| f.subject_id == subject_id && f.derivation_type == derivation_type)
}

fn delete_work_item(file_path: &str, work_item_id: &str) {
    let db = open_raw(file_path);
    db.prepare("DELETE FROM work_item WHERE work_item_id = ?")
        .run(&[SqlParam::from(work_item_id)]);
    db.close();
}

#[tokio::test]
async fn cleans_every_prompt_before_inference_and_invokes_smoothprompt_only_under_the_cap() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let text = "  please\t\t smooth\n\n\n this   prompt because i need it  ";
    let cleaned = "please smooth\n\nthis prompt because I need it";

    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: text.into() }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&sdk, &file_path).await;

    assert_eq!(
        captured
            .snapshot()
            .iter()
            .map(|c| (c.op, c.input.clone()))
            .collect::<Vec<_>>(),
        [(
            InferenceCallbackOpName::SmoothPrompt,
            json!({ "text": cleaned })
        )]
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(
        form.content.as_deref(),
        Some(
            deterministic_text(
                DeterministicOpName::SmoothPrompt,
                &json!({ "text": cleaned }),
                cleaned
            )
            .as_str()
        )
    );
}

#[tokio::test]
async fn skips_inference_over_the_cap_but_still_stores_the_deterministic_floor_as_ready() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(
        double.to_callbacks(),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(1),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let file_path = new_thread(&store).await;
    let fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    let text = format!("  hello    world  \n{fenced}\n  because i asked  ").repeat(8);
    let cleaned = clean_prompt(&text);

    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&sdk, &file_path).await;

    assert_eq!(captured.len(), 0);
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some(cleaned.as_str()));
    assert!(form.content.as_ref().is_some_and(|c| c.contains(fenced)));
}

#[tokio::test]
async fn keeps_the_cap_boundary_strict_equal_runs_inference_above_skips() {
    let store = temp_store();
    let equal_double = create_inference_callbacks_double();
    let equal_captured = equal_double.capture_inputs();
    let over_double = create_inference_callbacks_double();
    let over_captured = over_double.capture_inputs();
    let text = "one two three four five six seven eight nine ten";
    let token_count = estimate_tokens(text);

    let equal_sdk = sdk_for(
        equal_double.to_callbacks(),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(token_count),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let equal_file = new_thread(&store).await;
    send(
        &equal_sdk,
        &equal_file,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: text.into() }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&equal_sdk, &equal_file).await;

    let over_sdk = sdk_for(
        over_double.to_callbacks(),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(token_count - 1),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let over_file = new_thread(&store).await;
    send(
        &over_sdk,
        &over_file,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: text.into() }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&over_sdk, &over_file).await;

    assert_eq!(
        equal_captured
            .snapshot()
            .iter()
            .map(|e| e.op)
            .collect::<Vec<_>>(),
        [InferenceCallbackOpName::SmoothPrompt]
    );
    assert_eq!(over_captured.len(), 0);
}

#[tokio::test]
async fn does_not_call_inference_callbacks_during_intake_intake_only_queues_smoothing_work() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;

    let result = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "please smooth later".into(),
                    }),
                    ..Default::default()
                },
            )],
        )
        .await;

    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert_eq!(captured.len(), 0);
    assert_eq!(
        value.queued_work,
        [QueuedWorkItem {
            work_item_id: "w-m1-prompt_smoothing-v1".into(),
            owner: WorkOwner::Messages,
            kind: WorkKind::PromptSmoothing,
            source_ref: WorkSourceRef::Message {
                message_id: "m1".into(),
            },
        }]
    );
}

#[tokio::test]
async fn preserves_fenced_code_through_the_inference_path_while_cleaning_prose() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    let prompt_text = format!("plz\t\t fix this\n{fenced}\nthx");
    let inference_callback_input = Arc::new(Mutex::new(None::<String>));
    let input_slot = Arc::clone(&inference_callback_input);
    let callbacks = InferenceCallbacks {
        smooth_prompt: {
            let fenced = fenced.to_string();
            Arc::new(move |i| {
                let input_slot = Arc::clone(&input_slot);
                let fenced = fenced.clone();
                Box::pin(async move {
                    *input_slot.lock().unwrap() = Some(i.text.clone());
                    InferenceResult::Ok {
                        text: format!("Please fix this.\n{fenced}\nThanks."),
                        provenance: None,
                        request_messages: None,
                        raw_response: None,
                    }
                }) as BoxFuture<_>
            })
        },
        summarize_tool_result: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.summarize_tool_result(i).await }) as BoxFuture<_>
            })
        },
        compress_detailed_turn: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.compress_detailed_turn(i).await }) as BoxFuture<_>
            })
        },
        summarize_chunk_brief: {
            let d = double.clone();
            Arc::new(move |i| {
                let d = d.clone();
                Box::pin(async move { d.summarize_chunk_brief(i).await }) as BoxFuture<_>
            })
        },
    };
    let sdk = sdk_for(callbacks, None);
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload { text: prompt_text }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&sdk, &file_path).await;

    assert_eq!(
        inference_callback_input.lock().unwrap().as_deref(),
        Some(format!("plz fix this\n{fenced}\nthx").as_str())
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(
        form.content.as_deref(),
        Some(format!("Please fix this.\n{fenced}\nThanks.").as_str())
    );
}

#[tokio::test]
async fn pending_smoothing_uses_a_composition_floor_without_re_running_message_inference() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let captured = double.capture_inputs();
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let text = "  raw     prompt because i asked  ";
    let floor = "raw prompt because I asked";

    send(
        &sdk,
        &file_path,
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
    delete_work_item(&file_path, "w-m1-prompt_smoothing-v1");
    drain(&sdk, &file_path).await;

    let rendering = form_of(&file_path, "t1", "turn_rendering").expect("rendering");
    assert!(
        rendering
            .content
            .as_ref()
            .is_some_and(|c| c.contains(floor))
    );
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    assert_eq!(form.content.as_deref(), Some(floor));
    assert_eq!(rendering.state, DerivationState::Ready);
    assert!(
        captured
            .snapshot()
            .iter()
            .filter(|e| e.op == InferenceCallbackOpName::SmoothPrompt)
            .count()
            == 0
    );
}

#[tokio::test]
async fn smoothing_failure_lands_failed_with_reason_then_turn_composition_consumes_the_floor() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    double.fail_kind("prompt_smoothing", 99, Some("scripted failure"));
    let sdk = sdk_for(double.to_callbacks(), None);
    let file_path = new_thread(&store).await;
    let text = "  failed     prompt because i asked  ";
    let floor = "failed prompt because I asked";

    send(
        &sdk,
        &file_path,
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
    let report = drain(&sdk, &file_path).await;

    assert!(report.ran.iter().any(|entry| {
        entry.work_item_id == "w-m1-prompt_smoothing-v1"
            && entry.disposition == DrainDisposition::FailedTerminal
            && entry.reason.as_deref() == Some("scripted failure")
    }));
    let form = form_of(&file_path, "m1", "smoothed_prompt").expect("form");
    assert_eq!(form.state, DerivationState::Ready);
    let rendering = form_of(&file_path, "t1", "turn_rendering").expect("rendering");
    assert!(
        rendering
            .content
            .as_ref()
            .is_some_and(|c| c.contains(floor))
    );
    assert_eq!(rendering.state, DerivationState::Ready);
}

#[test]
fn cleanprompt_is_pure_for_deterministic_recovery_floors() {
    let input_text = "  please\tfix this because i need it\n\n\nnow  ";
    assert_eq!(
        clean_prompt(input_text),
        "please fix this because I need it\n\nnow"
    );
    assert_eq!(clean_prompt(input_text), clean_prompt(input_text));
    let fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```";
    assert_eq!(
        clean_prompt(&format!("  please\tfix\n{fenced}\n because i asked  ")),
        format!("please fix\n{fenced}\nbecause I asked")
    );
}

#[tokio::test]
async fn over_cap_deterministic_smoothing_leaves_no_live_queue_items() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = sdk_for(
        double.to_callbacks(),
        Some(DerivationGuards {
            smoothed_prompt: Some(SmoothedPromptGuards {
                max_inference_tokens: Some(1),
                suspicious_output_ratio: None,
            }),
            tool_result_summary: None,
            detailed_turn_compression: None,
        }),
    );
    let file_path = new_thread(&store).await;

    send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "hello world ".repeat(50),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    drain(&sdk, &file_path).await;

    let db = open_raw(&file_path);
    assert_eq!(count_live_items(&db), 0);
    db.close();
}
