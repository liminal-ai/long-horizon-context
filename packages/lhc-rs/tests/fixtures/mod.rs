//! Ported from packages/lhc/test/fixtures/index.ts (+ sibling helpers).
//!
//! Pure data-construction / below-SDK helpers (valid_event, temp_store,
//! open_raw, corrupt, read_derived_forms, model_call doubles) are REAL.
//! Helpers that call the SDK are `todo!("phase 2")`.

#![allow(unused_imports)] // re-exports are selective per test binary
#![allow(dead_code)] // helpers land ahead of the suites that call them

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};

pub mod corrupt;
pub mod drain_runner;
pub mod inference_callbacks_double;
pub mod intake_seam;
pub mod lifecycle;
pub mod model_call;
pub mod read_only_delta;
pub mod seam_conformance;
pub mod threads;
pub mod valid_event;
pub mod work_handlers;

pub use corrupt::{
    NOT_JSON, corrupt_two_open_turns, poison_message_block_json, poison_message_form_json,
};
pub use inference_callbacks_double::{
    CapturedInput, CapturedLog, InferenceCallbackOpName, InferenceCallbacksDouble,
    create_inference_callbacks_double,
};
pub use intake_seam::{IntakeWalkHook, set_intake_clock, set_intake_walk_hook};
pub use lifecycle::{
    DELETE_TARGET, DELETED_MESSAGE_TEXT, EDIT_TARGET, EDITED_MESSAGE_TEXT, LIFECYCLE_PROFILE,
    LifecycleCheckpoint, LifecycleOptions, LifecyclePhases, LifecycleRun, create_lifecycle_sdk,
    run_lifecycle,
};
pub use model_call::{
    DERIVATION_TYPES, FAKE_MODEL_PREFIX, FAKE_PROVIDER_PREFIX, INFERENCE_DERIVATION_TYPES,
    ModelAssignmentOverride, canned_responses, hanging_call, recording_call, scripted_call,
    throwing_call, valid_assignments,
};
pub use read_only_delta::{ObservableState, expect_read_only, observable_state};
pub use seam_conformance::{
    ProbeInputOverrides, RoutingRunResult, assert_model_call_contract, assert_routing_through_sdk,
    probe_input,
};
pub use threads::{
    ToolRunOpts, damaged_source_thread, multi_state_thread, read_derived_forms,
    thread_with_closed_turns, thread_with_tool_run,
};
pub use valid_event::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, KindOverrides, KindToken, ModelChangeOverrides, ModelChangePayload,
    RuntimeNoteOverrides, RuntimeNotePayload, ThinkingLevelChangeOverrides,
    ThinkingLevelChangePayload, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, TurnEndPayload, UserPromptOverrides, UserPromptPayload,
    kind, valid_assistant_text, valid_assistant_thinking, valid_event, valid_event_for_kind,
    valid_event_forced, valid_event_untyped, valid_model_change, valid_runtime_note,
    valid_thinking_level_change, valid_tool_call, valid_tool_result, valid_turn_end,
    valid_user_prompt,
};
pub use work_handlers::{TestHandlerHooks, TestHandlerStartItem, register_test_work_handlers};

pub fn event_batch(kinds: &[EventKind]) -> Vec<MessageEventInput> {
    kinds.iter().map(|k| valid_event_for_kind(*k)).collect()
}

pub fn conversation_turn() -> Vec<MessageEventInput> {
    event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::ToolCall,
        EventKind::ToolResult,
        EventKind::TurnEnd,
    ])
}

#[derive(Debug)]
pub struct TempStore {
    pub dir: PathBuf,
    pub registry_path: PathBuf,
    thread_counter: AtomicU64,
}

impl TempStore {
    pub fn thread_path(&self, name: Option<&str>) -> PathBuf {
        let n = self.thread_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let label = name
            .map(str::to_string)
            .unwrap_or_else(|| format!("thread-{n}"));
        self.dir.join(format!("{label}.sqlite"))
    }

    /// Idempotent: safe if [`Drop`] also runs (or if called twice).
    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for TempStore {
    fn drop(&mut self) {
        // Panic-safe: todo! / assert unwind must not leak the temp dir.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn temp_store() -> TempStore {
    let dir = std::env::temp_dir().join(format!(
        "lhc-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create temp store dir");
    let registry_path = dir.join("registry.sqlite");
    TempStore {
        dir,
        registry_path,
        thread_counter: AtomicU64::new(0),
    }
}

/// Direct sqlite handle for below-SDK assertions. Reaches open_database (REAL).
pub fn open_raw(path: impl AsRef<Path>) -> Db {
    match open_database(path.as_ref().to_str().expect("utf-8 path")) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("open_raw failed: {}", error.reason),
    }
}
