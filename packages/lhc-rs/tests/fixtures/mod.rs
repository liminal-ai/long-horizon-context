//! Ported from packages/lhc/test/fixtures/index.ts (+ sibling helpers).
//!
//! Pure data-construction / below-SDK helpers (valid_event, temp_store,
//! open_raw, corrupt, read_derived_forms, model_call doubles) are REAL.
//! Helpers that call the SDK are `todo!("phase 2")`.

#![allow(unused_imports)] // re-exports are selective per test binary
#![allow(dead_code)] // helpers land ahead of the suites that call them

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{Db, open_database};

#[cfg(feature = "test-util")]
mod compact_continuation_seam;
pub mod corrupt;
pub mod drain_runner;
pub mod inference_callbacks_double;
pub mod intake_seam;
pub mod lifecycle;
pub mod model_call;
pub mod pi_session_format;
pub mod read_only_delta;
pub mod seam_conformance;
pub mod threads;
pub mod turn_parts;
pub mod valid_event;
pub mod view_boundary;
pub mod view_seam;
pub mod view_thread;
pub mod work_handlers;

#[cfg(feature = "test-util")]
pub use compact_continuation_seam::{
    CompactContinuationTestHooks, force_clear_writer, run_compact_continuation_for_tests,
    seed_writer_claim,
};
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
    DERIVATION_TYPES, DerivationType, FAKE_MODEL_PREFIX, FAKE_PROVIDER_PREFIX,
    INFERENCE_DERIVATION_TYPES, InferenceAssignments, InferenceDerivationType,
    ModelAssignmentOverride, canned_responses, hanging_call, recording_call, scripted_call,
    throwing_call, valid_assignments,
};
pub use pi_session_format::{assert_pi_session_conformance, load_pi_session_fixture};
pub use read_only_delta::{ObservableState, expect_read_only, observable_state};
pub use seam_conformance::{
    ProbeInputOverrides, RoutingRunResult, assert_model_call_contract, assert_routing_through_sdk,
    probe_input,
};
pub use threads::{
    ChunkSnapshot, ChunkSnapshotChunk, ChunkSnapshotMember, FormStateTarget, FormStateUpdate,
    GAPPED_SMOOTHING_REASON, GappedRenderingThreadResult, MultiStateClaim, ToolRunOpts,
    damaged_source_thread, gapped_rendering_thread, multi_state_thread, read_chunks,
    read_derived_forms, set_form_state, thread_with_closed_turns, thread_with_tool_run,
};
pub use valid_event::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, CompactContinuationMarkerOverrides, CompactContinuationMarkerPayload,
    KindOverrides, KindToken, ModelChangeOverrides, ModelChangePayload, RuntimeNoteOverrides,
    RuntimeNotePayload, ThinkingLevelChangeOverrides, ThinkingLevelChangePayload,
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload, TurnEndOverrides,
    TurnEndPayload, UserPromptOverrides, UserPromptPayload, kind, valid_assistant_text,
    valid_assistant_thinking, valid_event, valid_event_for_kind, valid_event_forced,
    valid_event_untyped, valid_model_change, valid_runtime_note, valid_thinking_level_change,
    valid_tool_call, valid_tool_result, valid_turn_end, valid_user_prompt,
};
pub use view_boundary::{
    TurnedToolResultsSpec, boundary_tokens, boundary_tool_run, seed_turned_tool_results,
    turned_tool_result_events,
};
pub use view_seam::{
    ViewInjectionDbHook, ViewInjectionHook, ViewInjectionPoint, fire_view_injection,
    fire_view_injection_with_db, seed_view_boundary, set_view_injection_db_hook,
    set_view_injection_hook,
};
pub use view_thread::{
    DerivedThreadFixture, DerivedThreadOptions, MixedStateFixture, MutationInFlightFixture,
    PERMANENT_FAILURE_REASON, RATE_LIMIT_FAILURE_REASON, blocked_sibling_thread,
    corrupted_variant_thread, derived_thread_fixture, mixed_state_variant_thread,
    mutation_in_flight_variant,
};
pub use work_handlers::{TestHandlerHooks, register_test_work_handlers, test_work_handlers};

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

/// Process-local sequence for [`temp_store`] candidate names (Amendment F).
static TEMP_STORE_SEQ: AtomicU64 = AtomicU64::new(0);

/// TS `mkdtempSync` analogue: atomically exclusive directory creation.
///
/// Amendment F — correctness comes from `create_dir` failing on
/// `AlreadyExists` and retrying, not from assuming the candidate name is
/// unique. PID + process-local sequence only reduce collision frequency.
pub fn temp_store() -> TempStore {
    let pid = std::process::id();
    loop {
        let seq = TEMP_STORE_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("lhc-test-{pid}-{seq}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                let registry_path = dir.join("registry.sqlite");
                return TempStore {
                    dir,
                    registry_path,
                    thread_counter: AtomicU64::new(0),
                };
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => panic!("create temp store dir: {err}"),
        }
    }
}

/// Direct sqlite handle for below-SDK assertions. Reaches open_database (REAL).
pub fn open_raw(path: impl AsRef<Path>) -> Db {
    match open_database(path.as_ref().to_str().expect("utf-8 path")) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("open_raw failed: {}", error.reason),
    }
}

/// Panic-safe DB close (TS `try`/`finally` around `db.close()`).
///
/// Prefer this when asserts between `open_raw` and `close` can fail — Drop
/// still closes even if the test panics.
pub struct ClosingDb {
    inner: Option<Db>,
}

impl ClosingDb {
    pub fn open(path: impl AsRef<Path>) -> Self {
        Self {
            inner: Some(open_raw(path)),
        }
    }

    pub fn db(&self) -> &Db {
        self.inner.as_ref().expect("ClosingDb already closed")
    }
}

impl Drop for ClosingDb {
    fn drop(&mut self) {
        if let Some(db) = self.inner.take() {
            let _ = std::panic::catch_unwind(AssertUnwindSafe(move || {
                db.close();
            }));
        }
    }
}

#[cfg(feature = "test-util")]
pub use compact_continuation_seam::*;
