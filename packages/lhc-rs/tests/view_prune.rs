//! Ported from packages/lhc/test/view-prune.test.ts. Phase 1.
//!
//! Item 29: manual tool-result prune via the visibility boundary.

mod fixtures;

use std::sync::atomic::{AtomicU64, Ordering};

use fixtures::{
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    TurnEndOverrides, UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double,
    kind, open_raw, temp_store, valid_event,
};
use lhc::intake_stream::MessageEventInput;
use lhc::messages::MessageKind;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::view::{
    LlmRequestContextMessage, PartialVisibilityBudgets, SdkViewConfig, ViewCompactParams,
};
use lhc::thread_view::{CompactOpts, PruneParams};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};

fn tokens(n: usize) -> String {
    vec!["tok"; n].join(" ")
}

const BUDGETS_MAX: f64 = 100.0;
const BUDGETS_TARGET: f64 = 60.0;

fn vis_sdk(view: Option<SdkViewConfig>) -> Lhc {
    let view = view.unwrap_or(SdkViewConfig {
        profiles: None,
        visibility: Some(PartialVisibilityBudgets {
            max_tokens: Some(BUDGETS_MAX),
            target_tokens: Some(BUDGETS_TARGET),
        }),
        compact_threshold: None,
    });
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(view),
    })
}

async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
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
        OpResult::Ok { .. } => file_path,
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

static CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn tool_run(result_tokens: usize) -> Vec<MessageEventInput> {
    let n = CALL_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let tool_call_id = format!("call-prune-{n}");
    let mut args = serde_json::Map::new();
    args.insert(
        "path".into(),
        serde_json::Value::String(format!("prune-{n}.txt")),
    );
    vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.clone(),
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
                    tool_call_id,
                    content: tokens(result_tokens),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ]
}

#[derive(Debug, Clone, Copy)]
struct ToolTurnOpts {
    turn_end: bool,
}

impl Default for ToolTurnOpts {
    fn default() -> Self {
        Self { turn_end: true }
    }
}

fn tool_turn(result_tokens: &[usize], opts: ToolTurnOpts) -> Vec<MessageEventInput> {
    let mut events = vec![valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload {
                text: "prune turn".into(),
            }),
            ..Default::default()
        },
    )];
    for &n in result_tokens {
        events.extend(tool_run(n));
    }
    if opts.turn_end {
        events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    }
    events
}

async fn intake(sdk: &Lhc, file_path: &str, batch: Vec<MessageEventInput>) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), &batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("intake failed: {}", error.reason);
    }
}

async fn boundary_of(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let row = db
        .prepare("SELECT position FROM view_boundary")
        .get()
        .expect("view_boundary row");
    let position = row
        .get("position")
        .and_then(|v| v.as_i64())
        .expect("position");
    db.close();
    position
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolResultRow {
    message_id: String,
    source_event_order: i64,
    token_estimate: i64,
}

async fn tool_results(sdk: &Lhc, file_path: &str) -> Vec<ToolResultRow> {
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    match listed {
        OpResult::Ok { value } => value
            .into_iter()
            .filter(|m| m.kind == MessageKind::ToolResult)
            .map(|m| ToolResultRow {
                message_id: m.message_id,
                source_event_order: m.source_event_order,
                token_estimate: m.token_estimate,
            })
            .collect(),
        OpResult::Err { error } => panic!("list failed: {}", error.reason),
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

#[tokio::test]
async fn advances_boundary_from_zero_so_older_tool_results_render_short() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    intake(
        &sdk,
        &file_path,
        tool_turn(&[20, 20, 20, 20], ToolTurnOpts::default()),
    )
    .await;

    let receipt = sdk
        .thread_view
        .prune(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    assert!(!receipt.no_op);
    assert_eq!(receipt.previous_boundary, 0);
    assert_eq!(receipt.zone_tokens_before, 80);
    assert!((receipt.zone_tokens_after as f64) <= BUDGETS_TARGET);
    assert!(receipt.tool_results_pruned > 0);
    assert!(receipt.zone_tokens_before - receipt.zone_tokens_after > 0);

    let results = tool_results(&sdk, &file_path).await;
    assert_eq!(boundary_of(&file_path).await, receipt.new_boundary);
    assert_eq!(
        receipt.new_boundary,
        results.first().map(|r| r.source_event_order).unwrap_or(-1)
    );

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context.is_ok());
    let OpResult::Ok { value: context } = context else {
        return;
    };
    assert_eq!(
        abridged_count(&context.messages) as i64,
        receipt.tool_results_pruned
    );
}

#[tokio::test]
async fn starts_from_the_compact_point_boundary_and_prunes_only_the_tail_zone() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    for _ in 0..3 {
        intake(
            &sdk,
            &file_path,
            tool_turn(&[20, 20], ToolTurnOpts::default()),
        )
        .await;
    }

    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(40.0),
                    percentages: None,
                }),
                signal: None,
            },
        )
        .await;
    assert!(compacted.is_ok());
    let OpResult::Ok { value: compacted } = compacted else {
        return;
    };
    let compact_point = compacted.compact_point;
    assert_eq!(boundary_of(&file_path).await, compact_point);

    intake(
        &sdk,
        &file_path,
        tool_turn(&[20, 20, 20, 20], ToolTurnOpts::default()),
    )
    .await;
    let before = sdk
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(before.is_ok());
    let OpResult::Ok { value: before } = before else {
        return;
    };
    assert!((before.visibility.zone_tokens as f64) > BUDGETS_TARGET);

    let receipt = sdk
        .thread_view
        .prune(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    assert!(!receipt.no_op);
    assert_eq!(receipt.compact_point, compact_point);
    assert_eq!(receipt.previous_boundary, compact_point);
    assert!(receipt.new_boundary > compact_point);
    assert!((receipt.zone_tokens_after as f64) <= BUDGETS_TARGET);
}

#[tokio::test]
async fn honors_an_explicit_target() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    intake(
        &sdk,
        &file_path,
        tool_turn(&[30, 30, 30], ToolTurnOpts::default()),
    )
    .await;

    let receipt = sdk
        .thread_view
        .prune(
            ThreadRef::file_path(&file_path),
            Some(PruneParams {
                target_tokens: Some(30.0),
            }),
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    assert_eq!(receipt.target_tokens, 30.0);
    assert!(!receipt.no_op);
    assert!(receipt.zone_tokens_after <= 30);
}

#[tokio::test]
async fn rejects_non_integer_or_negative_target_tokens() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    intake(&sdk, &file_path, tool_turn(&[20], ToolTurnOpts::default())).await;

    let bad = sdk
        .thread_view
        .prune(
            ThreadRef::file_path(&file_path),
            Some(PruneParams {
                target_tokens: Some(-1.0),
            }),
        )
        .await;
    assert!(!bad.is_ok());
    let OpResult::Err { error } = bad else {
        return;
    };
    assert_eq!(error.code, ErrorCode::InvalidTargetTokens);

    // target_tokens is f64 so 10.5 type-checks (TS number / py int|float).
    let fractional = sdk
        .thread_view
        .prune(
            ThreadRef::file_path(&file_path),
            Some(PruneParams {
                target_tokens: Some(10.5),
            }),
        )
        .await;
    assert!(!fractional.is_ok());
    let OpResult::Err { error } = fractional else {
        return;
    };
    assert_eq!(error.code, ErrorCode::InvalidTargetTokens);
}

#[tokio::test]
async fn reports_no_op_when_the_zone_is_already_under_target() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    intake(
        &sdk,
        &file_path,
        tool_turn(&[20, 20], ToolTurnOpts::default()),
    )
    .await;

    let receipt = sdk
        .thread_view
        .prune(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    assert!(receipt.no_op);
    assert_eq!(receipt.zone_tokens_before, 40);
    assert_eq!(receipt.zone_tokens_after, 40);
    assert_eq!(receipt.tool_results_pruned, 0);
    assert_eq!(receipt.new_boundary, receipt.previous_boundary);
    assert_eq!(boundary_of(&file_path).await, 0);
}

#[tokio::test]
async fn does_not_move_the_boundary_backward_when_a_second_prune_uses_a_larger_target() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    let sizes = [20usize, 21, 22, 23];
    intake(&sdk, &file_path, tool_turn(&sizes, ToolTurnOpts::default())).await;

    let first = sdk
        .thread_view
        .prune(
            ThreadRef::file_path(&file_path),
            Some(PruneParams {
                target_tokens: Some(20.0),
            }),
        )
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first } = first else {
        return;
    };
    assert!(!first.no_op);
    let after_first = first.new_boundary;

    let second = sdk
        .thread_view
        .prune(
            ThreadRef::file_path(&file_path),
            Some(PruneParams {
                target_tokens: Some(60.0),
            }),
        )
        .await;
    assert!(second.is_ok());
    let OpResult::Ok { value: second } = second else {
        return;
    };
    assert!(second.no_op);
    assert_eq!(second.new_boundary, after_first);
    assert_eq!(boundary_of(&file_path).await, after_first);
}

#[tokio::test]
async fn places_the_boundary_at_the_newest_tool_result_when_it_alone_exceeds_target() {
    let store = temp_store();
    let sdk = vis_sdk(Some(SdkViewConfig {
        profiles: None,
        visibility: Some(PartialVisibilityBudgets {
            max_tokens: Some(100.0),
            target_tokens: Some(30.0),
        }),
        compact_threshold: None,
    }));
    let file_path = new_thread(&sdk, &store).await;
    intake(&sdk, &file_path, tool_turn(&[50], ToolTurnOpts::default())).await;

    let receipt = sdk
        .thread_view
        .prune(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    assert!(!receipt.no_op);
    assert_eq!(receipt.zone_tokens_after, 0);

    let results = tool_results(&sdk, &file_path).await;
    assert_eq!(
        receipt.new_boundary,
        results.first().map(|r| r.source_event_order).unwrap_or(-1)
    );

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context.is_ok());
    let OpResult::Ok { value: context } = context else {
        return;
    };
    assert_eq!(abridged_count(&context.messages), 1);
}

#[tokio::test]
async fn renders_the_tool_result_at_exactly_the_boundary_position_as_short() {
    let store = temp_store();
    let sdk = vis_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    let sizes = [20usize, 21, 22, 23];
    intake(&sdk, &file_path, tool_turn(&sizes, ToolTurnOpts::default())).await;

    let receipt = sdk
        .thread_view
        .prune(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };

    let results = tool_results(&sdk, &file_path).await;
    let boundary_result = results
        .iter()
        .find(|r| r.source_event_order == receipt.new_boundary);
    assert!(boundary_result.is_some());
    let Some(boundary_result) = boundary_result else {
        return;
    };

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context.is_ok());
    let OpResult::Ok { value: context } = context else {
        return;
    };

    let boundary_index = results
        .iter()
        .position(|result| result.message_id == boundary_result.message_id)
        .unwrap_or(usize::MAX);
    let needle = tokens(if boundary_index < sizes.len() {
        sizes[boundary_index]
    } else {
        0
    });
    let boundary_text = context
        .messages
        .iter()
        .map(message_text)
        .find(|text| text.contains(&needle));
    assert!(boundary_text.is_some());
    assert!(
        boundary_text
            .as_deref()
            .is_some_and(|t| t.contains(" · abridged]"))
    );
}
