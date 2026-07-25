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
use lhc::messages::MutationResult;
use lhc::sdk::Lhc;
use lhc::shared_tech::derivation::DerivationReportEntry;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inference_types::{DerivationGuards, InferenceConfig};
use lhc::shared_tech::inspect::{HealthReport, InspectOverview, ViewContentsReport};
use lhc::shared_tech::view::{CompactReceipt, LlmRequestContext, ViewStatus};
use lhc::threads::NewThreadResult;

use super::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload, kind, valid_event,
};

// ── the one SDK configuration (AC-5.1) ────────────────────────────

/// Fixed instant the TS lifecycle harness freezes via
/// `vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"))`.
///
/// Phase 2 `create_lifecycle_sdk` must inject this through `SdkConfig.clock`
/// (type-glue / const only here — the function body remains exact
/// `todo!("phase 2")`).
#[allow(dead_code)] // referenced by Phase 2 create_lifecycle_sdk body
const LIFECYCLE_FIXED_CLOCK_ISO: &str = "2026-06-12T00:00:00.000Z";

/// [`SystemTime`] for [`LIFECYCLE_FIXED_CLOCK_ISO`] — Phase 2 clock injection.
#[allow(dead_code)] // referenced by Phase 2 create_lifecycle_sdk body
fn lifecycle_fixed_clock_instant() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_781_222_400)
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
                payload: Some(AssistantThinkingPayload {
                    text: format!("considering what area {turn} contains"),
                }),
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
            payload: Some(AssistantTextPayload {
                text: format!("findings for area {turn}"),
            }),
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

/// TS `createLifecycleSdk` — PARTIAL (SDK construction).
///
/// Phase 2 body (exact `todo!("phase 2")` until then) must inject
/// [`LIFECYCLE_FIXED_CLOCK_ISO`] through `SdkConfig.clock` via
/// [`lifecycle_fixed_clock_instant`] — TS freezes Date with that instant;
/// Rust recomputes the baseline per test (no async beforeAll).
pub fn create_lifecycle_sdk(
    _inference: Option<InferenceConfig>,
    _guards: Option<DerivationGuards>,
) -> Lhc {
    todo!("phase 2")
}

/// TS `runLifecycle` — PARTIAL (SDK-driving sequence).
pub async fn run_lifecycle(_store: &TempStore, _opts: LifecycleOptions) -> LifecycleRun {
    todo!("phase 2")
}
