//! LIM-67: protected visibility-boundary preview, override rendering,
//! atomic view+boundary install, and canonical message stability.
//! Ported from packages/lhc/test/protected-boundary-preview.test.ts.

mod fixtures;

use std::sync::Arc;

use fixtures::{
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    UserPromptOverrides, UserPromptPayload, ViewInjectionPoint, create_inference_callbacks_double,
    kind, set_view_injection_db_hook, temp_store, valid_event,
};
use lhc::intake_stream::{self, MessageEventInput};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorClass, OpResult};
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, PartialVisibilityBudgets, SdkViewConfig, ViewCompactParams,
};
use lhc::threads::{NewThreadInput, ThreadRef, new_thread};
use lhc::{init_lhc, messages, thread_view};
use serde_json::{Map, json};

trait ExpectOk<T> {
    fn expect_ok(self) -> T;
}
impl<T> ExpectOk<T> for OpResult<T> {
    fn expect_ok(self) -> T {
        match self {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => panic!("{}", error.reason),
        }
    }
}

fn tokens(n: usize) -> String {
    vec!["tok"; n].join(" ")
}

fn init_test_sdk() {
    let double = create_inference_callbacks_double();
    let _ = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(SdkViewConfig {
            profiles: None,
            visibility: Some(PartialVisibilityBudgets {
                max_tokens: Some(500.0),
                target_tokens: Some(80.0),
            }),
            compact_threshold: None,
        }),
    });
}

async fn create_test_thread(store: &TempStore) -> String {
    match new_thread(NewThreadInput {
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

fn tool_pair(result_tokens: usize, id: &str) -> Vec<MessageEventInput> {
    vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!(format!("{id}.txt")));
                        m
                    },
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: id.into(),
                    content: tokens(result_tokens),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ]
}

fn user_prompt(text: &str) -> MessageEventInput {
    valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload { text: text.into() }),
            ..Default::default()
        },
    )
}

async fn intake(ref_: &ThreadRef, events: Vec<MessageEventInput>) {
    let result = intake_stream::message_events(ref_.clone(), &events).await;
    if let OpResult::Err { error } = result {
        panic!("{}", error.reason);
    }
}

#[tokio::test]
async fn preview_is_read_only_monotonic_and_strictly_before_earliest_protected() {
    init_test_sdk();
    let store = temp_store();
    let file_path = create_test_thread(&store).await;
    let ref_ = ThreadRef::file_path(&file_path);

    let mut events = vec![user_prompt("old")];
    events.extend(tool_pair(40, "call-old-1"));
    events.extend(tool_pair(40, "call-old-2"));
    events.extend(tool_pair(40, "call-old-3"));
    events.push(valid_event(kind::TURN_END, Default::default()));
    events.push(user_prompt("open"));
    events.extend(tool_pair(30, "call-prot-a"));
    events.extend(tool_pair(30, "call-prot-b"));
    intake(&ref_, events).await;

    let before = thread_view::status(ref_.clone()).await.expect_ok();
    let prev = before.visibility.boundary_position;

    let preview = thread_view::preview_protected_boundary(
        ref_.clone(),
        vec!["call-prot-a".into(), "call-prot-b".into()],
        thread_view::internal::protected_boundary::ProtectedBoundaryOpts {
            target_zone_tokens: Some(50),
            compact_point_override: None,
        },
    )
    .await
    .expect_ok();
    assert_eq!(preview.previous_boundary, prev);
    assert!(preview.proposed_boundary >= prev);
    let earliest = preview
        .earliest_protected_result_order
        .expect("protected results present");
    assert!(preview.proposed_boundary < earliest);
    assert_eq!(
        preview.protected_tool_call_ids,
        vec!["call-prot-a".to_string(), "call-prot-b".to_string()]
    );
    assert!(preview.full_protected_token_estimate > 0);

    // Durable boundary unchanged (read-only).
    let after = thread_view::status(ref_.clone()).await.expect_ok();
    assert_eq!(after.visibility.boundary_position, prev);
}

#[tokio::test]
async fn atomic_install_advances_view_and_boundary_together_and_a_moved_pin_recomputes() {
    init_test_sdk();
    let store = temp_store();
    let file_path = create_test_thread(&store).await;
    let ref_ = ThreadRef::file_path(&file_path);

    let mut events = vec![user_prompt("t1")];
    events.extend(tool_pair(50, "old-1"));
    events.extend(tool_pair(50, "old-2"));
    events.push(valid_event(kind::TURN_END, Default::default()));
    events.push(user_prompt("t2"));
    events.extend(tool_pair(20, "prot-1"));
    intake(&ref_, events).await;

    let status0 = thread_view::status(ref_.clone()).await.expect_ok();
    let prev_boundary = status0.visibility.boundary_position;

    let preview = thread_view::preview_protected_boundary(
        ref_.clone(),
        vec!["prot-1".into()],
        thread_view::internal::protected_boundary::ProtectedBoundaryOpts {
            target_zone_tokens: Some(30),
            compact_point_override: None,
        },
    )
    .await
    .expect_ok();

    let prepared = thread_view::prepare_compact(
        ref_.clone(),
        thread_view::CompactOpts {
            profile: None,
            params: None,
            signal: None,
            compact_point_upper_bound: None,
        },
    )
    .await
    .expect_ok();

    let installed = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared,
        thread_view::InstallPreparedOptions {
            visibility_boundary: Some(preview.proposed_boundary),
            expected_previous_boundary: Some(prev_boundary),
            ..Default::default()
        },
    )
    .await;
    let _receipt = match installed {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("install failed: {}", error.reason),
    };

    let status1 = thread_view::status(ref_.clone()).await.expect_ok();
    assert_eq!(
        status1.visibility.boundary_position,
        preview.proposed_boundary
    );
    assert!(status1.visibility.boundary_position >= prev_boundary);

    // Protected result remains full in rendered context; only older
    // unprotected results may be abridged.
    let context = thread_view::get_llm_request_context(ref_.clone())
        .await
        .expect_ok();
    for message in &context.messages {
        let text: String = message.content.iter().map(|c| c.text.as_str()).collect();
        if text.contains(" · abridged]") {
            assert!(!text.contains("prot-1"));
        }
    }

    // Canonical messages remain verbatim (never abridged by the boundary).
    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let tool_results: Vec<_> = listed
        .iter()
        .filter(|m| m.kind.as_str() == "tool_result")
        .collect();
    assert!(!tool_results.is_empty());
    for m in &tool_results {
        let body = lhc::shared_tech::js_json::js_json_stringify_of(m).unwrap();
        assert!(!body.contains(" · abridged]"));
    }

    // A pinned boundary that has since moved recomputes against fresh state
    // and installs, instead of handing the host a refusal.
    let prepared2 = thread_view::prepare_compact(
        ref_.clone(),
        thread_view::CompactOpts {
            profile: None,
            params: None,
            signal: None,
            compact_point_upper_bound: None,
        },
    )
    .await
    .expect_ok();
    let drifted = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared2,
        thread_view::InstallPreparedOptions {
            visibility_boundary: Some(preview.proposed_boundary + 1),
            expected_previous_boundary: Some(prev_boundary), // stale: the first install already advanced it
            ..Default::default()
        },
    )
    .await
    .expect_ok();

    let installed_view = thread_view::describe(ref_.clone()).await.expect_ok();
    assert_eq!(
        installed_view.map(|v| v.view_id),
        Some(drifted.view_id.clone())
    );

    let status2 = thread_view::status(ref_.clone()).await.expect_ok();
    // Forward only: never behind the boundary already installed, never behind
    // the compact point it was installed with.
    assert!(status2.visibility.boundary_position >= preview.proposed_boundary);
    assert!(status2.visibility.boundary_position >= drifted.compact_point);
}

#[tokio::test]
async fn a_boundary_proposal_computed_against_older_state_is_resolved_forward_not_refused() {
    init_test_sdk();
    let store = temp_store();
    let file_path = create_test_thread(&store).await;
    let ref_ = ThreadRef::file_path(&file_path);

    let mut events = vec![user_prompt("t1")];
    events.extend(tool_pair(50, "fwd-1"));
    events.extend(tool_pair(50, "fwd-2"));
    events.push(valid_event(kind::TURN_END, Default::default()));
    events.push(user_prompt("t2"));
    events.extend(tool_pair(20, "fwd-3"));
    events.push(valid_event(kind::TURN_END, Default::default()));
    events.push(user_prompt("t3"));
    events.extend(tool_pair(20, "fwd-4"));
    intake(&ref_, events).await;

    let params = || ViewCompactParams {
        lower_bound: Some(100.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(20.0),
            smooth: Some(40.0),
            detailed: Some(20.0),
            brief: Some(20.0),
        }),
        newest_closed_protection: None,
    };
    let opts = || thread_view::CompactOpts {
        profile: None,
        params: Some(params()),
        signal: None,
        compact_point_upper_bound: None,
    };
    thread_view::compact(ref_.clone(), opts()).await.expect_ok();
    let status1 = thread_view::status(ref_.clone()).await.expect_ok();
    let boundary_before = status1.visibility.boundary_position;
    assert!(boundary_before > 0);

    let prepared = thread_view::prepare_compact(ref_.clone(), opts())
        .await
        .expect_ok();
    // Boundary 0 is behind both the durable boundary and the compact point —
    // the shape a proposal takes when the state it was computed from has moved.
    let installed = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared,
        thread_view::InstallPreparedOptions {
            visibility_boundary: Some(0),
            ..Default::default()
        },
    )
    .await
    .expect_ok();

    let status2 = thread_view::status(ref_.clone()).await.expect_ok();
    assert_eq!(
        status2.visibility.boundary_position,
        boundary_before.max(installed.compact_point)
    );
}

#[tokio::test]
async fn a_failing_install_leaves_the_prior_view_and_boundary_exactly_as_they_were() {
    init_test_sdk();
    let store = temp_store();
    let file_path = create_test_thread(&store).await;
    let ref_ = ThreadRef::file_path(&file_path);

    let mut events = vec![user_prompt("t1")];
    events.extend(tool_pair(50, "old-1"));
    events.extend(tool_pair(50, "old-2"));
    events.push(valid_event(kind::TURN_END, Default::default()));
    events.push(user_prompt("t2"));
    events.extend(tool_pair(20, "prot-1"));
    intake(&ref_, events).await;

    let opts = || thread_view::CompactOpts {
        profile: None,
        params: None,
        signal: None,
        compact_point_upper_bound: None,
    };
    thread_view::compact(ref_.clone(), opts()).await.expect_ok();
    let prior_view = thread_view::describe(ref_.clone()).await.expect_ok();
    let prior_status = thread_view::status(ref_.clone()).await.expect_ok();
    let prior_context = thread_view::get_llm_request_context(ref_.clone())
        .await
        .expect_ok();

    let prepared = thread_view::prepare_compact(ref_.clone(), opts())
        .await
        .expect_ok();

    // A real storage failure inside the install transaction, not a policy stop.
    set_view_injection_db_hook(
        ViewInjectionPoint::CompactInstallBeforeValidate,
        Some(Arc::new(|_db| {
            panic!("injected storage failure inside the install transaction");
        })),
    );
    let failed = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared,
        thread_view::InstallPreparedOptions::default(),
    )
    .await;
    set_view_injection_db_hook(ViewInjectionPoint::CompactInstallBeforeValidate, None);
    match failed {
        OpResult::Err { error } => assert_eq!(error.error_class, ErrorClass::SystemError),
        OpResult::Ok { .. } => panic!("a failing install must surface as a failure"),
    }

    let after_view = thread_view::describe(ref_.clone()).await.expect_ok();
    assert_eq!(after_view.map(|v| v.view_id), prior_view.map(|v| v.view_id));
    let after_status = thread_view::status(ref_.clone()).await.expect_ok();
    assert_eq!(
        after_status.visibility.boundary_position,
        prior_status.visibility.boundary_position
    );
    let after_context = thread_view::get_llm_request_context(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(
        js_json_stringify_of(&after_context.messages).unwrap(),
        js_json_stringify_of(&prior_context.messages).unwrap()
    );
}
