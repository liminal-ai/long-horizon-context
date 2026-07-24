//! Ported from packages/lhc/test/fixtures/view-thread.ts. Phase 1.
//!
//! The Epic 03 derived-thread fixture (Story 0, FC-0.3/0.4/0.5): one recorded
//! conversation — 12 turns, 4 chunks, tool-heavy middle — drained through the
//! real Epic 02 machinery. Types/constants/data and below-SDK SQL helpers are
//! REAL; SDK-calling builders remain `todo!("phase 2")`.
//!
//! TS-private fixture constants (`FIXTURE_CHUNK_POLICY`, `TURN_COUNT`,
//! `TOOL_HEAVY_TURNS`) stay module-private — only exported failure-reason
//! strings are public, matching view-thread.ts. Private helpers:
//! `turn_events` / `send` / `drain` / `failed_entries` /
//! `set_message_derivation_failed`.

#![allow(dead_code)] // private helpers land ahead of Phase 2 builder bodies

use std::collections::HashSet;

use lhc::intake_stream::MessageEventInput;
use lhc::messages::MutationResult;
use lhc::sdk::Lhc;
use lhc::shared_tech::derivation::{ChunkPolicyConfig, DerivationReportEntry, DerivationState};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::{SqlParam, open_database};
use lhc::shared_tech::view::CompactReceipt;

use super::TempStore;
use super::inference_callbacks_double::InferenceCallbacksDouble;
use super::threads::ChunkSnapshot;
use super::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload, kind, valid_event,
};

// Reason classes the scripted failures stamp, chosen from the sweep
// classification table's vocabulary (tech design §Spec Validation): a
// rate-limit class reads transient, a content-refusal class reads permanent —
// FC-0.4's distinguishable-on-read-back guarantee, proven here before
// Story 3 depends on it.
pub const RATE_LIMIT_FAILURE_REASON: &str = "rate_limit: scripted failure (fixture)";
pub const PERMANENT_FAILURE_REASON: &str = "content_refusal: scripted permanent failure (fixture)";

// Chunk policy pinned so the 12 fixed-shape turns cut into exactly 4 chunks
// (3 members each; c1–c3 closed, c4 still open). Projections from the
// deterministic double are near-constant in size (`projection(<digest>:<40
// chars>)`), so the cut is stable; the builder asserts the shape and throws
// if drift ever moves it.
const FIXTURE_CHUNK_POLICY: ChunkPolicyConfig = ChunkPolicyConfig {
    target_projected_tokens: 90,
    max_projected_tokens: 4400,
};

const TURN_COUNT: i64 = 12;
const TOOL_HEAVY_TURNS: [i64; 4] = [5, 6, 7, 8];

/// Pure data builder — REAL (no SDK calls).
fn turn_events(turn: i64) -> Vec<MessageEventInput> {
    let tool_heavy: HashSet<i64> = TOOL_HEAVY_TURNS.into_iter().collect();
    let mut events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: format!("turn {turn}: please investigate area {turn}"),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides {
                payload: Some(AssistantThinkingPayload {
                    text: format!("considering what area {turn} contains"),
                }),
                ..Default::default()
            },
        ),
    ];
    if tool_heavy.contains(&turn) {
        // The tool-heavy middle: two tool runs per turn — what gives Story 4 a
        // realistic over-max zone of tool results to age behind the boundary.
        for run in [1i64, 2] {
            let tool_call_id = format!("call-fx-{turn}-{run}");
            let mut args = serde_json::Map::new();
            args.insert(
                "path".into(),
                serde_json::Value::String(format!("area-{turn}/file-{run}.txt")),
            );
            events.push(valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: tool_call_id.clone(),
                        tool_name: "read_file".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ));
            events.push(valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id,
                        content: format!(
                            "contents of area-{turn}/file-{run}.txt: detail {turn}.{run} with enough text to summarize"
                        ),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ));
        }
    }
    events.push(valid_event(
        kind::ASSISTANT_TEXT,
        AssistantTextOverrides {
            payload: Some(AssistantTextPayload {
                text: format!("findings for area {turn}"),
            }),
            ..Default::default()
        },
    ));
    events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    events
}

/// TS private `send` — PARTIAL (SDK intake).
async fn send(_sdk: &Lhc, _file_path: &str, _batch: &[MessageEventInput]) -> Vec<String> {
    todo!("phase 2")
}

/// TS private `drain` — PARTIAL (SDK work.drain).
async fn drain(_sdk: &Lhc, _file_path: &str) {
    todo!("phase 2")
}

/// TS private `failedEntries` — REAL pure filter.
fn failed_entries<'a>(
    entries: &'a [DerivationReportEntry],
    reason: &str,
) -> Vec<&'a DerivationReportEntry> {
    entries
        .iter()
        .filter(|entry| {
            entry.state == DerivationState::Failed && entry.reason.as_deref() == Some(reason)
        })
        .collect()
}

/// TS private `setMessageDerivationFailed` — REAL below-SDK SQL write.
fn set_message_derivation_failed(file_path: &str, subject_id: &str, reason: &str) {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => {
            panic!(
                "set_message_derivation_failed open failed: {}",
                error.reason
            )
        }
    };
    db.prepare(
        "UPDATE derivation
       SET state = 'failed', content = NULL, reason = ?, metadata = NULL, derived_at = ?
       WHERE subject_kind = 'message' AND subject_id = ?
         AND derivation_type = 'tool_result_summary'",
    )
    .run(&[
        SqlParam::from(reason),
        SqlParam::from("2026-01-01T00:00:00.000Z"),
        SqlParam::from(subject_id),
    ]);
    db.close();
}

/// TS `DerivedThreadFixture` — named struct; optional failure ids stay
/// `Option` (TS `?:`), never invented empty-string defaults.
pub struct DerivedThreadFixture {
    pub file_path: String,
    pub sdk: Lhc,
    pub double: InferenceCallbacksDouble,
    /// t1..t12
    pub turn_ids: Vec<String>,
    pub chunks: ChunkSnapshot,
    /// The two manufactured failed subjects (tool_result_summary forms),
    /// reached through real terminal failure — absent when failures are
    /// disabled for a variant.
    pub failed_transient_message_id: Option<String>,
    pub failed_permanent_message_id: Option<String>,
}

/// TS `DerivedThreadOptions` — `failures: None` means default true (`?? true`).
/// Construct fields explicitly (no `Default`) so call sites mirror TS option bags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedThreadOptions {
    pub failures: Option<bool>,
}

/// TS `MutationInFlightFixture` (extends DerivedThreadFixture fields).
pub struct MutationInFlightFixture {
    pub file_path: String,
    pub sdk: Lhc,
    pub double: InferenceCallbacksDouble,
    pub turn_ids: Vec<String>,
    pub chunks: ChunkSnapshot,
    pub compact_receipt: CompactReceipt,
    pub edited_message_id: String,
    /// The cascade contract's exact account of the edit: cleared set, queued
    /// replacements, superseded items — what the bracketing health reads
    /// assert against.
    pub mutation: MutationResult,
    pub failed_transient_message_id: Option<String>,
    pub failed_permanent_message_id: Option<String>,
}

/// TS `MixedStateFixture` (extends DerivedThreadFixture fields).
pub struct MixedStateFixture {
    pub file_path: String,
    pub sdk: Lhc,
    pub double: InferenceCallbacksDouble,
    pub turn_ids: Vec<String>,
    pub chunks: ChunkSnapshot,
    /// t13: turn forms blocked through the terminal path
    pub blocked_turn_id: String,
    /// t14's prompt: smoothed_prompt still queued
    pub pending_prompt_message_id: String,
    pub failed_transient_message_id: Option<String>,
    pub failed_permanent_message_id: Option<String>,
}

/// TS anonymous `{ filePath; sdk }` from [`corrupted_variant_thread`].
pub struct CorruptedVariantResult {
    pub file_path: String,
    pub sdk: Lhc,
}

/// TS anonymous `{ filePath; sdk; blockedTurnId }` from [`blocked_sibling_thread`].
pub struct BlockedSiblingResult {
    pub file_path: String,
    pub sdk: Lhc,
    pub blocked_turn_id: String,
}

/// TS `derivedThreadFixture` — PARTIAL (SDK-driving).
///
/// Phase 2 body must: build via [`turn_events`]/[`send`]/[`drain`],
/// pin [`FIXTURE_CHUNK_POLICY`] / [`TURN_COUNT`], manufacture failures with
/// [`set_message_derivation_failed`] + [`failed_entries`], and enforce the
/// pinned chunk-shape invariants (4 chunks / 3 closed) inline inside the
/// Phase 2 body — not via a separate invented helper.
pub async fn derived_thread_fixture(
    _store: &TempStore,
    _opts: DerivedThreadOptions,
) -> DerivedThreadFixture {
    todo!("phase 2")
}

/// The canonical-corruption variant (FC-0.5) — PARTIAL (SDK-driving).
pub async fn corrupted_variant_thread(_store: &TempStore) -> CorruptedVariantResult {
    todo!("phase 2")
}

/// The mutation-in-flight variant — PARTIAL (SDK-driving).
pub async fn mutation_in_flight_variant(_store: &TempStore) -> MutationInFlightFixture {
    todo!("phase 2")
}

/// The mixed-state variant (TC-4.1's substrate) — PARTIAL (SDK-driving).
pub async fn mixed_state_variant_thread(_store: &TempStore) -> MixedStateFixture {
    todo!("phase 2")
}

/// The blocked state's sacrificial sibling (FC-0.3) — PARTIAL (SDK-driving).
pub async fn blocked_sibling_thread(_store: &TempStore) -> BlockedSiblingResult {
    todo!("phase 2")
}
