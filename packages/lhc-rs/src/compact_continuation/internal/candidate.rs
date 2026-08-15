//! Candidate serving-view material facts for compact-continuation.

use indexmap::IndexMap;
use serde_json::Value;

use crate::shared_tech::derivation::RenderingPartKind;
use crate::shared_tech::storage::Db;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::thread_view::PreparedCompact;
use crate::thread_view::internal::assemble::assemble_view;
use crate::thread_view::internal::boundary::read_boundary_position;
use crate::thread_view::internal::render::{
    TailRenderContext, has_thinking_text, is_empty_thinking_husk, render_band_message,
    render_tail_message, tool_names_by_call_id,
};
use crate::thread_view::internal::snapshot::{TailMessageRow, read_tail_messages};

#[derive(Debug, Clone, PartialEq)]
pub struct CandidateAssembly {
    pub messages: Vec<CandidateMessage>,
    pub candidate_tokens: i64,
    pub current_served_tokens: i64,
    pub structural_issues: Vec<String>,
    pub material: CompactMaterialFactsPartial,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandidateMessage {
    pub role: String,
    pub content: String,
}

/// Material facts without installSucceeds (filled by runtime after install).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactMaterialFactsPartial {
    pub derivations_missing_or_failed: bool,
    pub lower_target_met: bool,
    pub compact_structurally_valid: bool,
    pub useful_reduction: bool,
    pub can_produce_valid_provider_request: bool,
}

/// Assemble a candidate LHC request from prepared bands + current eligible tail,
/// with an optional read-only visibility-boundary override for
/// protected-escalation candidate rendering (TS `opts.boundaryPositionOverride`).
/// Never mutates durable state.
pub fn assemble_candidate_from_prepared_with(
    db: &Db,
    prepared: &PreparedCompact,
    lower_target_tokens: i64,
    boundary_position_override: Option<i64>,
) -> CandidateAssembly {
    let compact_point = prepared.selection.compact_point;
    let boundary_position =
        boundary_position_override.unwrap_or_else(|| read_boundary_position(db));
    let tail_rows = read_tail_messages(db, compact_point);
    let render_ctx = TailRenderContext {
        boundary_position,
        tool_name_by_call_id: tool_names_by_call_id(&tail_rows),
    };

    let mut messages: Vec<CandidateMessage> = Vec::new();
    for band in &prepared.bands {
        let msg = render_band_message(band.band, &band.rendered_text);
        messages.push(CandidateMessage {
            role: msg.role.as_str().to_string(),
            content: msg.content,
        });
    }
    for row in &tail_rows {
        if is_empty_thinking_husk(row) {
            continue;
        }
        if row.kind == RenderingPartKind::AssistantThinking && !has_thinking_text(row) {
            continue;
        }
        let msg = render_tail_message(row, &render_ctx);
        messages.push(CandidateMessage {
            role: msg.role.as_str().to_string(),
            content: msg.content,
        });
    }

    let mut structural_issues = validate_settled_tail_structure(&tail_rows);
    if messages.is_empty() {
        structural_issues.push("candidate has no messages".into());
    }

    let candidate_tokens: i64 = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
    let current = assemble_view(db);
    let current_served_tokens: i64 = current
        .entries
        .iter()
        .map(|e| estimate_tokens(&e.message.content))
        .sum();

    let degraded =
        !prepared.degraded.is_empty() || !prepared.gaps.is_empty() || !prepared.warnings.is_empty();
    let useful_reduction = candidate_tokens < current_served_tokens;
    let structurally_valid = structural_issues.is_empty();

    CandidateAssembly {
        messages,
        candidate_tokens,
        current_served_tokens,
        structural_issues,
        material: CompactMaterialFactsPartial {
            derivations_missing_or_failed: degraded,
            lower_target_met: candidate_tokens <= lower_target_tokens,
            compact_structurally_valid: structurally_valid,
            useful_reduction,
            can_produce_valid_provider_request: structurally_valid,
        },
    }
}

pub fn validate_settled_tail_structure(tail_rows: &[TailMessageRow]) -> Vec<String> {
    let mut issues = Vec::new();
    let mut calls: IndexMap<String, (i64, i64)> = IndexMap::new();
    let mut results: IndexMap<String, (i64, i64, bool)> = IndexMap::new();

    for row in tail_rows {
        if row.kind == RenderingPartKind::ToolCall {
            let id = row
                .blocks
                .first()
                .and_then(|b| b.content.get("toolCallId"))
                .and_then(|v| v.as_str());
            let Some(id) = id.filter(|s| !s.is_empty()) else {
                issues.push("tool_call missing toolCallId".into());
                continue;
            };
            let prev = calls.get(id).map(|(_, c)| *c).unwrap_or(0);
            calls.insert(id.to_string(), (row.source_event_order, prev + 1));
            let args = row.blocks.first().and_then(|b| b.content.get("arguments"));
            if !matches!(args, Some(Value::Object(_))) {
                issues.push(format!("tool_call {id} unreadable arguments"));
            }
        }
        if row.kind == RenderingPartKind::ToolResult {
            let id = row
                .blocks
                .first()
                .and_then(|b| b.content.get("toolCallId"))
                .and_then(|v| v.as_str());
            let Some(id) = id.filter(|s| !s.is_empty()) else {
                issues.push("tool_result missing toolCallId".into());
                continue;
            };
            let content = row.blocks.first().and_then(|b| b.content.get("content"));
            let content_ok = matches!(content, Some(Value::String(_)));
            let prev = results.get(id).map(|(_, c, _)| *c).unwrap_or(0);
            results.insert(
                id.to_string(),
                (row.source_event_order, prev + 1, content_ok),
            );
            if !content_ok {
                issues.push(format!("tool_result {id} unreadable content"));
            }
        }
    }

    for (id, (order, count)) in &calls {
        if *count > 1 {
            issues.push(format!("duplicate tool_call {id}"));
        }
        match results.get(id) {
            None => issues.push(format!("unresolved tool_call {id} at settled seam")),
            Some((result_order, _, _)) if *order >= *result_order => {
                issues.push(format!("tool_call {id} does not precede its result"));
            }
            _ => {}
        }
    }
    for (id, (_, count, _)) in &results {
        if *count > 1 {
            issues.push(format!("duplicate tool_result {id}"));
        }
        if !calls.contains_key(id) {
            issues.push(format!("orphaned tool_result {id}"));
        }
    }
    issues
}
