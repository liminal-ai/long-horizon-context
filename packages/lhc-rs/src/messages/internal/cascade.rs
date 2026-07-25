//! Ported from packages/lhc/src/messages/internal/cascade.ts. Phase 1 skeleton.
//!
//! CascadeClear (Wave 3) + CascadeOutcome. TS `REBUILD_KIND_ORDER: Record<WorkKind, number>`
//! → private exhaustive `rebuild_kind_order` (Wave 0 closed-Record ruling).
//! `DERIVATION_REBUILD_KINDS` stays an ordered map (open-string Record). SQL
//! literals private (TS module-local).

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::SubjectKind;
use crate::shared_tech::persist::DbWriteTransaction;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, SupersedeTarget, WorkKind, WorkSourceRef, enqueue,
    supersede_queued, work_kind_registry,
};

/// TS `REBUILD_KIND_ORDER: Record<WorkKind, number>` — closed exhaustive fn.
/// Phase 2 sorts rebuild groups via `rebuild_kind_order(left.kind) - rebuild_kind_order(right.kind)`.
fn rebuild_kind_order(kind: WorkKind) -> i32 {
    match kind {
        WorkKind::PromptSmoothing => 0,
        WorkKind::ToolResultSummary => 1,
        WorkKind::TurnDerivation => 2,
        WorkKind::DetailedTurnCompression => 3,
        WorkKind::ChunkSummaryDetailed => 4,
        WorkKind::ChunkSummaryBrief => 5,
    }
}

/// TS `DERIVATION_REBUILD_KINDS: Record<string, WorkKind>` — open-string keys;
/// ordered map (Wave 0 closed-Record rule does not apply).
static DERIVATION_REBUILD_KINDS: LazyLock<IndexMap<&'static str, WorkKind>> = LazyLock::new(|| {
    let mut map = IndexMap::new();
    map.insert("smoothed_prompt", WorkKind::PromptSmoothing);
    map.insert("tool_result_summary", WorkKind::ToolResultSummary);
    map.insert("turn_rendering", WorkKind::TurnDerivation);
    map.insert("pre_detailed_assembly", WorkKind::TurnDerivation);
    map.insert(
        "detailed_turn_compression",
        WorkKind::DetailedTurnCompression,
    );
    map.insert("chunk_summary_detailed", WorkKind::ChunkSummaryDetailed);
    map.insert("chunk_summary_brief", WorkKind::ChunkSummaryBrief);
    map
});

// Private SQL literals (TS module-local). Referenced by Phase 2 cascade walk.
const SQL_CHAIN_TURN: &str = r#"SELECT turn_id FROM message WHERE message_id = ?"#;
const SQL_CHAIN_CHUNK: &str = r#"SELECT chunk_id FROM chunk_member WHERE turn_id = ?"#;
const SQL_PAIRED_OWN_BLOCK: &str = r#"SELECT block_type, json_extract(content, '$.toolCallId') AS tool_call_id
       FROM message_block
       WHERE message_id = ? AND block_type IN ('tool_call', 'tool_result')
       LIMIT 1"#;
const SQL_PAIRED_COUNTERPART: &str = r#"SELECT m.message_id FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
         AND m.message_id <> ?
       ORDER BY m.source_event_order LIMIT 1"#;
const SQL_READ_DERIVATIONS: &str = r#"SELECT derivation_type, source_version FROM derivation
     WHERE subject_kind = ? AND subject_id = ? ORDER BY derivation_type"#;
const SQL_DROP_DERIVATIONS: &str =
    r#"DELETE FROM derivation WHERE subject_kind = ? AND subject_id = ?"#;

/// TS `CascadeClear` — one cleared/dropped derivation target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeClear {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

/// TS cascade queued entry (distinct from MutationQueuedWork at the public boundary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeQueued {
    pub work_item_id: String,
    pub kind: WorkKind,
}

/// TS `CascadeOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeOutcome {
    pub cleared: Vec<CascadeClear>,
    pub dropped: Vec<CascadeClear>,
    pub queued: Vec<CascadeQueued>,
    pub superseded: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChainSubject {
    subject_kind: SubjectKind,
    subject_id: String,
}

fn source_ref_for(subject: &ChainSubject) -> WorkSourceRef {
    match subject.subject_kind {
        SubjectKind::Message => WorkSourceRef::Message {
            message_id: subject.subject_id.clone(),
        },
        SubjectKind::Turn => WorkSourceRef::Turn {
            turn_id: subject.subject_id.clone(),
        },
        SubjectKind::Chunk => WorkSourceRef::Chunk {
            chunk_id: subject.subject_id.clone(),
        },
    }
}

fn map_optional_str(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("column {key} not text: {other}"),
    }
}

fn map_required_str(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    map_optional_str(row, key).unwrap_or_else(|| panic!("missing column {key}"))
}

fn map_required_i64(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> i64 {
    match row.get(key) {
        // Reject non-integer REAL/string (no `f as i64` truncate). Integer
        // SQLite INTEGER and valid integer strings keep as_i64 / parse.
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| panic!("column {key} not integer")),
        Some(serde_json::Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

// The structural walk: the mutated message's turn from its membership stamp,
// the turn's chunk from its placement row. The chunk link may be absent for an
// unplaced turn, and the chain stops there. Deliberately unfiltered: the walk
// runs after a delete stamps its subject, and the chain above a just-deleted
// record is exactly what must still cascade.
fn chain_subjects(db: &Db, message_id: &str) -> Vec<ChainSubject> {
    let mut subjects = vec![ChainSubject {
        subject_kind: SubjectKind::Message,
        subject_id: message_id.to_string(),
    }];
    let turn_row = db
        .prepare(SQL_CHAIN_TURN)
        .get_params(&[SqlParam::from(message_id)]);
    let Some(turn_row) = turn_row else {
        return subjects;
    };
    let Some(turn_id) = map_optional_str(&turn_row, "turn_id") else {
        return subjects;
    };
    subjects.push(ChainSubject {
        subject_kind: SubjectKind::Turn,
        subject_id: turn_id.clone(),
    });
    let chunk_row = db
        .prepare(SQL_CHAIN_CHUNK)
        .get_params(&[SqlParam::from(turn_id.as_str())]);
    if let Some(chunk_row) = chunk_row {
        if let Some(chunk_id) = map_optional_str(&chunk_row, "chunk_id") {
            subjects.push(ChainSubject {
                subject_kind: SubjectKind::Chunk,
                subject_id: chunk_id,
            });
        }
    }
    subjects
}

// A tool summary derives from its message and paired counterpart, so mutating
// one half is a source change for the counterpart's summary. Find the live
// counterpart of a mutated tool message — the opposite block type sharing its
// toolCallId — as a clear subject, so the cascade clears and re-queues that
// summary alongside the rest of the chain. Returns nothing when the mutated
// message carries no tool block, or the counterpart is deleted or absent.
fn paired_counterpart_subject(db: &Db, message_id: &str) -> Option<ChainSubject> {
    let own = db
        .prepare(SQL_PAIRED_OWN_BLOCK)
        .get_params(&[SqlParam::from(message_id)])?;
    let tool_call_id = map_optional_str(&own, "tool_call_id")?;
    let block_type = map_required_str(&own, "block_type");
    let counterpart_type = if block_type == "tool_call" {
        "tool_result"
    } else {
        "tool_call"
    };
    let row = db.prepare(SQL_PAIRED_COUNTERPART).get_params(&[
        SqlParam::from(counterpart_type),
        SqlParam::from(tool_call_id.as_str()),
        SqlParam::from(message_id),
    ])?;
    Some(ChainSubject {
        subject_kind: SubjectKind::Message,
        subject_id: map_required_str(&row, "message_id"),
    })
}

struct RebuildGroup {
    subject: ChainSubject,
    kind: WorkKind,
    derivations: Vec<EnqueueDerivationTarget>,
    max_source_version: i64,
}

fn rebuild_kind_for(derivation_type: &str) -> WorkKind {
    match DERIVATION_REBUILD_KINDS.get(derivation_type) {
        Some(kind) => *kind,
        None => panic!("no rebuild work kind mapped for derivation {derivation_type}"),
    }
}

// Shared cascade core: drop subjects lose their derivation rows outright; clear
// subjects go pending at the next source version with replacement work
// enqueued. Supersede-deletes land before replacement enqueues so a tidied id
// can never collide, and queued items against dropped subjects are tidied with
// no replacement: dead work for a source that no longer reads.
fn run_cascade(
    transaction: &DbWriteTransaction<'_>,
    drop_subjects: &[ChainSubject],
    clear_subjects: &[ChainSubject],
) -> CascadeOutcome {
    let read_derivations = transaction.db.prepare(SQL_READ_DERIVATIONS);

    let mut dropped: Vec<CascadeClear> = Vec::new();
    let mut supersede_targets: Vec<SupersedeTarget> = Vec::new();
    let drop_rows = transaction.db.prepare(SQL_DROP_DERIVATIONS);
    for subject in drop_subjects {
        let rows = read_derivations.all(&[
            SqlParam::from(subject.subject_kind.as_str()),
            SqlParam::from(subject.subject_id.as_str()),
        ]);
        // Insertion-ordered like TS Set (derivations ORDER BY derivation_type).
        let mut kinds: IndexMap<WorkKind, ()> = IndexMap::new();
        for row in rows {
            let derivation_type = map_required_str(&row, "derivation_type");
            dropped.push(CascadeClear {
                subject_kind: subject.subject_kind,
                subject_id: subject.subject_id.clone(),
                derivation_type: derivation_type.clone(),
            });
            kinds.insert(rebuild_kind_for(&derivation_type), ());
        }
        for kind in kinds.keys().copied() {
            supersede_targets.push(SupersedeTarget {
                kind,
                source_ref: source_ref_for(subject),
            });
        }
        drop_rows.run(&[
            SqlParam::from(subject.subject_kind.as_str()),
            SqlParam::from(subject.subject_id.as_str()),
        ]);
    }

    let mut cleared: Vec<CascadeClear> = Vec::new();
    let mut groups: IndexMap<String, RebuildGroup> = IndexMap::new();
    for subject in clear_subjects {
        let rows = read_derivations.all(&[
            SqlParam::from(subject.subject_kind.as_str()),
            SqlParam::from(subject.subject_id.as_str()),
        ]);
        for row in rows {
            let derivation_type = map_required_str(&row, "derivation_type");
            cleared.push(CascadeClear {
                subject_kind: subject.subject_kind,
                subject_id: subject.subject_id.clone(),
                derivation_type: derivation_type.clone(),
            });
            let kind = rebuild_kind_for(&derivation_type);
            let key = format!(
                "{}:{}:{}",
                subject.subject_kind.as_str(),
                subject.subject_id,
                kind.as_str()
            );
            let source_version = map_required_i64(&row, "source_version");
            match groups.get_mut(&key) {
                Some(group) => {
                    group.derivations.push(EnqueueDerivationTarget {
                        subject_kind: subject.subject_kind,
                        subject_id: subject.subject_id.clone(),
                        derivation_type,
                    });
                    group.max_source_version = group.max_source_version.max(source_version);
                }
                None => {
                    groups.insert(
                        key,
                        RebuildGroup {
                            subject: subject.clone(),
                            kind,
                            derivations: vec![EnqueueDerivationTarget {
                                subject_kind: subject.subject_kind,
                                subject_id: subject.subject_id.clone(),
                                derivation_type,
                            }],
                            max_source_version: source_version,
                        },
                    );
                }
            }
        }
    }

    let mut all_supersede = supersede_targets;
    for group in groups.values() {
        all_supersede.push(SupersedeTarget {
            kind: group.kind,
            source_ref: source_ref_for(&group.subject),
        });
    }
    let superseded = supersede_queued(transaction.db, &all_supersede);

    let mut ordered_groups: Vec<&RebuildGroup> = groups.values().collect();
    ordered_groups
        .sort_by(|left, right| rebuild_kind_order(left.kind).cmp(&rebuild_kind_order(right.kind)));
    let queued = ordered_groups
        .into_iter()
        .map(|group| {
            let item = enqueue(
                transaction,
                EnqueueInput {
                    owner: work_kind_registry(group.kind).owner,
                    kind: group.kind,
                    source_ref: source_ref_for(&group.subject),
                    source_version: Some(group.max_source_version + 1),
                    derivations: group.derivations.clone(),
                    operation: None,
                },
            );
            CascadeQueued {
                work_item_id: item.work_item_id,
                kind: group.kind,
            }
        })
        .collect();

    CascadeOutcome {
        cleared,
        dropped,
        queued,
        superseded,
    }
}

// Edit's close path: clear-and-requeue for the full chain above (and
// including) the edited message, inside the mutation's ambient transaction.
// A call/result pair counterpart joins the clear set: editing one half is a
// source change for the other's summary.
pub fn cascade_from_message(
    transaction: &DbWriteTransaction<'_>,
    message_id: &str,
) -> CascadeOutcome {
    let mut clear = chain_subjects(transaction.db, message_id);
    if let Some(counterpart) = paired_counterpart_subject(transaction.db, message_id) {
        clear.push(counterpart);
    }
    run_cascade(transaction, &[], &clear)
}

// Message delete drops the deleted message's own derivations; its turn and
// chunk clear and re-queue for minus-one composition. Message-delete validation
// refuses turn-initiating prompts, so the turn always keeps members and never
// empties through this path.
pub fn cascade_message_delete(
    transaction: &DbWriteTransaction<'_>,
    message_id: &str,
) -> CascadeOutcome {
    let chain = chain_subjects(transaction.db, message_id);
    let (own, mut upward): (Option<ChainSubject>, Vec<ChainSubject>) = match chain.as_slice() {
        [] => (None, Vec::new()),
        [first, rest @ ..] => (Some(first.clone()), rest.to_vec()),
    };
    if let Some(counterpart) = paired_counterpart_subject(transaction.db, message_id) {
        upward.push(counterpart);
    }
    let drop_subjects = match own {
        Some(own) => vec![own],
        None => Vec::new(),
    };
    run_cascade(transaction, &drop_subjects, &upward)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_rebuild_kinds_keys_values_and_insertion_order() {
        let keys: Vec<_> = DERIVATION_REBUILD_KINDS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![
                "smoothed_prompt",
                "tool_result_summary",
                "turn_rendering",
                "pre_detailed_assembly",
                "detailed_turn_compression",
                "chunk_summary_detailed",
                "chunk_summary_brief",
            ]
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("smoothed_prompt"),
            Some(&WorkKind::PromptSmoothing)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("tool_result_summary"),
            Some(&WorkKind::ToolResultSummary)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("turn_rendering"),
            Some(&WorkKind::TurnDerivation)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("pre_detailed_assembly"),
            Some(&WorkKind::TurnDerivation)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("detailed_turn_compression"),
            Some(&WorkKind::DetailedTurnCompression)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("chunk_summary_detailed"),
            Some(&WorkKind::ChunkSummaryDetailed)
        );
        assert_eq!(
            DERIVATION_REBUILD_KINDS.get("chunk_summary_brief"),
            Some(&WorkKind::ChunkSummaryBrief)
        );
        // Exhaustive closed-Record values (mutation deleting an arm fails E0004).
        assert_eq!(rebuild_kind_order(WorkKind::PromptSmoothing), 0);
        assert_eq!(rebuild_kind_order(WorkKind::ToolResultSummary), 1);
        assert_eq!(rebuild_kind_order(WorkKind::TurnDerivation), 2);
        assert_eq!(rebuild_kind_order(WorkKind::DetailedTurnCompression), 3);
        assert_eq!(rebuild_kind_order(WorkKind::ChunkSummaryDetailed), 4);
        assert_eq!(rebuild_kind_order(WorkKind::ChunkSummaryBrief), 5);
    }
}
