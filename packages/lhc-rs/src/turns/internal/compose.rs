//! Ported from packages/lhc/src/turns/internal/compose.ts. Phase 1 skeleton.
//!
//! Rendering composition. Closed `PART_PLANS` Record → exhaustive-match fn
//! (no wildcard). Bodies exact `todo!("phase 2")`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use crate::messages::clean_prompt;
use crate::shared_tech::derivation::{
    DependencyGap, DerivationMetadata, DerivationState, RenderingPart, RenderingPartKind,
    ToolOutcome,
};
#[allow(unused_imports)]
use crate::shared_tech::tool_result_rendering::truncate_for_fallback;

/// TS `ComposeMessage` block element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeBlock {
    pub block_type: String,
    pub content: Map<String, Value>,
}

/// The member message as the composer sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeMessage {
    pub message_id: String,
    pub kind: RenderingPartKind,
    pub blocks: Vec<ComposeBlock>,
}

/// One message-owned derivation row as composition input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDerivationRow {
    pub state: DerivationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DerivationMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source_version: i64,
}

pub fn compose_derivation_key(_message_id: &str, _derivation: &str) -> String {
    todo!("phase 2")
}

/// TS `RecoveryReceipt.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    NotReady,
    FailedFloor,
}

impl RecoveryReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoveryReason::NotReady => "not_ready",
            RecoveryReason::FailedFloor => "failed_floor",
        }
    }
}

/// TS `RecoveryReceipt.subjectKind` — closed single-value literal `"message"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RecoverySubjectKind {
    #[serde(rename = "message")]
    Message,
}

impl RecoverySubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoverySubjectKind::Message => "message",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReceipt {
    pub subject_kind: RecoverySubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub content: String,
    pub source_version: i64,
    pub reason: RecoveryReason,
    pub floor_used: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionInput {
    pub parts: Vec<RenderingPart>,
    pub gaps: Vec<DependencyGap>,
    pub recoveries: Vec<RecoveryReceipt>,
}

fn text_of(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

fn model_change_text(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

fn thinking_level_change_text(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

fn prompt_fallback_text(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

/// TS `recordOutcomes` → `Map<string, boolean>` (insertion-ordered) → [`IndexMap`].
fn record_outcomes(_messages: &[ComposeMessage]) -> IndexMap<String, bool> {
    todo!("phase 2")
}

fn outcome_from_record(
    _result_by_call_id: &IndexMap<String, bool>,
    _call_id: &Value,
) -> ToolOutcome {
    todo!("phase 2")
}

/// TS `PartPlan`.
struct PartPlan {
    derivation: Option<&'static str>,
    fallback_text: fn(&ComposeMessage) -> String,
}

fn tool_call_fallback_text(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

fn tool_result_fallback_text(_message: &ComposeMessage) -> String {
    todo!("phase 2")
}

/// TS `const PART_PLANS: Record<RenderingPartKind, PartPlan>` — closed Record →
/// exhaustive-match fn (no wildcard). Table REAL (Wave 0 Record ruling).
fn part_plan(kind: RenderingPartKind) -> PartPlan {
    match kind {
        RenderingPartKind::UserPrompt => PartPlan {
            derivation: Some("smoothed_prompt"),
            fallback_text: prompt_fallback_text,
        },
        RenderingPartKind::AssistantText => PartPlan {
            derivation: None,
            fallback_text: text_of,
        },
        RenderingPartKind::AssistantThinking => PartPlan {
            derivation: None,
            fallback_text: text_of,
        },
        RenderingPartKind::RuntimeNote => PartPlan {
            derivation: None,
            fallback_text: text_of,
        },
        RenderingPartKind::ModelChange => PartPlan {
            derivation: None,
            fallback_text: model_change_text,
        },
        RenderingPartKind::ThinkingLevelChange => PartPlan {
            derivation: None,
            fallback_text: thinking_level_change_text,
        },
        RenderingPartKind::ToolCall => PartPlan {
            derivation: None,
            fallback_text: tool_call_fallback_text,
        },
        RenderingPartKind::ToolResult => PartPlan {
            derivation: Some("tool_result_summary"),
            fallback_text: tool_result_fallback_text,
        },
    }
}

/// TS private `ComposeAtom`.
struct ComposeAtom {
    part: RenderingPart,
    is_tool: bool,
    is_break: bool,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
}

/// TS `RUN_BREAK_KINDS`.
fn is_run_break_kind(kind: RenderingPartKind) -> bool {
    matches!(
        kind,
        RenderingPartKind::UserPrompt | RenderingPartKind::AssistantText
    )
}

/// TS `TOOL_KINDS`.
fn is_tool_kind(kind: RenderingPartKind) -> bool {
    matches!(
        kind,
        RenderingPartKind::ToolCall | RenderingPartKind::ToolResult
    )
}

/// TS `DIALOG_KINDS`.
fn is_dialog_kind(kind: RenderingPartKind) -> bool {
    matches!(
        kind,
        RenderingPartKind::UserPrompt | RenderingPartKind::AssistantText
    )
}

struct BuiltAtom {
    atom: ComposeAtom,
    gap: Option<DependencyGap>,
    recovery: Option<RecoveryReceipt>,
}

fn build_atom(
    _message: &ComposeMessage,
    _derivations: &IndexMap<String, ComposeDerivationRow>,
    _result_by_call_id: &IndexMap<String, bool>,
) -> BuiltAtom {
    todo!("phase 2")
}

/// TS `RUN_OUTCOME_ORDER` — closed vocabulary order REAL.
const RUN_OUTCOME_ORDER: [ToolOutcome; 3] = [
    ToolOutcome::Succeeded,
    ToolOutcome::Failed,
    ToolOutcome::Unknown,
];

struct RunTally {
    counts: IndexMap<ToolOutcome, i64>,
    outcome: ToolOutcome,
    call_count: i64,
    tool_names: Vec<String>,
}

fn tally_run(_members: &[ComposeAtom]) -> RunTally {
    todo!("phase 2")
}

fn run_tally_text(_counts: &IndexMap<ToolOutcome, i64>) -> String {
    todo!("phase 2")
}

fn compose_run(_members: &[ComposeAtom]) -> RenderingPart {
    todo!("phase 2")
}

pub fn compose_rendering_input(
    _messages: &[ComposeMessage],
    _derivations: &IndexMap<String, ComposeDerivationRow>,
) -> CompositionInput {
    todo!("phase 2")
}

fn format_dialogue_section(_part: &RenderingPart) -> String {
    todo!("phase 2")
}

fn compose_dialogue_text(_parts: &[RenderingPart]) -> String {
    todo!("phase 2")
}

/// TS `composePreDetailedAssembly` return: `{ text, gaps, recoveries }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreDetailedAssembly {
    pub text: String,
    pub gaps: Vec<DependencyGap>,
    pub recoveries: Vec<RecoveryReceipt>,
}

pub fn compose_pre_detailed_assembly(
    _messages: &[ComposeMessage],
    _derivations: &IndexMap<String, ComposeDerivationRow>,
) -> PreDetailedAssembly {
    todo!("phase 2")
}

// Keep closed-table helpers referenced so the REAL match/const surfaces are
// not stripped as unused before Phase 2 call sites land.
const _: fn(RenderingPartKind) -> PartPlan = part_plan;
const _: fn(RenderingPartKind) -> bool = is_run_break_kind;
const _: fn(RenderingPartKind) -> bool = is_tool_kind;
const _: fn(RenderingPartKind) -> bool = is_dialog_kind;
const _: [ToolOutcome; 3] = RUN_OUTCOME_ORDER;
