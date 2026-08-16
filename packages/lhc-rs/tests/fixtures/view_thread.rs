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
use lhc::messages::{EditInput, MutationResult};
use lhc::sdk::{DrainOpts, Lhc, init_lhc};
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, DerivationReportEntry, DerivationState, SdkConfig, SdkMode, ToolResultConfig,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::scheduler::{DrainDisposition, DrainStoppedBecause};
use lhc::shared_tech::storage::{SqlParam, open_database};
use lhc::shared_tech::view::CompactReceipt;
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};

use super::TempStore;
use super::corrupt::corrupt_two_open_turns;
use super::inference_callbacks_double::{
    InferenceCallbacksDouble, create_inference_callbacks_double,
};
use super::threads::{ChunkSnapshot, read_chunks};
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
                payload: Some(AssistantThinkingPayload::new(format!(
                    "considering what area {turn} contains"
                ))),
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
            payload: Some(AssistantTextPayload::new(format!(
                "findings for area {turn}"
            ))),
            ..Default::default()
        },
    ));
    events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    events
}

/// TS private `send` — SDK intake.
async fn send(sdk: &Lhc, file_path: &str, batch: &[MessageEventInput]) -> Vec<String> {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    match result {
        OpResult::Ok { value } => value
            .events
            .into_iter()
            .map(|entry| entry.message_id.unwrap_or_default())
            .collect(),
        OpResult::Err { error } => panic!("fixture batch failed: {}", error.reason),
    }
}

/// TS private `drain` — SDK work.drain.
async fn drain(sdk: &Lhc, file_path: &str) {
    let report = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    match report {
        OpResult::Ok { value } => {
            if value.stopped_because != DrainStoppedBecause::Empty || value.remaining != 0 {
                panic!(
                    "fixture drain left work behind (stopped: {}, remaining: {})",
                    value.stopped_because.as_str(),
                    value.remaining
                );
            }
        }
        OpResult::Err { error } => panic!("fixture drain failed: {}", error.reason),
    }
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

/// TS `derivedThreadFixture`.
pub async fn derived_thread_fixture(
    store: &TempStore,
    opts: DerivedThreadOptions,
) -> DerivedThreadFixture {
    let failures = opts.failures.unwrap_or(true);
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: Some(ToolResultConfig {
            small_tier_tokens: 1,
            small_target_ratio: 0.15,
            mid_target_ratio: 0.04,
        }),
        lease: None,
        chunk_policy: Some(FIXTURE_CHUNK_POLICY),
        view: None,
    });

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
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("fixture thread creation failed: {}", error.reason);
    }

    let mut turn_ids = Vec::new();
    let mut failed_transient = None;
    let mut failed_permanent = None;

    for turn in 1..=TURN_COUNT {
        if failures && turn == 6 {
            double.fail_kind("tool_result_summary", 1, Some(RATE_LIMIT_FAILURE_REASON));
        }
        if failures && turn == 7 {
            double.fail_kind("tool_result_summary", 1, Some(PERMANENT_FAILURE_REASON));
        }
        let message_ids = send(&sdk, &file_path, &turn_events(turn)).await;
        let first_tool_result_id = message_ids.get(3).cloned().filter(|s| !s.is_empty());
        if failures && (turn == 6 || turn == 7) {
            let Some(id) = first_tool_result_id else {
                panic!("fixture invariant: turn {turn} carries no first tool result message");
            };
            if turn == 6 {
                failed_transient = Some(id);
            } else {
                failed_permanent = Some(id);
            }
        }
        drain(&sdk, &file_path).await;
        turn_ids.push(format!("t{turn}"));
    }

    let chunks = read_chunks(&file_path);
    if chunks.chunks.len() != 4 {
        panic!(
            "fixture invariant: expected 4 chunks, got {} — re-pin FIXTURE_CHUNK_POLICY",
            chunks.chunks.len()
        );
    }
    let closed = chunks
        .chunks
        .iter()
        .filter(|c| c.status == lhc::turns::TurnStatus::Closed)
        .count();
    if closed != 3 {
        panic!(
            "fixture invariant: expected 3 closed chunks, got {closed} closed — re-pin FIXTURE_CHUNK_POLICY"
        );
    }

    if failures {
        if let Some(ref id) = failed_transient {
            set_message_derivation_failed(&file_path, id, RATE_LIMIT_FAILURE_REASON);
        }
        if let Some(ref id) = failed_permanent {
            set_message_derivation_failed(&file_path, id, PERMANENT_FAILURE_REASON);
        }
        let report = sdk
            .messages
            .report(ThreadRef::file_path(&file_path), None)
            .await;
        let OpResult::Ok { value: entries } = report else {
            let OpResult::Err { error } = report else {
                unreachable!()
            };
            panic!("fixture report failed: {}", error.reason);
        };
        let transient = failed_entries(&entries, RATE_LIMIT_FAILURE_REASON);
        let permanent = failed_entries(&entries, PERMANENT_FAILURE_REASON);
        if transient.len() != 1
            || transient[0].subject_id != failed_transient.as_deref().unwrap_or("")
            || permanent.len() != 1
            || permanent[0].subject_id != failed_permanent.as_deref().unwrap_or("")
        {
            panic!(
                "fixture invariant: expected exactly one transient-failed and one permanent-failed tool_result_summary on the named subjects"
            );
        }
    }

    DerivedThreadFixture {
        file_path,
        sdk,
        double,
        turn_ids,
        chunks,
        failed_transient_message_id: failed_transient,
        failed_permanent_message_id: failed_permanent,
    }
}

/// The canonical-corruption variant (FC-0.5).
pub async fn corrupted_variant_thread(store: &TempStore) -> CorruptedVariantResult {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
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
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("fixture thread creation failed: {}", error.reason);
    }
    for turn in 1..=3 {
        let _ = send(&sdk, &file_path, &turn_events(turn)).await;
    }
    drain(&sdk, &file_path).await;
    let _ = send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "left open before the damage".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    corrupt_two_open_turns(&file_path);
    CorruptedVariantResult { file_path, sdk }
}

/// The mutation-in-flight variant.
pub async fn mutation_in_flight_variant(store: &TempStore) -> MutationInFlightFixture {
    let fixture = derived_thread_fixture(
        store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let sdk = &fixture.sdk;
    let file_path = &fixture.file_path;

    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(file_path),
            CompactOpts {
                profile: None,
                params: None,
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    let OpResult::Ok {
        value: compact_receipt,
    } = compacted
    else {
        let OpResult::Err { error } = compacted else {
            unreachable!()
        };
        panic!("fixture compact failed: {}", error.reason);
    };

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        let OpResult::Err { error } = listed else {
            unreachable!()
        };
        panic!("fixture list failed: {}", error.reason);
    };
    let target = listed
        .iter()
        .find(|record| record.kind.as_str() == "user_prompt" && record.turn_id == "t2");
    let Some(target) = target else {
        panic!("fixture invariant: turn 2 carries no prompt message");
    };

    let edited = sdk
        .messages
        .edit(
            ThreadRef::file_path(file_path),
            EditInput {
                message_id: target.message_id.clone(),
                content: "turn 2 revised: investigate area 2 again".into(),
            },
        )
        .await;
    let OpResult::Ok { value: mutation } = edited else {
        let OpResult::Err { error } = edited else {
            unreachable!()
        };
        panic!("fixture edit failed: {}", error.reason);
    };

    MutationInFlightFixture {
        file_path: fixture.file_path,
        sdk: fixture.sdk,
        double: fixture.double,
        turn_ids: fixture.turn_ids,
        chunks: fixture.chunks,
        compact_receipt,
        edited_message_id: target.message_id.clone(),
        mutation,
        failed_transient_message_id: fixture.failed_transient_message_id,
        failed_permanent_message_id: fixture.failed_permanent_message_id,
    }
}

/// The mixed-state variant (TC-4.1's substrate).
pub async fn mixed_state_variant_thread(store: &TempStore) -> MixedStateFixture {
    let fixture = derived_thread_fixture(store, DerivedThreadOptions { failures: None }).await;
    let sdk = &fixture.sdk;
    let file_path = &fixture.file_path;

    let _ = send(sdk, file_path, &turn_events(13)).await;
    let prompt_ids = send(
        sdk,
        file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "turn 14: this prompt's smoothing stays pending".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    let pending_prompt_message_id = prompt_ids
        .first()
        .cloned()
        .filter(|s| !s.is_empty())
        .expect("fixture invariant: turn 14 prompt did not project");

    corrupt_two_open_turns(file_path);

    let report = sdk
        .work
        .drain(
            ThreadRef::file_path(file_path),
            Some(DrainOpts { max_items: Some(2) }),
        )
        .await;
    let OpResult::Ok { value: report } = report else {
        let OpResult::Err { error } = report else {
            unreachable!()
        };
        panic!("fixture drain failed: {}", error.reason);
    };
    let blocked_run = report.ran.iter().find(|entry| {
        entry.kind == "turn_derivation" && entry.disposition == DrainDisposition::FailedTerminal
    });
    if blocked_run.is_none() {
        panic!("fixture invariant: turn 13 derivation expected to land terminal on damage");
    }
    if report.remaining != 1 {
        panic!(
            "fixture invariant: expected exactly one queued item left, got {}",
            report.remaining
        );
    }

    MixedStateFixture {
        file_path: fixture.file_path,
        sdk: fixture.sdk,
        double: fixture.double,
        turn_ids: fixture.turn_ids,
        chunks: fixture.chunks,
        blocked_turn_id: "t13".into(),
        pending_prompt_message_id,
        failed_transient_message_id: fixture.failed_transient_message_id,
        failed_permanent_message_id: fixture.failed_permanent_message_id,
    }
}

/// The blocked state's sacrificial sibling (FC-0.3).
pub async fn blocked_sibling_thread(store: &TempStore) -> BlockedSiblingResult {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
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
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("fixture thread creation failed: {}", error.reason);
    }
    let _ = send(&sdk, &file_path, &turn_events(1)).await;
    let _ = send(
        &sdk,
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "left open before the damage".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    corrupt_two_open_turns(&file_path);
    let report = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value: report } = report else {
        let OpResult::Err { error } = report else {
            unreachable!()
        };
        panic!("fixture drain failed: {}", error.reason);
    };
    let blocked = report.ran.iter().find(|entry| {
        entry.kind == "turn_derivation" && entry.disposition == DrainDisposition::FailedTerminal
    });
    if blocked.is_none() {
        panic!("fixture invariant: turn_derivation expected to land terminal on damage");
    }
    BlockedSiblingResult {
        file_path,
        sdk,
        blocked_turn_id: "t1".into(),
    }
}
