//! Ported from packages/lhc/test/view-boundary.test.ts. Phase 1.
//!
//! Epic 03 Story 4: visibility boundary rendering and the no-auto-advance
//! intake contract. Seeded-boundary tests prove rendering respects a stored
//! position; intake never moves the boundary on its own.

mod fixtures;

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TempStore, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, create_inference_callbacks_double, kind, open_raw, seed_view_boundary,
    temp_store, valid_event,
};
use lhc::intake_stream::{BatchEventOutcome, MessageEventInput};
use lhc::messages::{MessageKind, RemoveInput};
use lhc::shared_tech::derivation::{DerivationState, SdkConfig, SdkMode, ToolResultConfig};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{
    LlmRequestContextMessage, PartialVisibilityBudgets, SdkViewConfig, ViewCompactParams,
};
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc, set_scheduler_poke};

/// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
/// so a content of n joined "tok" words carries token_estimate n.
/// Matches fixture [`boundary_tokens`]: zero → empty; negative panics.
fn tokens(n: i64) -> String {
    if n < 0 {
        panic!("Invalid count value: {n}");
    }
    if n == 0 {
        return String::new();
    }
    vec!["tok"; n as usize].join(" ")
}

const BUDGETS: PartialVisibilityBudgets = PartialVisibilityBudgets {
    max_tokens: Some(100.0),
    target_tokens: Some(60.0),
};

static HOOKS_TEST_LOCK: Mutex<()> = Mutex::new(());

struct HookGuard {
    _lock: MutexGuard<'static, ()>,
}

impl HookGuard {
    fn acquire() -> Self {
        let lock = HOOKS_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self { _lock: lock }
    }
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_scheduler_poke(None);
        }));
    }
}

fn vis_sdk(view: Option<SdkViewConfig>, mode: SdkMode) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode,
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

static CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn tool_run(result_tokens: i64) -> Vec<MessageEventInput> {
    let n = CALL_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let tool_call_id = format!("call-vb-{n}");
    let mut args = serde_json::Map::new();
    args.insert(
        "path".into(),
        serde_json::Value::String(format!("vb-{n}.txt")),
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

/// `turn_end: None` or `Some(true)` closes; `Some(false)` leaves open —
/// matches TS `opts.turnEnd !== false`.
fn tool_turn(result_tokens: &[i64], turn_end: Option<bool>) -> Vec<MessageEventInput> {
    let mut events = vec![valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload {
                text: "scripted boundary turn".into(),
            }),
            ..Default::default()
        },
    )];
    for &n in result_tokens {
        events.extend(tool_run(n));
    }
    if turn_end != Some(false) {
        events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    }
    events
}

async fn intake(sdk: &Lhc, file_path: &str, batch: &[MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("intake failed: {}", error.reason);
    }
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

fn message_texts(messages: &[LlmRequestContextMessage]) -> Vec<String> {
    messages.iter().map(message_text).collect()
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

fn panic_message(err: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = err.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = err.downcast_ref::<String>() {
        return s.clone();
    }
    format!("{err:?}")
}

#[tokio::test]
async fn holds_position_below_max_then_respects_a_seeded_boundary_that_flips_the_oldest_whole_turn()
{
    let _hooks = HookGuard::acquire();
    let sdk = vis_sdk(None, SdkMode::Manual);
    let (_store, file_path) = new_thread(&sdk).await;

    intake(&sdk, &file_path, &tool_turn(&[20, 20], None)).await;
    let after_first = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(after_first.is_ok());
    let OpResult::Ok { value: after_first } = after_first else {
        return;
    };
    assert_eq!(boundary_of(&file_path), 0);

    intake(&sdk, &file_path, &tool_turn(&[20, 20], None)).await;
    let after_second = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(after_second.is_ok());
    let OpResult::Ok {
        value: after_second,
    } = after_second
    else {
        return;
    };
    assert_eq!(boundary_of(&file_path), 0);
    assert_eq!(
        &after_second.messages[..after_first.messages.len()],
        &after_first.messages[..]
    );
    assert_eq!(abridged_count(&after_second.messages), 0);

    intake(&sdk, &file_path, &tool_turn(&[20, 20], None)).await;
    let results = tool_results(&sdk, &file_path).await;
    assert_eq!(results.len(), 6);
    assert_eq!(boundary_of(&file_path), 0);

    let expected_position = match results.get(1) {
        Some(r) => r.source_event_order,
        None => 0,
    };
    seed_view_boundary(&file_path, expected_position);
    let crossed = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(crossed.is_ok());
    let OpResult::Ok { value: crossed } = crossed else {
        return;
    };
    assert_eq!(boundary_of(&file_path), expected_position);
    assert_eq!(abridged_count(&crossed.messages), 2);

    let abridged_ids: Vec<String> = results
        .iter()
        .filter(|r| r.source_event_order <= expected_position)
        .map(|r| r.message_id.clone())
        .collect();
    let expected_ids: Vec<String> = results
        .iter()
        .take(2)
        .map(|r| r.message_id.clone())
        .collect();
    assert_eq!(abridged_ids, expected_ids);

    let status = sdk
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    let expected_zone: i64 = results
        .iter()
        .filter(|r| r.source_event_order > expected_position)
        .map(|r| r.token_estimate)
        .sum();
    assert_eq!(status.visibility.zone_tokens, expected_zone);
    assert_eq!(status.visibility.zone_tokens, 80);

    intake(&sdk, &file_path, &tool_turn(&[10], None)).await;
    assert_eq!(boundary_of(&file_path), expected_position);
}

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn renders_deterministic_tool_result_floors_even_when_a_ready_summary_exists() {
    let _hooks = HookGuard::acquire();
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: Some(ToolResultConfig {
            small_tier_tokens: 1,
            small_target_ratio: 0.15,
            mid_target_ratio: 0.04,
        }),
        lease: None,
        chunk_policy: None,
        view: Some(SdkViewConfig {
            profiles: None,
            visibility: Some(BUDGETS),
            compact_threshold: None,
        }),
    });
    let (_store, file_path) = new_thread(&sdk).await;

    let mut batch = vec![valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload {
                text: "flip rendering prompt".into(),
            }),
            ..Default::default()
        },
    )];
    batch.extend(tool_run(60));
    batch.push(valid_event(
        kind::ASSISTANT_TEXT,
        AssistantTextOverrides {
            payload: Some(AssistantTextPayload::new("interleaved assistant text")),
            ..Default::default()
        },
    ));
    batch.extend(tool_run(20));
    batch.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    intake(&sdk, &file_path, &batch).await;

    double.fail_kind(
        "tool_result_summary",
        1,
        Some("content_refusal: scripted permanent failure (boundary test)"),
    );
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let results: Vec<_> = listed
        .into_iter()
        .filter(|m| m.kind == MessageKind::ToolResult)
        .collect();
    let r1 = results.first();
    let r2 = results.get(1);
    assert!(r1.is_some() && r2.is_some());
    let (Some(r1), Some(r2)) = (r1, r2) else {
        return;
    };
    let r1_summary_state = r1.derivations.as_ref().and_then(|forms| {
        forms
            .iter()
            .find(|f| f.derivation_type == "tool_result_summary")
            .map(|f| f.state)
    });
    assert_eq!(r1_summary_state, Some(DerivationState::Ready));
    let r2_summary = r2.derivations.as_ref().and_then(|forms| {
        forms
            .iter()
            .find(|f| {
                f.derivation_type == "tool_result_summary" && f.state == DerivationState::Ready
            })
            .and_then(|f| f.content.clone())
    });
    assert!(r2_summary.is_some());

    intake(&sdk, &file_path, &tool_turn(&[80], None)).await;
    seed_view_boundary(&file_path, r2.source_event_order);

    let context_read = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_read.is_ok());
    let OpResult::Ok { value: context } = context_read else {
        return;
    };
    let contents = message_texts(&context.messages);

    assert!(contents.contains(&format!(
        "[tool result · read_file · abridged]\n{}",
        tokens(60)
    )));
    assert!(contents.contains(&format!(
        "[tool result · read_file · abridged]\n{}",
        tokens(20)
    )));
    if let Some(summary) = &r2_summary {
        assert!(!contents.contains(&format!("[tool result · read_file · abridged]\n{summary}")));
    }
    assert!(contents.iter().any(|c| c == "interleaved assistant text"));
    assert!(contents.contains(&format!("[tool result · read_file]\n{}", tokens(80))));
}

#[tokio::test]
async fn resets_a_seeded_boundary_to_the_compact_point_with_a_full_fresh_tail() {
    let _hooks = HookGuard::acquire();
    let sdk = vis_sdk(None, SdkMode::Manual);
    let (_store, file_path) = new_thread(&sdk).await;
    for _ in 0..3 {
        intake(&sdk, &file_path, &tool_turn(&[20, 20], None)).await;
    }
    let results = tool_results(&sdk, &file_path).await;
    let seeded_position = match results.get(1) {
        Some(r) => r.source_event_order,
        None => 0,
    };
    seed_view_boundary(&file_path, seeded_position);
    assert_eq!(boundary_of(&file_path), seeded_position);

    let receipt = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(40.0),
                    percentages: None,
                    newest_closed_protection: None,
                }),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value: receipt } = receipt else {
        return;
    };
    let after_compact = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(after_compact.is_ok());
    if !after_compact.is_ok() {
        return;
    }
    assert_eq!(boundary_of(&file_path), receipt.compact_point);

    intake(&sdk, &file_path, &tool_turn(&[20], None)).await;
    let fresh = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(fresh.is_ok());
    let OpResult::Ok { value: fresh } = fresh else {
        return;
    };
    assert_eq!(abridged_count(&fresh.messages), 0);
    assert!(
        message_texts(&fresh.messages)
            .contains(&format!("[tool result · read_file]\n{}", tokens(20)))
    );
}

#[test]
fn rejects_max_le_target_at_construction_naming_the_constraint() {
    let _hooks = HookGuard::acquire();
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _ = vis_sdk(
            Some(SdkViewConfig {
                profiles: None,
                visibility: Some(PartialVisibilityBudgets {
                    max_tokens: Some(100.0),
                    target_tokens: Some(200.0),
                }),
                compact_threshold: None,
            }),
            SdkMode::Manual,
        );
    }));
    let Err(err) = result else {
        panic!("init_lhc must reject max ≤ target");
    };
    let msg = panic_message(err);
    if msg.contains("phase 2") || msg.contains("not yet implemented") {
        panic!("{msg}");
    }
    assert!(
        msg.contains("maxTokens (100) must be greater than targetTokens (200)"),
        "expected constraint name in panic, got {msg}"
    );
}

#[tokio::test]
async fn background_mode_intake_commits_over_max_tool_results_with_boundary_unchanged_and_drain_still_runs()
 {
    let _hooks = HookGuard::acquire();
    let sdk = vis_sdk(
        Some(SdkViewConfig {
            profiles: None,
            visibility: Some(BUDGETS),
            compact_threshold: None,
        }),
        SdkMode::Background,
    );
    let (_store, file_path) = new_thread(&sdk).await;

    let mut batch = tool_turn(&[40], None);
    batch.extend(tool_turn(&[40], None));
    batch.extend(tool_turn(&[40], None));
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &batch)
        .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert!(
        value
            .events
            .iter()
            .all(|e| e.outcome == BatchEventOutcome::Recorded)
    );

    let results = tool_results(&sdk, &file_path).await;
    assert_eq!(results.len(), 3);
    assert_eq!(boundary_of(&file_path), 0);
    let status = sdk
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    assert_eq!(status.visibility.zone_tokens, 120);
    assert!((status.visibility.zone_tokens as f64) > status.visibility.max_tokens);

    sdk.drain_settled(ThreadRef::file_path(&file_path)).await;
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    for m in listed
        .iter()
        .filter(|msg| msg.kind == MessageKind::ToolResult)
    {
        let state = m.derivations.as_ref().and_then(|forms| {
            forms
                .iter()
                .find(|f| f.derivation_type == "tool_result_summary")
                .map(|f| f.state)
        });
        assert_eq!(state, Some(DerivationState::Ready));
    }
}

#[tokio::test]
async fn drops_a_deleted_zone_result_from_the_live_sum() {
    let _hooks = HookGuard::acquire();
    let sdk = vis_sdk(None, SdkMode::Manual);
    let (_store, file_path) = new_thread(&sdk).await;
    intake(&sdk, &file_path, &tool_turn(&[40, 40], None)).await;
    assert_eq!(boundary_of(&file_path), 0);

    let results = tool_results(&sdk, &file_path).await;
    let message_id = match results.first() {
        Some(r) => r.message_id.clone(),
        None => String::new(),
    };
    let deleted = sdk
        .messages
        .remove(ThreadRef::file_path(&file_path), RemoveInput { message_id })
        .await;
    assert!(deleted.is_ok());
    let status = sdk
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    assert_eq!(status.visibility.zone_tokens, 40);
}

/// TS `it.each(["manual", "background"])` unfolded for independent cleanup
/// (Phase-gate Wave 2 hygiene). Assertions and cases unchanged.
#[tokio::test]
async fn manual_mode_sdk_intake_does_not_auto_advance_the_boundary() {
    let _hooks = HookGuard::acquire();
    host_mode_sdk_intake_does_not_auto_advance_the_boundary_case(SdkMode::Manual).await;
}

#[tokio::test]
async fn background_mode_sdk_intake_does_not_auto_advance_the_boundary() {
    let _hooks = HookGuard::acquire();
    host_mode_sdk_intake_does_not_auto_advance_the_boundary_case(SdkMode::Background).await;
}

async fn host_mode_sdk_intake_does_not_auto_advance_the_boundary_case(mode: SdkMode) {
    let sdk = vis_sdk(
        Some(SdkViewConfig {
            profiles: None,
            visibility: Some(BUDGETS),
            compact_threshold: None,
        }),
        mode,
    );
    let (_store, file_path) = new_thread(&sdk).await;
    let mut batch = tool_turn(&[40], None);
    batch.extend(tool_turn(&[40], None));
    batch.extend(tool_turn(&[40], None));
    intake(&sdk, &file_path, &batch).await;
    assert_eq!(boundary_of(&file_path), 0);
    if mode == SdkMode::Background {
        sdk.drain_settled(ThreadRef::file_path(&file_path)).await;
    }
}
