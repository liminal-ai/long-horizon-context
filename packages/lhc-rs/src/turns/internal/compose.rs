//! Ported from packages/lhc/src/turns/internal/compose.ts.
//!
//! Rendering composition. Closed `PART_PLANS` Record → exhaustive-match fn
//! (no wildcard).

use std::collections::HashSet;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::messages::clean_prompt;
use crate::shared_tech::derivation::{
    DependencyGap, DerivationMetadata, DerivationState, RenderingPart, RenderingPartBlock,
    RenderingPartKind, SubjectKind, ToolOutcome,
};
use crate::shared_tech::js_json::{js_json_stringify, js_len, js_slice};
use crate::shared_tech::tool_result_rendering::{FALLBACK_TRUNCATION_LIMIT, truncate_for_fallback};

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
    /// Stored `message.token_estimate` — used for truncation markers.
    pub token_estimate: i64,
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

pub fn compose_derivation_key(message_id: &str, derivation: &str) -> String {
    format!("{message_id}/{derivation}")
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

fn first_block_content(message: &ComposeMessage) -> Map<String, Value> {
    message
        .blocks
        .first()
        .map(|b| b.content.clone())
        .unwrap_or_default()
}

fn text_of(message: &ComposeMessage) -> String {
    let text = first_block_content(message).get("text").cloned();
    match text {
        Some(Value::String(s)) => s,
        _ => String::new(),
    }
}

fn model_change_text(message: &ComposeMessage) -> String {
    let block = first_block_content(message);
    let previous = block.get("previousModel");
    let next = block.get("newModel");
    match (previous, next) {
        (Some(Value::String(previous)), Some(Value::String(next))) => {
            format!("model_change {previous} -> {next}")
        }
        _ => "model_change".to_string(),
    }
}

fn thinking_level_change_text(message: &ComposeMessage) -> String {
    let block = first_block_content(message);
    let previous = block.get("previousLevel");
    let next = block.get("newLevel");
    match (previous, next) {
        (Some(Value::String(previous)), Some(Value::String(next))) => {
            format!("thinking_level_change {previous} -> {next}")
        }
        _ => "thinking_level_change".to_string(),
    }
}

fn prompt_fallback_text(message: &ComposeMessage) -> String {
    let original = text_of(message);
    let floor = clean_prompt(&original);
    if floor.is_empty() && !original.is_empty() {
        original
    } else {
        floor
    }
}

/// TS `recordOutcomes` → `Map<string, boolean>` (insertion-ordered) → [`IndexMap`].
fn record_outcomes(messages: &[ComposeMessage]) -> IndexMap<String, bool> {
    let mut by_call_id = IndexMap::new();
    for message in messages {
        if message.kind != RenderingPartKind::ToolResult {
            continue;
        }
        let block = first_block_content(message);
        if let Some(Value::String(call_id)) = block.get("toolCallId") {
            by_call_id.insert(
                call_id.clone(),
                block.get("isError") == Some(&Value::Bool(true)),
            );
        }
    }
    by_call_id
}

fn outcome_from_record(result_by_call_id: &IndexMap<String, bool>, call_id: &Value) -> ToolOutcome {
    let Some(call_id) = call_id.as_str() else {
        return ToolOutcome::Unknown;
    };
    match result_by_call_id.get(call_id) {
        None => ToolOutcome::Unknown,
        Some(true) => ToolOutcome::Failed,
        Some(false) => ToolOutcome::Succeeded,
    }
}

/// TS `PartPlan`.
struct PartPlan {
    derivation: Option<&'static str>,
    fallback_text: fn(&ComposeMessage) -> String,
}

/// Token-total truncation marker for composed tool floors / legacy char floors.
/// Prefix is a UTF-16 code-unit slice of length FALLBACK_TRUNCATION_LIMIT.
fn truncate_for_rendering(text: &str, token_estimate: i64) -> String {
    if js_len(text) <= FALLBACK_TRUNCATION_LIMIT {
        return text.to_string();
    }
    format!(
        "{}… [truncated — {token_estimate} tok total]",
        js_slice(text, 0, Some(FALLBACK_TRUNCATION_LIMIT as i64)),
    )
}

fn tool_call_fallback_text(message: &ComposeMessage) -> String {
    let block = first_block_content(message);
    let tool_name = match block.get("toolName") {
        Some(Value::String(name)) => name.as_str(),
        _ => "unknown_tool",
    };
    let arguments = block
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    // Nullish arguments → `{}` (TS `??`, Python `is None`).
    let arguments = if arguments.is_null() {
        Value::Object(Map::new())
    } else {
        arguments
    };
    truncate_for_rendering(
        &format!("{tool_name}({})", js_json_stringify(&arguments)),
        message.token_estimate,
    )
}

fn tool_result_fallback_text(message: &ComposeMessage) -> String {
    let block = first_block_content(message);
    let content = match block.get("content") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    truncate_for_rendering(content, message.token_estimate)
}

/// Ready tool_result_summary: legacy char-based floors retranslate to token
/// markers; genuine inference summaries pass through verbatim.
fn ready_text(message: &ComposeMessage, derived_text: &str) -> String {
    if message.kind != RenderingPartKind::ToolResult {
        return derived_text.to_string();
    }
    let block = first_block_content(message);
    let raw_text = match block.get("content") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };
    if derived_text == truncate_for_fallback(raw_text) {
        truncate_for_rendering(raw_text, message.token_estimate)
    } else {
        derived_text.to_string()
    }
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
    message: &ComposeMessage,
    derivations: &IndexMap<String, ComposeDerivationRow>,
    result_by_call_id: &IndexMap<String, bool>,
) -> BuiltAtom {
    let plan = part_plan(message.kind);
    let derivation = plan.derivation.and_then(|derivation| {
        derivations.get(&compose_derivation_key(&message.message_id, derivation))
    });
    let ready = matches!(
        derivation,
        Some(ComposeDerivationRow {
            state: DerivationState::Ready,
            content: Some(_),
            ..
        })
    );
    let block = first_block_content(message);
    let text = if ready {
        let derived = derivation
            .and_then(|d| d.content.clone())
            .expect("ready implies content");
        ready_text(message, &derived)
    } else {
        (plan.fallback_text)(message)
    };
    let fallback = plan.derivation.is_some() && !ready;
    let mut part = RenderingPart {
        message_id: message.message_id.clone(),
        kind: message.kind,
        text,
        fallback,
        blocks: None,
        outcome: None,
        member_message_ids: None,
    };
    if matches!(
        message.kind,
        RenderingPartKind::ModelChange | RenderingPartKind::ThinkingLevelChange
    ) {
        part.blocks = Some(
            message
                .blocks
                .iter()
                .map(|b| RenderingPartBlock {
                    block_type: b.block_type.clone(),
                    content: b.content.clone(),
                })
                .collect(),
        );
    }
    if message.kind == RenderingPartKind::ToolCall {
        let meta_outcome = if ready {
            derivation
                .and_then(|d| d.metadata.as_ref())
                .and_then(|m| m.outcome)
        } else {
            None
        };
        part.outcome = Some(meta_outcome.unwrap_or_else(|| {
            outcome_from_record(
                result_by_call_id,
                block.get("toolCallId").unwrap_or(&Value::Null),
            )
        }));
    } else if message.kind == RenderingPartKind::ToolResult {
        let meta_outcome = if ready {
            derivation
                .and_then(|d| d.metadata.as_ref())
                .and_then(|m| m.outcome)
        } else {
            None
        };
        part.outcome = Some(meta_outcome.unwrap_or_else(|| {
            if block.get("isError") == Some(&Value::Bool(true)) {
                ToolOutcome::Failed
            } else {
                ToolOutcome::Succeeded
            }
        }));
    }
    let mut atom = ComposeAtom {
        part,
        is_tool: is_tool_kind(message.kind),
        is_break: is_run_break_kind(message.kind),
        tool_name: None,
        tool_call_id: None,
    };
    if message.kind == RenderingPartKind::ToolCall {
        if let Some(Value::String(name)) = block.get("toolName") {
            atom.tool_name = Some(name.clone());
        }
    }
    if atom.is_tool {
        if let Some(Value::String(call_id)) = block.get("toolCallId") {
            atom.tool_call_id = Some(call_id.clone());
        }
    }
    let (gap, recovery) = if atom.part.fallback {
        if let Some(derivation_type) = plan.derivation {
            let gap = DependencyGap {
                subject_kind: SubjectKind::Message,
                subject_id: message.message_id.clone(),
                derivation_type: derivation_type.to_string(),
            };
            let reason = if matches!(derivation.map(|d| d.state), Some(DerivationState::Failed)) {
                RecoveryReason::FailedFloor
            } else {
                RecoveryReason::NotReady
            };
            let recovery = RecoveryReceipt {
                subject_kind: RecoverySubjectKind::Message,
                subject_id: message.message_id.clone(),
                derivation_type: derivation_type.to_string(),
                content: atom.part.text.clone(),
                source_version: derivation.map(|d| d.source_version).unwrap_or(1),
                reason,
                floor_used: atom.part.text.clone(),
            };
            (Some(gap), Some(recovery))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    BuiltAtom {
        atom,
        gap,
        recovery,
    }
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

fn tally_run(members: &[ComposeAtom]) -> RunTally {
    let calls: Vec<&ComposeAtom> = members
        .iter()
        .filter(|m| m.part.kind == RenderingPartKind::ToolCall)
        .collect();
    let call_ids: HashSet<&str> = calls
        .iter()
        .filter_map(|m| m.tool_call_id.as_deref())
        .collect();
    let orphan_results: Vec<&ComposeAtom> = members
        .iter()
        .filter(|m| {
            m.part.kind == RenderingPartKind::ToolResult
                && m.tool_call_id
                    .as_deref()
                    .is_none_or(|id| !call_ids.contains(id))
        })
        .collect();
    let mut counts = IndexMap::new();
    counts.insert(ToolOutcome::Succeeded, 0);
    counts.insert(ToolOutcome::Failed, 0);
    counts.insert(ToolOutcome::Unknown, 0);
    for m in calls.iter().chain(orphan_results.iter()) {
        let outcome = m.part.outcome.unwrap_or(ToolOutcome::Unknown);
        *counts.get_mut(&outcome).expect("outcome key pre-inserted") += 1;
    }
    let outcome = if counts[&ToolOutcome::Failed] > 0 {
        ToolOutcome::Failed
    } else if counts[&ToolOutcome::Unknown] > 0 {
        ToolOutcome::Unknown
    } else {
        ToolOutcome::Succeeded
    };
    let mut tool_names: Vec<String> = Vec::new();
    for call in &calls {
        if let Some(name) = &call.tool_name {
            if !tool_names.iter().any(|n| n == name) {
                tool_names.push(name.clone());
            }
        }
    }
    RunTally {
        counts,
        outcome,
        call_count: calls.len() as i64,
        tool_names,
    }
}

fn run_tally_text(counts: &IndexMap<ToolOutcome, i64>) -> String {
    let segs: Vec<String> = RUN_OUTCOME_ORDER
        .iter()
        .filter(|o| counts.get(*o).copied().unwrap_or(0) > 0)
        .map(|o| format!("{} {}", counts[o], o.as_str()))
        .collect();
    if segs.is_empty() {
        "no outcomes".to_string()
    } else {
        segs.join(", ")
    }
}

/// Short XML wrap: tag name is the entity id (`m12`, `t3`).
pub fn wrap_entity_xml(entity_id: &str, body: &str) -> String {
    format!("<{entity_id}>\n{body}\n</{entity_id}>")
}

fn wrap_message_line_xml(message_id: &str, line: &str) -> String {
    format!("<{message_id}>{line}</{message_id}>")
}

/// Chunk band header: member turn ids the model can request later.
pub fn format_turn_range_header(turn_ids: &[String]) -> String {
    if turn_ids.is_empty() {
        return String::new();
    }
    format!("<turns>{}</turns>", turn_ids.join(" "))
}

/// TS `renderingPartLabel` — closed vocab → exhaustive match (no wildcard).
fn rendering_part_label(kind: RenderingPartKind) -> &'static str {
    match kind {
        RenderingPartKind::UserPrompt => "User prompt",
        RenderingPartKind::AssistantText => "Assistant response",
        RenderingPartKind::AssistantThinking => "Assistant thinking",
        RenderingPartKind::RuntimeNote => "Runtime note",
        RenderingPartKind::ModelChange => "Model change",
        RenderingPartKind::ThinkingLevelChange => "Thinking level change",
        RenderingPartKind::ToolCall => "Tool call",
        RenderingPartKind::ToolResult => "Tool result",
    }
}

/// Smooth-band turn_rendering text: turn wrap + per-message tags. Not used for
/// pre_detailed_assembly (compression stays untagged).
pub fn compose_structured_turn_text(parts: &[RenderingPart], turn_id: &str) -> String {
    let inner = parts
        .iter()
        // Empty thinking has no usable representation in a text band. Leaving it
        // here bypasses the serving-exit tail filters once the turn is compacted.
        .filter(|part| {
            part.kind != RenderingPartKind::AssistantThinking || !part.text.trim().is_empty()
        })
        .map(|part| {
            let mut annotations: Vec<String> = Vec::new();
            if part.fallback {
                annotations.push("fallback".to_string());
            }
            if let Some(outcome) = part.outcome {
                annotations.push(format!("outcome: {}", outcome.as_str()));
            }
            let suffix = if annotations.is_empty() {
                String::new()
            } else {
                format!(" [{}]", annotations.join("; "))
            };
            let header = format!("{}{}", rendering_part_label(part.kind), suffix);
            // Tool runs already tag each member line; other parts wrap the whole body.
            let body = match &part.member_message_ids {
                Some(ids) if !ids.is_empty() => part.text.clone(),
                _ => wrap_entity_xml(&part.message_id, &part.text),
            };
            format!("{header}\n{body}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    wrap_entity_xml(turn_id, &inner)
}

/// True when stored turn_rendering already carries the outer turn label wrap.
/// Used by retrieval (R4+) to decide live re-composition for legacy unlabeled
/// rows; available here so R3 can unit-test the contract without retrieval.
pub fn stored_rendering_has_turn_label(content: &str, turn_id: &str) -> bool {
    content.starts_with(&format!("<{turn_id}>\n")) && content.ends_with(&format!("\n</{turn_id}>"))
}

fn compose_run(members: &[ComposeAtom]) -> RenderingPart {
    let RunTally {
        counts,
        outcome,
        call_count,
        tool_names,
    } = tally_run(members);
    let tools = if tool_names.is_empty() {
        "tools".to_string()
    } else {
        tool_names.join(", ")
    };
    let plural = if call_count == 1 { "" } else { "s" };
    let header = format!(
        "tool run · {tools} · {call_count} call{plural} · {}",
        run_tally_text(&counts)
    );
    // Each member line is tagged with its message id so smooth history can address it.
    let detail = members
        .iter()
        .map(|m| {
            let line = if m.is_tool {
                format!(
                    "{} ⇒ {}",
                    m.part.text,
                    m.part.outcome.map(|o| o.as_str()).unwrap_or("unknown")
                )
            } else {
                m.part.text.clone()
            };
            wrap_message_line_xml(&m.part.message_id, &line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = format!("[{header}]\n{detail}");
    let lead = members
        .first()
        .expect("composeRun: a tool run has no members");
    RenderingPart {
        message_id: lead.part.message_id.clone(),
        kind: lead.part.kind,
        text,
        fallback: members.iter().any(|m| m.is_tool && m.part.fallback),
        blocks: None,
        outcome: Some(outcome),
        member_message_ids: Some(members.iter().map(|m| m.part.message_id.clone()).collect()),
    }
}

pub fn compose_rendering_input(
    messages: &[ComposeMessage],
    derivations: &IndexMap<String, ComposeDerivationRow>,
) -> CompositionInput {
    let result_by_call_id = record_outcomes(messages);
    let mut atoms: Vec<ComposeAtom> = Vec::new();
    let mut gaps: Vec<DependencyGap> = Vec::new();
    let mut recoveries: Vec<RecoveryReceipt> = Vec::new();
    for message in messages {
        let built = build_atom(message, derivations, &result_by_call_id);
        atoms.push(built.atom);
        if let Some(gap) = built.gap {
            gaps.push(gap);
        }
        if let Some(recovery) = built.recovery {
            recoveries.push(recovery);
        }
    }

    let mut parts: Vec<RenderingPart> = Vec::new();
    let mut i = 0usize;
    while i < atoms.len() {
        let atom = &atoms[i];
        if !atom.is_tool {
            parts.push(atom.part.clone());
            i += 1;
            continue;
        }
        // Maximal run starting at this tool atom: extend over following tool
        // atoms and interior transparent atoms (thinking/notes), stopping at the
        // next break (prompt/assistant text) or the turn's end. Transparent atoms
        // trailing the last tool atom stand alone, not folded into the run.
        let mut j = i;
        let mut last_tool_idx = i;
        while j + 1 < atoms.len() && !atoms[j + 1].is_break {
            j += 1;
            if atoms[j].is_tool {
                last_tool_idx = j;
            }
        }
        parts.push(compose_run(&atoms[i..=last_tool_idx]));
        if last_tool_idx < j {
            for trailing in &atoms[last_tool_idx + 1..=j] {
                parts.push(trailing.part.clone());
            }
        }
        i = j + 1;
    }

    CompositionInput {
        parts,
        gaps,
        recoveries,
    }
}

fn format_dialogue_section(part: &RenderingPart) -> String {
    if part.kind == RenderingPartKind::UserPrompt {
        format!("User:\n{}", part.text)
    } else {
        format!("⏺ {}", part.text)
    }
}

static DIALOGUE_MULTI_NEWLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("DIALOGUE_MULTI_NEWLINE"));

fn compose_dialogue_text(parts: &[RenderingPart]) -> String {
    let dialogue_parts: Vec<&RenderingPart> = parts
        .iter()
        .filter(|part| is_dialog_kind(part.kind))
        .collect();
    if dialogue_parts.is_empty() {
        return String::new();
    }

    let mut text = format_dialogue_section(dialogue_parts[0]);
    for index in 1..dialogue_parts.len() {
        let previous = dialogue_parts[index - 1];
        let current = dialogue_parts[index];
        let separator = if previous.kind == RenderingPartKind::AssistantText
            && current.kind == RenderingPartKind::AssistantText
        {
            "\n"
        } else {
            "\n\n"
        };
        text.push_str(separator);
        text.push_str(&format_dialogue_section(current));
    }
    DIALOGUE_MULTI_NEWLINE
        .replace_all(&text, "\n\n")
        .into_owned()
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
    messages: &[ComposeMessage],
    derivations: &IndexMap<String, ComposeDerivationRow>,
) -> PreDetailedAssembly {
    let result_by_call_id = record_outcomes(messages);
    let mut parts: Vec<RenderingPart> = Vec::new();
    let mut gaps: Vec<DependencyGap> = Vec::new();
    let mut recoveries: Vec<RecoveryReceipt> = Vec::new();
    for message in messages {
        if !is_dialog_kind(message.kind) {
            continue;
        }
        let built = build_atom(message, derivations, &result_by_call_id);
        parts.push(built.atom.part);
        if let Some(gap) = built.gap {
            gaps.push(gap);
        }
        if let Some(recovery) = built.recovery {
            recoveries.push(recovery);
        }
    }
    PreDetailedAssembly {
        text: compose_dialogue_text(&parts),
        gaps,
        recoveries,
    }
}
