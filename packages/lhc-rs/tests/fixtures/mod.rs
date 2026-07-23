//! Ported from packages/lhc/test/fixtures/index.ts (+ sibling helpers). Phase 1.
//!
//! Pure data-construction helpers (valid_event, temp_store, …) are REAL.
//! Helpers that call the SDK or open real DB seams beyond open_raw are
//! skeletons (or thin wrappers that reach a skeleton).
//!
//! Wave 1: REAL builders + re-exports Wave 1 tests need. Later-wave helpers
//! are PARTIAL stubs in sibling modules.

#![allow(unused_imports)] // re-exports are selective per test binary

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};

pub mod inference_callbacks_double;
pub mod model_call;
pub mod threads;
pub mod valid_event;
pub mod work_handlers;

pub use inference_callbacks_double::{
    CapturedInput, InferenceCallbackOpName, InferenceCallbacksDouble,
    create_inference_callbacks_double,
};
pub use model_call::{
    DERIVATION_TYPES, FAKE_MODEL_PREFIX, FAKE_PROVIDER_PREFIX, INFERENCE_DERIVATION_TYPES,
    canned_responses, hanging_call, recording_call, scripted_call, throwing_call,
    valid_assignments,
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
pub use work_handlers::register_test_work_handlers;

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

    pub fn cleanup(&self) {
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
