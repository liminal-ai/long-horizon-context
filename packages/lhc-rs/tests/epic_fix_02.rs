//! Ported from packages/lhc/test/epic-fix-02.test.ts. Phase 1.
//!
//! Epic 02 Fix Batch 001 — Green-phase regression suite for the canonical
//! epic review's two blockers (impl-lead ruling epic-fix-001).
//!
//!   - EPIC-02-BLOCK-001: per-SDK-instance poke/touch scoping
//!   - EPIC-02-BLOCK-002a/b: the call/result pair is a source dependency

mod fixtures;

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, InferenceCallbackOpName,
    InferenceCallbacksDouble, TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload,
    create_inference_callbacks_double, kind, open_raw, read_derived_forms, temp_store, valid_event,
};
use lhc::messages::RemoveInput;
use lhc::shared_tech::derivation::{LeaseConfig, SdkConfig, SdkMode, SubjectKind};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::scheduler::{DrainDisposition, SchedulerMode};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, count_live_items, init_lhc, set_scheduler_poke, set_thread_touch, threads};

/// Panic-safe global-seam + store cleanup (TS afterEach).
struct Epic02Cleanup {
    store: TempStore,
}

impl Drop for Epic02Cleanup {
    fn drop(&mut self) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_scheduler_poke(None);
        }));
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_thread_touch(None);
        }));
        self.store.cleanup();
    }
}

fn setup() -> Epic02Cleanup {
    Epic02Cleanup {
        store: temp_store(),
    }
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn until(pred: impl Fn() -> bool, what: &str, timeout_ms: u64) {
    let start = std::time::Instant::now();
    while !pred() {
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            panic!("timed out waiting for {what}");
        }
        sleep_ms(5).await;
    }
}

async fn new_thread(store: &TempStore, name: &str) -> String {
    match threads::new_thread(NewThreadInput {
        file_path: store.thread_path(Some(name)).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

fn sdk_for(double: &InferenceCallbacksDouble, mode: SdkMode) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode,
        clock: None,
        guards: None,
        tool_result: None,
        lease: Some(LeaseConfig { duration_ms: 1000 }),
        chunk_policy: None,
        view: None,
    })
}

fn live_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let n = count_live_items(&db);
    db.close();
    n
}

fn form_key(subject_kind: SubjectKind, subject_id: &str, derivation_type: &str) -> String {
    format!(
        "{}/{}/{}",
        subject_kind.as_str(),
        subject_id,
        derivation_type
    )
}

// ── EPIC-02-BLOCK-001 ─────────────────────────────────────────────

#[tokio::test]
async fn background_then_manual_on_different_threads_the_manual_threads_rows_stay_queued_until_explicit_drain()
 {
    let ctx = setup();
    let store = &ctx.store;

    let bg_double = create_inference_callbacks_double();
    let sdk_bg = sdk_for(&bg_double, SdkMode::Background);
    let man_double = create_inference_callbacks_double();
    let sdk_man = sdk_for(&man_double, SdkMode::Manual);

    let thread_b = new_thread(store, "bg").await;
    let thread_m = new_thread(store, "man").await;

    let queued = sdk_man
        .intake_stream
        .message_events(
            ThreadRef::file_path(&thread_m),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides::default(),
            )],
        )
        .await;
    assert!(queued.is_ok());

    let bg_batch = sdk_bg
        .intake_stream
        .message_events(
            ThreadRef::file_path(&thread_b),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides::default(),
            )],
        )
        .await;
    assert!(bg_batch.is_ok());
    sdk_bg.drain_settled(ThreadRef::file_path(&thread_b)).await;

    sleep_ms(50).await;

    assert_eq!(live_count(&thread_m), 1);
    assert_eq!(
        read_derived_forms(&thread_m)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["pending"]
    );

    assert_eq!(live_count(&thread_b), 0);
    assert_eq!(
        read_derived_forms(&thread_b)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["ready"]
    );

    let report = sdk_man
        .work
        .drain(ThreadRef::file_path(&thread_m), None)
        .await;
    assert!(report.is_ok());
    assert_eq!(live_count(&thread_m), 0);
    assert_eq!(
        read_derived_forms(&thread_m)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["ready"]
    );
}

#[tokio::test]
async fn manual_then_background_isolates_the_manual_sdk_the_same_way() {
    let ctx = setup();
    let store = &ctx.store;

    let man_double = create_inference_callbacks_double();
    let sdk_man = sdk_for(&man_double, SdkMode::Manual);
    let bg_double = create_inference_callbacks_double();
    let sdk_bg = sdk_for(&bg_double, SdkMode::Background);
    assert_eq!(sdk_bg.scheduler.mode, SchedulerMode::Background);

    let thread_m = new_thread(store, "man").await;
    let queued = sdk_man
        .intake_stream
        .message_events(
            ThreadRef::file_path(&thread_m),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides::default(),
            )],
        )
        .await;
    assert!(queued.is_ok());

    sleep_ms(50).await;
    assert_eq!(live_count(&thread_m), 1);
    assert_eq!(
        read_derived_forms(&thread_m)
            .iter()
            .map(|f| f.state.as_str())
            .collect::<Vec<_>>(),
        vec!["pending"]
    );
}

// ── EPIC-02-BLOCK-002 ─────────────────────────────────────────────

async fn tool_run_thread(store: &TempStore, sdk: &Lhc) -> String {
    let file_path = new_thread(store, "toolrun").await;
    let batch = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(kind::USER_PROMPT, UserPromptOverrides::default()),
                valid_event(kind::TOOL_CALL, ToolCallOverrides::default()),
                valid_event(kind::TOOL_RESULT, ToolResultOverrides::default()),
                valid_event(kind::ASSISTANT_TEXT, AssistantTextOverrides::default()),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(batch.is_ok());
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());
    file_path
}

#[tokio::test]
async fn deleting_a_tool_result_drops_only_its_tool_result_summary() {
    let ctx = setup();
    let store = &ctx.store;

    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double, SdkMode::Manual);
    let file_path = tool_run_thread(store, &sdk).await;

    let before = read_derived_forms(&file_path);
    let result_before = before
        .iter()
        .find(|f| f.subject_id == "m3" && f.derivation_type == "tool_result_summary");
    assert_eq!(result_before.map(|f| f.state.as_str()), Some("ready"));
    let prompt_before = before
        .iter()
        .find(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt")
        .cloned();

    let result = sdk
        .messages
        .remove(
            ThreadRef::file_path(&file_path),
            RemoveInput {
                message_id: "m3".into(),
            },
        )
        .await;
    assert!(result.is_ok());
    let OpResult::Ok { value } = result else {
        return;
    };
    assert_eq!(
        value
            .dropped
            .iter()
            .map(|e| form_key(e.subject_kind, &e.subject_id, &e.derivation_type))
            .collect::<Vec<_>>(),
        vec!["message/m3/tool_result_summary".to_string()]
    );

    let rebuild = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(rebuild.is_ok());
    let after = read_derived_forms(&file_path);

    let prompt_after = after
        .iter()
        .find(|f| f.subject_id == "m1" && f.derivation_type == "smoothed_prompt");
    assert_eq!(prompt_after, prompt_before.as_ref());
    assert_eq!(live_count(&file_path), 0);
}

// ── FIX-2 ─────────────────────────────────────────────────────────

#[tokio::test]
async fn prompt_call_result_call_result_text_call_result_exactly_two_run_parts_sizes_2_and_1() {
    let ctx = setup();
    let store = &ctx.store;

    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double, SdkMode::Manual);
    let file_path = new_thread(store, "grouping").await;

    let call = |id: &str| {
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: id.into(),
                    tool_name: "run_cmd".into(),
                    arguments: serde_json::json!({"id": id}).as_object().unwrap().clone(),
                }),
                ..Default::default()
            },
        )
    };
    let result = |id: &str| {
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: id.into(),
                    content: format!("out {id}"),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        )
    };

    let batch = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "do work".into(),
                        }),
                        ..Default::default()
                    },
                ),
                call("a"),
                result("a"),
                call("b"),
                result("b"),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: "mid-turn note".into(),
                        }),
                        ..Default::default()
                    },
                ),
                call("c"),
                result("c"),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(batch.is_ok());
    assert!(
        sdk.work
            .drain(ThreadRef::file_path(&file_path), None)
            .await
            .is_ok()
    );

    let rendering = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "t1" && f.derivation_type == "turn_rendering");
    let run_text = rendering
        .as_ref()
        .and_then(|f| f.content.as_deref())
        .unwrap_or("");
    let re = regex::Regex::new(r"\[tool run · [^\]]+\]").unwrap();
    let run_headers: Vec<&str> = re.find_iter(run_text).map(|m| m.as_str()).collect();
    assert_eq!(run_headers.len(), 2);
    assert!(run_headers[0].contains("2 calls"));
    assert!(run_headers[1].contains("1 call"));
    assert!(rendering.as_ref().unwrap().metadata.is_none());
}

#[tokio::test]
async fn a_mixed_outcome_run_stays_explicit_and_names_the_failure() {
    let ctx = setup();
    let store = &ctx.store;

    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double, SdkMode::Manual);
    let file_path = new_thread(store, "mixed").await;
    let batch = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "edit two".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "ok".into(),
                            tool_name: "edit_file".into(),
                            arguments: serde_json::json!({"path": "ok.txt"})
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
                            tool_call_id: "ok".into(),
                            content: "edited ok.txt".into(),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "bad".into(),
                            tool_name: "edit_file".into(),
                            arguments: serde_json::json!({"path": "ro.txt"})
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
                            tool_call_id: "bad".into(),
                            content: "permission denied".into(),
                            is_error: Some(true),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(batch.is_ok());
    assert!(
        sdk.work
            .drain(ThreadRef::file_path(&file_path), None)
            .await
            .is_ok()
    );

    let rendering = read_derived_forms(&file_path)
        .into_iter()
        .find(|f| f.subject_id == "t1" && f.derivation_type == "turn_rendering");
    let run_text = rendering
        .as_ref()
        .and_then(|f| f.content.as_deref())
        .unwrap_or("");
    assert!(run_text.contains("[tool run · edit_file · 2 calls · 1 succeeded, 1 failed]"));
    assert!(rendering.as_ref().unwrap().metadata.is_none());
}

// ── FIX-3.3 (it.skip → #[ignore]) ─────────────────────────────────

#[tokio::test]
#[ignore = "skipped in TS source (it.skip)"]
async fn completing_the_straggler_after_the_delete_discards_as_stale_discarded_tombstone_and_cascade_stand()
 {
    let ctx = setup();
    let store = &ctx.store;

    let double = create_inference_callbacks_double();
    let sdk = sdk_for(&double, SdkMode::Manual);
    let file_path = new_thread(store, "straggler").await;
    let batch = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "prompt".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "k".into(),
                            tool_name: "run_cmd".into(),
                            arguments: serde_json::Map::new(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: "k".into(),
                            content: "ok ".repeat(1500),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(batch.is_ok());

    double.delay_kind("tool_result_summary", 400);
    let captured = double.capture_inputs();
    // WorkSurface clones via Arc<InstanceSeam>; move a clone + path into the
    // spawn so drain does not borrow `sdk` across the concurrent delete
    // (TS Promise race).
    let work = sdk.work.clone();
    let drain_path = file_path.clone();
    let drain_handle =
        tokio::spawn(async move { work.drain(ThreadRef::file_path(&drain_path), None).await });
    until(
        || {
            captured
                .snapshot()
                .iter()
                .any(|c| c.op == InferenceCallbackOpName::SummarizeToolResult)
        },
        "m3's tool_result_summary to be claimed and in-handler",
        3000,
    )
    .await;

    let deleted = sdk
        .messages
        .remove(
            ThreadRef::file_path(&file_path),
            RemoveInput {
                message_id: "m3".into(),
            },
        )
        .await;
    assert!(deleted.is_ok());
    let OpResult::Ok { value: deleted_val } = deleted else {
        return;
    };
    assert!(
        deleted_val
            .dropped
            .iter()
            .map(|e| form_key(e.subject_kind, &e.subject_id, &e.derivation_type))
            .any(|k| k == "message/m3/tool_result_summary")
    );

    let drained = drain_handle.await.expect("drain join");
    assert!(drained.is_ok());
    let OpResult::Ok { value: drained_val } = drained else {
        return;
    };
    let m3_item = drained_val
        .ran
        .iter()
        .find(|r| r.work_item_id == "w-m3-tool_result_summary-v1");
    assert_eq!(
        m3_item.map(|r| r.disposition),
        Some(DrainDisposition::StaleDiscarded)
    );

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed_val } = listed else {
        return;
    };
    assert!(!listed_val.iter().any(|m| m.message_id == "m3"));
    assert!(
        !read_derived_forms(&file_path)
            .iter()
            .any(|f| f.subject_id == "m3")
    );
    assert_eq!(live_count(&file_path), 0);
}
