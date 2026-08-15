//! Durable proof of a pending correlated tool call/result pair in the open tail.

use serde_json::Value;

use crate::shared_tech::storage::{Db, SqlParam};

use crate::shared_tech::compact_continuation::normalize_protected_tool_call_ids;

use super::store::read_open_turn_ids;

#[derive(Debug, Clone, PartialEq)]
pub enum ToolPairProof {
    Ok {
        tool_call_id: String,
        call_message_id: String,
        result_message_id: String,
        call_event_order: i64,
        result_event_order: i64,
        turn_id: String,
        result_content: String,
    },
    Err {
        reason: ToolPairFailReason,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPairFailReason {
    NoSingleOpenTurn,
    CallMissing,
    ResultMissing,
    OrphanedCall,
    OrphanedResult,
    DuplicateCall,
    DuplicateResult,
    CallAfterResult,
    WrongTurn,
    NotInOpenTail,
    UnreadablePayload,
    ToolCallIdMismatch,
    EmptyProtectedSet,
    DuplicateProtectedId,
}

impl ToolPairFailReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolPairFailReason::NoSingleOpenTurn => "no_single_open_turn",
            ToolPairFailReason::CallMissing => "call_missing",
            ToolPairFailReason::ResultMissing => "result_missing",
            ToolPairFailReason::OrphanedCall => "orphaned_call",
            ToolPairFailReason::OrphanedResult => "orphaned_result",
            ToolPairFailReason::DuplicateCall => "duplicate_call",
            ToolPairFailReason::DuplicateResult => "duplicate_result",
            ToolPairFailReason::CallAfterResult => "call_after_result",
            ToolPairFailReason::WrongTurn => "wrong_turn",
            ToolPairFailReason::NotInOpenTail => "not_in_open_tail",
            ToolPairFailReason::UnreadablePayload => "unreadable_payload",
            ToolPairFailReason::ToolCallIdMismatch => "tool_call_id_mismatch",
            ToolPairFailReason::EmptyProtectedSet => "empty_protected_set",
            ToolPairFailReason::DuplicateProtectedId => "duplicate_protected_id",
        }
    }
}

fn map_str(row: &serde_json::Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn map_i64(row: &serde_json::Map<String, Value>, key: &str) -> i64 {
    row.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// Prove exactly one live tool_call and one matching live tool_result for
/// toolCallId in the current open turn's uncompacted tail (after compact point).
pub fn prove_pending_tool_pair(db: &Db, tool_call_id: &str) -> ToolPairProof {
    let open_ids = read_open_turn_ids(db);
    if open_ids.len() != 1 {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::NoSingleOpenTurn,
            detail: format!("expected exactly one open turn, found {}", open_ids.len()),
        };
    }
    let turn_id = open_ids[0].clone();

    let compact_point_row = db
        .prepare("SELECT compact_point FROM thread_view WHERE singleton = 1")
        .get();
    let compact_point = compact_point_row
        .as_ref()
        .and_then(|r| r.get("compact_point"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let call_rows = db
        .prepare(
            r#"SELECT m.message_id, m.source_event_order, m.turn_id, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
       WHERE m.deleted_at IS NULL
         AND m.kind = 'tool_call'
         AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order"#,
        )
        .all(&[SqlParam::from(tool_call_id)]);

    let result_rows = db
        .prepare(
            r#"SELECT m.message_id, m.source_event_order, m.turn_id, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
       WHERE m.deleted_at IS NULL
         AND m.kind = 'tool_result'
         AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order"#,
        )
        .all(&[SqlParam::from(tool_call_id)]);

    if call_rows.is_empty() && result_rows.is_empty() {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::CallMissing,
            detail: format!("no live tool_call or tool_result for {tool_call_id}"),
        };
    }
    if call_rows.is_empty() {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::OrphanedResult,
            detail: format!("tool_result without tool_call for {tool_call_id}"),
        };
    }
    if result_rows.is_empty() {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::OrphanedCall,
            detail: format!("tool_call without tool_result for {tool_call_id}"),
        };
    }
    if call_rows.len() > 1 {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::DuplicateCall,
            detail: format!("{} live tool_call rows for {tool_call_id}", call_rows.len()),
        };
    }
    if result_rows.len() > 1 {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::DuplicateResult,
            detail: format!(
                "{} live tool_result rows for {tool_call_id}",
                result_rows.len()
            ),
        };
    }

    let call = &call_rows[0];
    let result = &result_rows[0];
    let call_order = map_i64(call, "source_event_order");
    let result_order = map_i64(result, "source_event_order");
    let call_turn = map_str(call, "turn_id");
    let result_turn = map_str(result, "turn_id");

    if call_turn != turn_id || result_turn != turn_id {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::WrongTurn,
            detail: format!(
                "pair not both on open turn {turn_id} (call={call_turn}, result={result_turn})"
            ),
        };
    }
    if call_order <= compact_point || result_order <= compact_point {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::NotInOpenTail,
            detail: format!(
                "pair not both after compact point {compact_point} (call={call_order}, result={result_order})"
            ),
        };
    }
    if call_order >= result_order {
        return ToolPairProof::Err {
            reason: ToolPairFailReason::CallAfterResult,
            detail: format!(
                "tool_call event {call_order} must precede tool_result event {result_order}"
            ),
        };
    }

    let result_content_raw = map_str(result, "content");
    let call_content_raw = map_str(call, "content");
    let result_content = match serde_json::from_str::<Value>(&result_content_raw) {
        Ok(parsed) => {
            let content = parsed.get("content").and_then(|v| v.as_str());
            let Some(content) = content else {
                return ToolPairProof::Err {
                    reason: ToolPairFailReason::UnreadablePayload,
                    detail: "tool_result content is not a string".into(),
                };
            };
            let call_parsed: Value = match serde_json::from_str(&call_content_raw) {
                Ok(v) => v,
                Err(_) => {
                    return ToolPairProof::Err {
                        reason: ToolPairFailReason::UnreadablePayload,
                        detail: "failed to parse tool pair block JSON".into(),
                    };
                }
            };
            if call_parsed.get("toolCallId").and_then(|v| v.as_str()) != Some(tool_call_id) {
                return ToolPairProof::Err {
                    reason: ToolPairFailReason::ToolCallIdMismatch,
                    detail: "tool_call payload toolCallId mismatches requested id".into(),
                };
            }
            if parsed.get("toolCallId").and_then(|v| v.as_str()) != Some(tool_call_id) {
                return ToolPairProof::Err {
                    reason: ToolPairFailReason::ToolCallIdMismatch,
                    detail: "tool_result payload toolCallId mismatches requested id".into(),
                };
            }
            content.to_string()
        }
        Err(_) => {
            return ToolPairProof::Err {
                reason: ToolPairFailReason::UnreadablePayload,
                detail: "failed to parse tool pair block JSON".into(),
            };
        }
    };

    ToolPairProof::Ok {
        tool_call_id: tool_call_id.to_string(),
        call_message_id: map_str(call, "message_id"),
        result_message_id: map_str(result, "message_id"),
        call_event_order: call_order,
        result_event_order: result_order,
        turn_id,
        result_content,
    }
}

/// Contract 2.0.0 protected-set proof outcome.
#[derive(Debug, Clone, PartialEq)]
pub enum ProtectedToolPairSetProof {
    Ok {
        protected_tool_call_ids: Vec<String>,
        pairs: Vec<ToolPairOk>,
        /// Earliest protected tool_result source_event_order.
        earliest_protected_result_order: i64,
        turn_id: String,
    },
    Err {
        reason: ToolPairFailReason,
        detail: String,
        failed_tool_call_id: Option<String>,
    },
}

/// The success payload of one proven pair (mirrors `ToolPairProof::Ok`).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolPairOk {
    pub tool_call_id: String,
    pub call_message_id: String,
    pub result_message_id: String,
    pub call_event_order: i64,
    pub result_event_order: i64,
    pub turn_id: String,
    pub result_content: String,
}

/// Prove the full protected set: sorted unique non-empty; every id has exactly
/// one live call/result pair in the same open turn after the compact point.
pub fn prove_protected_tool_pair_set(
    db: &Db,
    protected_tool_call_ids: &[String],
) -> ProtectedToolPairSetProof {
    let normalized = normalize_protected_tool_call_ids(protected_tool_call_ids);
    if normalized.is_empty() {
        return ProtectedToolPairSetProof::Err {
            reason: ToolPairFailReason::EmptyProtectedSet,
            detail: "protectedToolCallIds must be non-empty".into(),
            failed_tool_call_id: None,
        };
    }
    if protected_tool_call_ids.len() != normalized.len() {
        // Either empties or duplicates in input.
        let non_empty: Vec<&String> = protected_tool_call_ids
            .iter()
            .filter(|id| !id.is_empty())
            .collect();
        let unique: std::collections::BTreeSet<&String> = non_empty.iter().copied().collect();
        if non_empty.len() != unique.len() {
            return ProtectedToolPairSetProof::Err {
                reason: ToolPairFailReason::DuplicateProtectedId,
                detail: "protectedToolCallIds contains duplicates".into(),
                failed_tool_call_id: None,
            };
        }
    }

    let mut pairs: Vec<ToolPairOk> = Vec::new();
    for id in &normalized {
        match prove_pending_tool_pair(db, id) {
            ToolPairProof::Ok {
                tool_call_id,
                call_message_id,
                result_message_id,
                call_event_order,
                result_event_order,
                turn_id,
                result_content,
            } => pairs.push(ToolPairOk {
                tool_call_id,
                call_message_id,
                result_message_id,
                call_event_order,
                result_event_order,
                turn_id,
                result_content,
            }),
            ToolPairProof::Err { reason, detail } => {
                return ProtectedToolPairSetProof::Err {
                    reason,
                    detail,
                    failed_tool_call_id: Some(id.clone()),
                };
            }
        }
    }

    let turn_id = pairs[0].turn_id.clone();
    for p in &pairs {
        if p.turn_id != turn_id {
            return ProtectedToolPairSetProof::Err {
                reason: ToolPairFailReason::WrongTurn,
                detail: format!(
                    "protected pairs span multiple turns ({turn_id} vs {})",
                    p.turn_id
                ),
                failed_tool_call_id: Some(p.tool_call_id.clone()),
            };
        }
    }

    let earliest = pairs
        .iter()
        .map(|p| p.result_event_order)
        .min()
        .expect("non-empty pairs");

    ProtectedToolPairSetProof::Ok {
        protected_tool_call_ids: normalized,
        pairs,
        earliest_protected_result_order: earliest,
        turn_id,
    }
}
