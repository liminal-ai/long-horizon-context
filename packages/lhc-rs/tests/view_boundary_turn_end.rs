//! Ported from packages/lhc/test/view-boundary-turn-end.test.ts. Phase 1.
//!
//! Visibility boundary: intake does not auto-advance the boundary at turn close.

mod fixtures;

use fixtures::{
    TempStore, TurnEndOverrides, TurnedToolResultsSpec, UserPromptOverrides, UserPromptPayload,
    boundary_tool_run, create_inference_callbacks_double, kind, open_raw, seed_turned_tool_results,
    temp_store, turned_tool_result_events, valid_event,
};
use lhc::intake_stream::{MessageEventInput, TurnTransitionAction};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{LlmRequestContextMessage, PartialVisibilityBudgets, SdkViewConfig};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};

const BUDGETS: PartialVisibilityBudgets = PartialVisibilityBudgets {
    max_tokens: Some(100.0),
    target_tokens: Some(60.0),
};

fn vis_sdk(view: Option<SdkViewConfig>) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(view.unwrap_or(SdkViewConfig {
            profiles: None,
            visibility: Some(BUDGETS),
            compact_threshold: None,
        })),
    })
}

async fn new_thread(sdk: &Lhc) -> (TempStore, String) {
    let store = temp_store();
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
    match created {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
    (store, file_path)
}

fn boundary_of(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let row = db.prepare("SELECT position FROM view_boundary").get();
    let position = row
        .as_ref()
        .and_then(|r| r.get("position"))
        .and_then(|v| v.as_i64())
        .expect("view_boundary.position");
    db.close();
    position
}

async fn zone_tokens_of(sdk: &Lhc, file_path: &str) -> i64 {
    let status = sdk
        .thread_view
        .status(ThreadRef::file_path(file_path))
        .await;
    match status {
        OpResult::Ok { value } => value.visibility.zone_tokens,
        OpResult::Err { error } => panic!("status failed: {}", error.reason),
    }
}

fn message_text(message: &LlmRequestContextMessage) -> String {
    message
        .content
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

fn abridged_count(messages: &[LlmRequestContextMessage]) -> usize {
    messages
        .iter()
        .filter(|m| {
            let text = message_text(m);
            text.starts_with("[tool result · ") && text.contains(" · abridged]")
        })
        .count()
}

async fn intake_raw(sdk: &Lhc, file_path: &str, events: &[MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), events)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("intake failed: {}", error.reason);
    }
}

#[tokio::test]
async fn keeps_the_boundary_at_zero_after_turn_close_even_when_the_zone_exceeds_max() {
    let sdk = vis_sdk(None);
    let (_store, file_path) = new_thread(&sdk).await;

    seed_turned_tool_results(
        &sdk,
        &file_path,
        &[TurnedToolResultsSpec {
            results: vec![30, 30],
            close: None,
        }],
    )
    .await;
    assert_eq!(boundary_of(&file_path), 0);

    intake_raw(
        &sdk,
        &file_path,
        &turned_tool_result_events(&[TurnedToolResultsSpec {
            results: vec![40, 40],
            close: Some(false),
        }]),
    )
    .await;
    intake_raw(&sdk, &file_path, &boundary_tool_run(40)).await;
    assert_eq!(boundary_of(&file_path), 0);
    assert_eq!(zone_tokens_of(&sdk, &file_path).await, 180);

    let context_read = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_read.is_ok());
    let OpResult::Ok { value: context } = context_read else {
        return;
    };
    assert_eq!(abridged_count(&context.messages), 0);

    intake_raw(
        &sdk,
        &file_path,
        &[valid_event(kind::TURN_END, TurnEndOverrides::default())],
    )
    .await;
    assert_eq!(boundary_of(&file_path), 0);
    assert_eq!(zone_tokens_of(&sdk, &file_path).await, 180);
}

#[tokio::test]
async fn does_not_advance_when_a_new_user_prompt_closes_the_previous_populated_turn() {
    let sdk = vis_sdk(None);
    let (_store, file_path) = new_thread(&sdk).await;

    seed_turned_tool_results(
        &sdk,
        &file_path,
        &[TurnedToolResultsSpec {
            results: vec![30, 30],
            close: None,
        }],
    )
    .await;
    intake_raw(
        &sdk,
        &file_path,
        &turned_tool_result_events(&[TurnedToolResultsSpec {
            results: vec![40, 40],
            close: Some(false),
        }]),
    )
    .await;

    let closed_by_prompt = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "next prompt closes the prior turn".into(),
                    }),
                    ..Default::default()
                },
            )],
        )
        .await;
    assert!(closed_by_prompt.is_ok());
    let OpResult::Ok { value } = closed_by_prompt else {
        return;
    };
    let actions: Vec<TurnTransitionAction> = value
        .turn_transitions
        .iter()
        .map(|transition| transition.action)
        .collect();
    assert_eq!(
        actions,
        vec![TurnTransitionAction::Closed, TurnTransitionAction::Opened]
    );
    assert_eq!(boundary_of(&file_path), 0);
    assert_eq!(zone_tokens_of(&sdk, &file_path).await, 140);
}
