//! Ported from packages/lhc/test/fixtures/lifecycle.ts. Phase 1.
//!
//! Pure data (profile, mutation targets, conversation builders) are REAL.
//! SDK-driving helpers (`create_lifecycle_sdk`, `run_lifecycle`) are
//! `todo!("phase 2")`.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lhc::intake_stream::{BatchResult, MessageEventInput};
use lhc::messages::{EditInput, MessageReportOpts, MutationResult, RemoveInput};
use lhc::sdk::{Lhc, init_lhc};
use lhc::shared_tech::derivation::{
    ChunkPolicyConfig, DerivationReportEntry, SdkConfig, SdkMode, ToolResultConfig,
};
use lhc::shared_tech::deterministic::create_deterministic_inference_callbacks;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, InferenceConfig};
use lhc::shared_tech::inspect::{HealthReport, InspectOverview, ViewContentsReport};
use lhc::shared_tech::view::{
    CompactReceipt, LlmRequestContext, PartialViewProfilePercentages, SdkViewConfig,
    ViewProfileOverride, ViewStatus,
};
use lhc::thread_view::{CompactOpts, MaterializeOpts};
use lhc::threads::{NewThreadInput, NewThreadResult, ThreadRef};
use lhc::turns::TurnReportOpts;

use super::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload, kind, valid_event,
};

// ── the one SDK configuration (AC-5.1) ────────────────────────────

/// Fixed instant the TS lifecycle harness freezes via
/// Fixed lifecycle clock — Unix seconds for TS
/// `vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"))` (ISO is prose only).
const LIFECYCLE_FIXED_CLOCK_SECS: u64 = 1_781_222_400;

/// [`SystemTime`] for the fixed lifecycle instant — injected via `SdkConfig.clock`.
fn lifecycle_fixed_clock_instant() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(LIFECYCLE_FIXED_CLOCK_SECS)
}

/// Amendment I — TS `number` band shares / lowerBound (fractional-capable).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LifecycleProfilePercentages {
    pub full: f64,
    pub smooth: f64,
    pub detailed: f64,
    pub brief: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleProfile {
    pub name: &'static str,
    pub lower_bound: f64,
    pub percentages: LifecycleProfilePercentages,
}

pub const LIFECYCLE_PROFILE: LifecycleProfile = LifecycleProfile {
    name: "lifecycle",
    lower_bound: 400.0,
    percentages: LifecycleProfilePercentages {
        full: 25.0,
        smooth: 16.0,
        detailed: 10.0,
        brief: 49.0,
    },
};

const TURN_COUNT: i64 = 12;
const TOOL_HEAVY_TURNS: [i64; 4] = [5, 6, 7, 8];
const TURNS_PER_BATCH: i64 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditTarget {
    pub turn_id: &'static str,
    pub kind: &'static str,
}

pub const EDIT_TARGET: EditTarget = EditTarget {
    turn_id: "t12",
    kind: "user_prompt",
};
pub const EDITED_MESSAGE_TEXT: &str = "turn 12 revised: drop area 12 and re-check area 5 instead";
pub const DELETE_TARGET: EditTarget = EditTarget {
    turn_id: "t10",
    kind: "assistant_text",
};
pub const DELETED_MESSAGE_TEXT: &str = "findings for area 10";

/// Pure data builder — REAL (no SDK calls).
fn turn_events(turn: i64) -> Vec<MessageEventInput> {
    let mut seq = 0u64;
    let mut key = || {
        seq += 1;
        format!("lc-t{turn}-e{seq}")
    };
    let tool_heavy: HashSet<i64> = TOOL_HEAVY_TURNS.into_iter().collect();

    let mut events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                idempotency_key: Some(key()),
                payload: Some(UserPromptPayload {
                    text: format!("turn {turn}: please investigate area {turn}"),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides {
                idempotency_key: Some(key()),
                payload: Some(AssistantThinkingPayload::new(format!(
                    "considering what area {turn} contains"
                ))),
                ..Default::default()
            },
        ),
    ];
    if tool_heavy.contains(&turn) {
        for run in [1i64, 2] {
            let tool_call_id = format!("call-lc-{turn}-{run}");
            let mut args = serde_json::Map::new();
            args.insert(
                "path".into(),
                serde_json::Value::String(format!("area-{turn}/file-{run}.txt")),
            );
            events.push(valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    idempotency_key: Some(key()),
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
                    idempotency_key: Some(key()),
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
            idempotency_key: Some(key()),
            payload: Some(AssistantTextPayload::new(format!(
                "findings for area {turn}"
            ))),
            ..Default::default()
        },
    ));
    events.push(valid_event(
        kind::TURN_END,
        TurnEndOverrides {
            idempotency_key: Some(key()),
            ..Default::default()
        },
    ));
    events
}

/// Pure data builder — REAL (no SDK calls).
fn intake_batches() -> Vec<Vec<MessageEventInput>> {
    let mut batches = Vec::new();
    let mut first = 1i64;
    while first <= TURN_COUNT {
        let mut batch = Vec::new();
        let mut turn = first;
        while turn < first + TURNS_PER_BATCH && turn <= TURN_COUNT {
            batch.extend(turn_events(turn));
            turn += 1;
        }
        batches.push(batch);
        first += TURNS_PER_BATCH;
    }
    batches
}

// ── run shape ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleDrainPhase {
    pub settled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleInspect1 {
    pub overview: OpResult<InspectOverview>,
    pub view: OpResult<ViewContentsReport>,
    pub health: OpResult<HealthReport>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleMutatePhase {
    pub edited_message_id: String,
    pub deleted_message_id: String,
    pub edit: OpResult<MutationResult>,
    pub delete: OpResult<MutationResult>,
    pub health_after_mutate: OpResult<HealthReport>,
    pub messages_not_ready: OpResult<Vec<DerivationReportEntry>>,
    pub turns_not_ready: OpResult<Vec<DerivationReportEntry>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleMaterializeResult {
    pub written_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LifecyclePhases {
    pub create: OpResult<NewThreadResult>,
    pub intake: Vec<OpResult<BatchResult>>,
    pub drain: LifecycleDrainPhase,
    pub status: OpResult<ViewStatus>,
    pub compact1: OpResult<CompactReceipt>,
    pub llm_context1: OpResult<LlmRequestContext>,
    pub inspect1: LifecycleInspect1,
    pub mutate: LifecycleMutatePhase,
    pub rebuild: LifecycleDrainPhase,
    pub health2: OpResult<HealthReport>,
    pub compact2: OpResult<CompactReceipt>,
    pub llm_context2: OpResult<LlmRequestContext>,
    pub materialize: OpResult<LifecycleMaterializeResult>,
}

/// TS `LifecycleCheckpoint = "inspect1" | "health2" | "materialize"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleCheckpoint {
    Inspect1,
    Health2,
    Materialize,
}

impl LifecycleCheckpoint {
    /// Exhaustive wire strings — no wildcard (Wave 0 closed-union ruling).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inspect1 => "inspect1",
            Self::Health2 => "health2",
            Self::Materialize => "materialize",
        }
    }
}

/// TS checkpoint callback context — `{ sdk, filePath }`.
pub struct LifecycleCheckpointCtx<'a> {
    pub sdk: &'a Lhc,
    pub file_path: String,
}

/// TS `onCheckpoint?` — lifetime-coupled async callback; Arc shares ownership.
pub type LifecycleCheckpointFn = Arc<
    dyn for<'a> Fn(
            LifecycleCheckpoint,
            LifecycleCheckpointCtx<'a>,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>
        + Send
        + Sync,
>;

/// Options for [`run_lifecycle`].
///
/// `fresh_sdk_between_groups` stays `Option<bool>` so absence is distinct from
/// `Some(false)` (TS optional `freshSdkBetweenGroups?`).
#[derive(Default)]
pub struct LifecycleOptions {
    pub name: Option<String>,
    pub fresh_sdk_between_groups: Option<bool>,
    pub on_checkpoint: Option<LifecycleCheckpointFn>,
    pub inference: Option<InferenceConfig>,
    pub guards: Option<DerivationGuards>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleRun {
    pub file_path: String,
    pub out_path: String,
    pub thread_id: String,
    pub phases: LifecyclePhases,
}

/// TS `createLifecycleSdk`.
///
/// Injects [`LIFECYCLE_FIXED_CLOCK_SECS`] through `SdkConfig.clock` via
/// [`lifecycle_fixed_clock_instant`] — TS freezes Date at 2026-06-12T00:00:00.000Z;
/// Rust recomputes the baseline per test (no async beforeAll).
pub fn create_lifecycle_sdk(
    inference: Option<InferenceConfig>,
    guards: Option<DerivationGuards>,
) -> Lhc {
    let clock_instant = lifecycle_fixed_clock_instant();
    init_lhc(SdkConfig {
        inference_callbacks: if inference.is_some() {
            None
        } else {
            Some(create_deterministic_inference_callbacks())
        },
        inference,
        mode: SdkMode::Background,
        clock: Some(Arc::new(move || clock_instant)),
        guards,
        chunk_policy: Some(ChunkPolicyConfig {
            target_projected_tokens: 90,
            max_projected_tokens: 4400,
        }),
        tool_result: Some(ToolResultConfig {
            small_tier_tokens: 1,
            small_target_ratio: 0.15,
            mid_target_ratio: 0.04,
        }),
        lease: None,
        view: Some(SdkViewConfig {
            profiles: Some(vec![ViewProfileOverride {
                name: LIFECYCLE_PROFILE.name.to_string(),
                lower_bound: Some(LIFECYCLE_PROFILE.lower_bound),
                percentages: Some(PartialViewProfilePercentages {
                    full: Some(LIFECYCLE_PROFILE.percentages.full),
                    smooth: Some(LIFECYCLE_PROFILE.percentages.smooth),
                    detailed: Some(LIFECYCLE_PROFILE.percentages.detailed),
                    brief: Some(LIFECYCLE_PROFILE.percentages.brief),
                }),
            }]),
            visibility: None,
            compact_threshold: Some(300.0),
        }),
    })
}

fn clone_inference_config(inf: &InferenceConfig) -> InferenceConfig {
    InferenceConfig {
        call: Arc::clone(&inf.call),
        assignments: inf.assignments.clone(),
        timeout_ms: inf.timeout_ms,
        max_input_chars: inf.max_input_chars,
    }
}

fn expect_ok<'a, T>(result: &'a OpResult<T>, phase: &str) -> &'a T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => {
            panic!(
                "lifecycle {phase} failed: {} — {}",
                error.code.as_str(),
                error.reason
            )
        }
    }
}

/// TS `runLifecycle`.
pub async fn run_lifecycle(store: &TempStore, opts: LifecycleOptions) -> LifecycleRun {
    let name = opts.name.as_deref().unwrap_or("lifecycle");
    let file_path = store.thread_path(Some(name)).to_string_lossy().into_owned();
    let out_path = store
        .dir
        .join(format!("{name}-session.jsonl"))
        .to_string_lossy()
        .into_owned();
    let ref_ = ThreadRef::file_path(&file_path);

    let mut sdk = create_lifecycle_sdk(
        opts.inference.as_ref().map(clone_inference_config),
        opts.guards.clone(),
    );
    let fresh = opts.fresh_sdk_between_groups.unwrap_or(false);

    // ── group 1: create → intake → drain → status ──
    let create = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    let thread_id = expect_ok(&create, "create").thread_id.clone();

    let mut intake = Vec::new();
    for batch in intake_batches() {
        let sent = sdk.intake_stream.message_events(ref_.clone(), &batch).await;
        expect_ok(&sent, "intake");
        intake.push(sent);
    }

    sdk.drain_settled(ref_.clone()).await;
    let drain = LifecycleDrainPhase { settled: true };

    let status = sdk.thread_view.status(ref_.clone()).await;
    expect_ok(&status, "status");

    // ── group 2: compact1 → llmContext1 → inspect1 ──
    if fresh {
        sdk = create_lifecycle_sdk(
            opts.inference.as_ref().map(clone_inference_config),
            opts.guards.clone(),
        );
    }
    let compact1 = sdk
        .thread_view
        .compact(
            ref_.clone(),
            CompactOpts {
                profile: Some(LIFECYCLE_PROFILE.name.to_string()),
                params: None,
                signal: None,
            },
        )
        .await;
    expect_ok(&compact1, "compact1");
    let llm_context1 = sdk.thread_view.get_llm_request_context(ref_.clone()).await;
    expect_ok(&llm_context1, "llmContext1");
    let inspect1 = LifecycleInspect1 {
        overview: sdk.inspect.overview(ref_.clone()).await,
        view: sdk.inspect.view(ref_.clone()).await,
        health: sdk.inspect.health(ref_.clone()).await,
    };
    expect_ok(&inspect1.overview, "inspect1.overview");
    expect_ok(&inspect1.view, "inspect1.view");
    expect_ok(&inspect1.health, "inspect1.health");
    if let Some(cb) = &opts.on_checkpoint {
        cb(
            LifecycleCheckpoint::Inspect1,
            LifecycleCheckpointCtx {
                sdk: &sdk,
                file_path: file_path.clone(),
            },
        )
        .await;
    }

    // ── group 3: mutate → rebuild → health2 ──
    if fresh {
        sdk = create_lifecycle_sdk(
            opts.inference.as_ref().map(clone_inference_config),
            opts.guards.clone(),
        );
    }
    let listed = sdk.messages.list(ref_.clone(), None).await;
    let listed = expect_ok(&listed, "mutate.list");
    let edit_message_id = listed
        .iter()
        .find(|record| {
            record.kind.as_str() == EDIT_TARGET.kind && record.turn_id == EDIT_TARGET.turn_id
        })
        .map(|r| r.message_id.clone());
    let delete_message_id = listed
        .iter()
        .find(|record| {
            record.kind.as_str() == DELETE_TARGET.kind && record.turn_id == DELETE_TARGET.turn_id
        })
        .map(|r| r.message_id.clone());
    let (Some(edit_message_id), Some(delete_message_id)) = (edit_message_id, delete_message_id)
    else {
        panic!("lifecycle invariant: edit/delete targets not found in the record");
    };
    let edit = sdk
        .messages
        .edit(
            ref_.clone(),
            EditInput {
                message_id: edit_message_id.clone(),
                content: EDITED_MESSAGE_TEXT.to_string(),
            },
        )
        .await;
    expect_ok(&edit, "mutate.edit");
    let deleted = sdk
        .messages
        .remove(
            ref_.clone(),
            RemoveInput {
                message_id: delete_message_id.clone(),
            },
        )
        .await;
    expect_ok(&deleted, "mutate.delete");
    let mutate = LifecycleMutatePhase {
        edited_message_id: edit_message_id,
        deleted_message_id: delete_message_id,
        edit,
        delete: deleted,
        health_after_mutate: sdk.inspect.health(ref_.clone()).await,
        messages_not_ready: sdk
            .messages
            .report(
                ref_.clone(),
                Some(MessageReportOpts {
                    not_ready: Some(true),
                    message_id: None,
                }),
            )
            .await,
        turns_not_ready: sdk
            .turns
            .report(
                ref_.clone(),
                Some(&TurnReportOpts {
                    not_ready: Some(true),
                    turn_id: None,
                    chunk_id: None,
                }),
            )
            .await,
    };
    expect_ok(&mutate.health_after_mutate, "mutate.health");
    expect_ok(&mutate.messages_not_ready, "mutate.messagesNotReady");
    expect_ok(&mutate.turns_not_ready, "mutate.turnsNotReady");

    sdk.drain_settled(ref_.clone()).await;
    let rebuild = LifecycleDrainPhase { settled: true };

    let health2 = sdk.inspect.health(ref_.clone()).await;
    expect_ok(&health2, "health2");
    if let Some(cb) = &opts.on_checkpoint {
        cb(
            LifecycleCheckpoint::Health2,
            LifecycleCheckpointCtx {
                sdk: &sdk,
                file_path: file_path.clone(),
            },
        )
        .await;
    }

    // ── group 4: compact2 → llmContext2 → materialize ──
    if fresh {
        sdk = create_lifecycle_sdk(
            opts.inference.as_ref().map(clone_inference_config),
            opts.guards.clone(),
        );
    }
    let compact2 = sdk
        .thread_view
        .compact(
            ref_.clone(),
            CompactOpts {
                profile: Some(LIFECYCLE_PROFILE.name.to_string()),
                params: None,
                signal: None,
            },
        )
        .await;
    expect_ok(&compact2, "compact2");
    let llm_context2 = sdk.thread_view.get_llm_request_context(ref_.clone()).await;
    expect_ok(&llm_context2, "llmContext2");
    let materialize_raw = sdk
        .thread_view
        .materialize(
            ref_.clone(),
            MaterializeOpts {
                path: out_path.clone(),
                format: None,
            },
        )
        .await;
    expect_ok(&materialize_raw, "materialize");
    let materialize = match materialize_raw {
        OpResult::Ok { value } => OpResult::Ok {
            value: LifecycleMaterializeResult {
                written_path: value.written_path,
            },
        },
        OpResult::Err { error } => OpResult::Err { error },
    };
    if let Some(cb) = &opts.on_checkpoint {
        cb(
            LifecycleCheckpoint::Materialize,
            LifecycleCheckpointCtx {
                sdk: &sdk,
                file_path: file_path.clone(),
            },
        )
        .await;
    }

    LifecycleRun {
        file_path,
        out_path,
        thread_id,
        phases: LifecyclePhases {
            create,
            intake,
            drain,
            status,
            compact1,
            llm_context1,
            inspect1,
            mutate,
            rebuild,
            health2,
            compact2,
            llm_context2,
            materialize,
        },
    }
}
