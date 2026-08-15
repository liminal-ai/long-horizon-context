//! Read-only protected visibility-boundary preview (LIM-67).
//!
//! Ported from `packages/lhc/src/thread-view/internal/protected-boundary.ts`.
//! Accounts every protected tool_result at full size first, then considers only
//! older unprotected tool_result rows after the effective compact/boundary start.
//! Never moves the boundary backward. Boundary is strictly before the earliest
//! protected result event. Calls, assistant text, and reasoning are never targets.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::shared_tech::storage::{Db, SqlParam};
use crate::thread_view::internal::boundary::read_boundary_position;
use crate::thread_view::internal::snapshot::read_view_snapshot;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedBoundaryPreview {
    pub previous_boundary: i64,
    pub proposed_boundary: i64,
    pub compact_point: i64,
    pub effective_start: i64,
    /// Earliest protected tool_result source_event_order; None when none.
    pub earliest_protected_result_order: Option<i64>,
    /// Max legal boundary is earliest protected order - 1 (or maximal when none).
    pub max_legal_boundary: i64,
    pub protected_tool_call_ids: Vec<String>,
    pub full_protected_token_estimate: i64,
    pub eligible_unprotected_token_estimate: i64,
    pub pruned_unprotected_token_estimate: i64,
    pub remaining_unprotected_full_token_estimate: i64,
    /// Estimated zone tokens after proposed boundary (protected full + remaining full unprotected).
    pub zone_tokens_after_estimate: i64,
    /// True when even maximal eligible pruning cannot reduce zone under target (if any).
    pub maximal_prune_insufficient: bool,
    pub no_op: bool,
    /// Human-readable reasons (empty when ok).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct ToolResultRow {
    source_event_order: i64,
    tool_call_id: String,
    token_estimate: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ProtectedBoundaryOpts {
    pub target_zone_tokens: Option<i64>,
    pub compact_point_override: Option<i64>,
}

fn read_live_tool_results_after(db: &Db, effective_start: i64) -> Vec<ToolResultRow> {
    let rows = db
        .prepare(
            "SELECT m.source_event_order, m.token_estimate, b.content
             FROM message m
             JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
             WHERE m.kind = 'tool_result' AND m.deleted_at IS NULL AND m.source_event_order > ?
             ORDER BY m.source_event_order ASC",
        )
        .all(&[SqlParam::from(effective_start)]);
    rows.iter()
        .map(|row| {
            let mut tool_call_id = String::new();
            if let Some(raw) = row.get("content").and_then(|v| v.as_str())
                && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw)
                && let Some(id) = parsed.get("toolCallId").and_then(|v| v.as_str())
            {
                tool_call_id = id.to_string();
            }
            ToolResultRow {
                source_event_order: row
                    .get("source_event_order")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                tool_call_id,
                token_estimate: row
                    .get("token_estimate")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            }
        })
        .collect()
}

/// Compute a monotonic proposed visibility boundary that:
/// - starts at max(previousBoundary, compactPoint)
/// - never moves backward
/// - remains strictly before the earliest protected result event
/// - only advances across older unprotected tool_result rows
///
/// When `target_zone_tokens` is provided, advances just far enough that the
/// remaining full zone is at or under the target, preferring the smallest
/// advance that meets it. When omitted, computes the maximal legal advance.
pub fn preview_protected_visibility_boundary(
    db: &Db,
    protected_tool_call_ids: &[String],
    opts: &ProtectedBoundaryOpts,
) -> ProtectedBoundaryPreview {
    let protected_set: BTreeSet<String> = protected_tool_call_ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect();
    let mut sorted_protected: Vec<String> = protected_set.iter().cloned().collect();
    sorted_protected.sort_by(|a, b| crate::shared_tech::compact_continuation::js_string_cmp(a, b));
    let snapshot = read_view_snapshot(db);
    let compact_point = opts
        .compact_point_override
        .unwrap_or_else(|| snapshot.map(|s| s.compact_point).unwrap_or(0));
    let previous_boundary = read_boundary_position(db);
    let effective_start = previous_boundary.max(compact_point);
    let mut notes: Vec<String> = Vec::new();

    let rows = read_live_tool_results_after(db, effective_start);
    let protected_rows: Vec<&ToolResultRow> = rows
        .iter()
        .filter(|r| protected_set.contains(&r.tool_call_id))
        .collect();
    let unprotected_rows: Vec<&ToolResultRow> = rows
        .iter()
        .filter(|r| !protected_set.contains(&r.tool_call_id))
        .collect();

    let full_protected_token_estimate: i64 = protected_rows.iter().map(|r| r.token_estimate).sum();
    let eligible_unprotected_token_estimate: i64 =
        unprotected_rows.iter().map(|r| r.token_estimate).sum();

    let earliest_protected_result_order: Option<i64> =
        protected_rows.iter().map(|r| r.source_event_order).min();

    // Strictly before earliest protected result; if none, may advance through all eligible.
    let max_legal_boundary = match earliest_protected_result_order {
        None => i64::MAX,
        Some(order) => order - 1,
    };

    if let Some(order) = earliest_protected_result_order
        && order <= effective_start
    {
        notes.push(
            "earliest protected result is at or behind effective start; no eligible older unprotected rows"
                .to_string(),
        );
    }

    // Eligible unprotected rows that can be crossed.
    let eligible: Vec<&ToolResultRow> = unprotected_rows
        .iter()
        .filter(|r| r.source_event_order <= max_legal_boundary)
        .copied()
        .collect();

    // Maximal advance: last eligible unprotected result order (or previous if none).
    let mut maximal_boundary = previous_boundary;
    for r in &eligible {
        if r.source_event_order > maximal_boundary && r.source_event_order <= max_legal_boundary {
            maximal_boundary = r.source_event_order;
        }
    }
    if maximal_boundary < previous_boundary {
        maximal_boundary = previous_boundary;
    }
    if maximal_boundary > max_legal_boundary && max_legal_boundary >= previous_boundary {
        maximal_boundary = previous_boundary.max(maximal_boundary.min(max_legal_boundary));
    }
    if let Some(order) = earliest_protected_result_order
        && maximal_boundary >= order
    {
        maximal_boundary = previous_boundary.max(order - 1);
    }

    let zone_full_after = |boundary: i64| -> i64 {
        let start = boundary.max(compact_point);
        rows.iter()
            .filter(|r| r.source_event_order > start)
            .map(|r| r.token_estimate)
            .sum()
    };

    let mut proposed_boundary = previous_boundary;
    let target = opts.target_zone_tokens;

    match target {
        None => {
            proposed_boundary = maximal_boundary;
        }
        Some(target) if zone_full_after(previous_boundary) <= target => {
            proposed_boundary = previous_boundary;
        }
        Some(target) => {
            // Walk eligible rows oldest-first until zone is under target or maximal
            // legal boundary is reached.
            for r in &eligible {
                if r.source_event_order <= proposed_boundary {
                    continue;
                }
                if r.source_event_order > max_legal_boundary {
                    break;
                }
                let candidate = r.source_event_order;
                if let Some(order) = earliest_protected_result_order
                    && candidate >= order
                {
                    break;
                }
                proposed_boundary = candidate;
                if zone_full_after(proposed_boundary) <= target {
                    break;
                }
            }
        }
    }

    // Never move backward; clamp to legal.
    if proposed_boundary < previous_boundary {
        proposed_boundary = previous_boundary;
    }
    if let Some(order) = earliest_protected_result_order
        && proposed_boundary >= order
    {
        proposed_boundary = previous_boundary.max(order - 1);
        notes.push(
            "clamped proposed boundary strictly before earliest protected result".to_string(),
        );
    }

    // Pruned estimate: eligible unprotected at-or-behind proposed boundary.
    let mut pruned_unprotected_token_estimate: i64 = 0;
    let mut remaining_unprotected_full_token_estimate: i64 = 0;
    for r in &unprotected_rows {
        if r.source_event_order > proposed_boundary.max(compact_point) {
            remaining_unprotected_full_token_estimate += r.token_estimate;
        } else if r.source_event_order > compact_point && r.source_event_order <= proposed_boundary
        {
            pruned_unprotected_token_estimate += r.token_estimate;
        }
    }

    let zone_tokens_after_estimate = zone_full_after(proposed_boundary);
    let maximal_zone = zone_full_after(maximal_boundary);
    let maximal_prune_insufficient = match target {
        Some(target) => maximal_zone > target,
        None => full_protected_token_estimate > 0 && eligible.is_empty(),
    };

    if let Some(order) = earliest_protected_result_order
        && proposed_boundary >= order
    {
        // Should be impossible after clamp; hard guard.
        proposed_boundary = previous_boundary.max(order - 1);
    }

    let no_op = proposed_boundary == previous_boundary;

    ProtectedBoundaryPreview {
        previous_boundary,
        proposed_boundary,
        compact_point,
        effective_start,
        earliest_protected_result_order,
        max_legal_boundary: match earliest_protected_result_order {
            None => maximal_boundary,
            Some(order) => order - 1,
        },
        protected_tool_call_ids: sorted_protected,
        full_protected_token_estimate,
        eligible_unprotected_token_estimate,
        pruned_unprotected_token_estimate,
        remaining_unprotected_full_token_estimate,
        zone_tokens_after_estimate,
        maximal_prune_insufficient,
        no_op,
        notes,
    }
}
