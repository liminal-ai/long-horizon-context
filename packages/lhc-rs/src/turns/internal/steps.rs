//! Ported from packages/lhc/src/turns/internal/steps.ts (turn parts, F2).
//!
//! Step edges over one turn's live members, from the host-supplied step index
//! (schema v12). Pure: no inference. This is the one reader of step structure
//! the walk and the host metadata surface consume; the record never infers a
//! step, so a turn whose step-bearing members carry no index — or an
//! inconsistent one — is simply not splittable.
//!
//! A step is complete when every tool_call it holds has its tool_result in the
//! same step, after it. Steps count contiguously from the first: an incomplete
//! step ends the complete prefix, and the newest admissible split edge is the
//! edge preceding the newest complete step (the minimum verbatim tail always
//! keeps the last complete step).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::shared_tech::storage::{Db, SqlParam};

pub const STEP_BEARING_KINDS: &[&str] = &[
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepMember {
    pub message_id: String,
    /// source_event_order: the coordinate a split point is expressed in.
    pub order: i64,
    pub kind: String,
    pub step_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRange {
    pub index: i64,
    pub first_message_id: String,
    pub last_message_id: String,
    pub first_order: i64,
    /// The step's edge: a split after this step puts everything through this
    /// order in the part and everything after it in the verbatim tail.
    pub last_order: i64,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEdges {
    /// Whether the turn may be split at all: every step-bearing member carries
    /// an index, the first step is 0 and each new step advances by exactly one
    /// in message order (members within a step may repeat its index), and no
    /// tool pair straddles a step. Gaps, offsets, and regressions fail closed.
    /// False also for a turn with no steps.
    pub splittable: bool,
    /// Every step present, in order, whether or not the turn is splittable.
    pub steps: Vec<StepRange>,
    /// Leading run of complete steps.
    pub complete: usize,
    /// Newest admissible k: the number of steps a part may cover — one fewer
    /// than the complete prefix, since the newest complete step always stays
    /// in the verbatim tail. None when fewer than two steps are complete (0 is
    /// not an admissible k).
    pub last_edge: Option<usize>,
}

const SQL_READ_STEP_MEMBERS: &str = r#"SELECT m.message_id, m.source_event_order, m.kind, m.step_index,
              json_extract(mb.content, '$.toolCallId') AS tool_call_id
       FROM message m
       LEFT JOIN message_block mb ON mb.message_id = m.message_id AND mb.block_index = 0
       WHERE m.turn_id = ? AND m.deleted_at IS NULL
       ORDER BY m.source_event_order"#;

/// The live members of one turn as step input, in message order. The tool
/// pairing key is read from the first block of tool activity; other kinds
/// carry none.
pub fn read_step_members(db: &Db, turn_id: &str) -> Vec<StepMember> {
    db.prepare(SQL_READ_STEP_MEMBERS)
        .all(&[SqlParam::from(turn_id)])
        .iter()
        .map(|row| {
            let kind = row
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_call_id = if kind == "tool_call" || kind == "tool_result" {
                row.get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            } else {
                None
            };
            StepMember {
                message_id: row
                    .get("message_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                order: row
                    .get("source_event_order")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                kind,
                step_index: row.get("step_index").and_then(|v| v.as_i64()),
                tool_call_id,
            }
        })
        .collect()
}

pub fn step_edges(members: &[StepMember]) -> StepEdges {
    let mut steps: Vec<StepRange> = Vec::new();
    let mut splittable = true;
    let mut previous_index: i64 = -1;
    // Per step: calls awaiting a result, and results seen without their call.
    let mut open_calls: HashSet<String> = HashSet::new();
    let mut straddled = false;
    let mut call_step: HashMap<String, i64> = HashMap::new();

    fn close_step(steps: &mut [StepRange], open_calls: &HashSet<String>, straddled: bool) {
        if let Some(current) = steps.last_mut() {
            current.complete = open_calls.is_empty() && !straddled;
        }
    }

    for member in members {
        if !STEP_BEARING_KINDS.contains(&member.kind.as_str()) {
            continue;
        }
        let Some(step_index) = member.step_index else {
            splittable = false;
            continue;
        };
        if step_index != previous_index {
            if step_index != previous_index + 1 {
                splittable = false;
            }
            close_step(&mut steps, &open_calls, straddled);
            steps.push(StepRange {
                index: step_index,
                first_message_id: member.message_id.clone(),
                last_message_id: member.message_id.clone(),
                first_order: member.order,
                last_order: member.order,
                complete: false,
            });
            open_calls = HashSet::new();
            straddled = false;
            previous_index = step_index;
        }
        if let Some(current) = steps.last_mut() {
            current.last_message_id = member.message_id.clone();
            current.last_order = member.order;
        }
        if member.kind == "tool_call" {
            if let Some(id) = &member.tool_call_id {
                open_calls.insert(id.clone());
                call_step.insert(id.clone(), step_index);
            }
        }
        if member.kind == "tool_result" {
            if let Some(id) = &member.tool_call_id {
                let issued_in = call_step.get(id).copied();
                if issued_in == Some(step_index) && open_calls.contains(id) {
                    open_calls.remove(id);
                } else {
                    // Result before its call, in a different step, or with no
                    // call: the pair does not sit whole inside one step.
                    straddled = true;
                    splittable = false;
                }
            }
        }
    }
    close_step(&mut steps, &open_calls, straddled);

    let complete = steps.iter().take_while(|step| step.complete).count();
    if steps.is_empty() {
        splittable = false;
    }
    StepEdges {
        splittable,
        steps,
        complete,
        last_edge: if complete >= 2 {
            Some(complete - 1)
        } else {
            None
        },
    }
}
