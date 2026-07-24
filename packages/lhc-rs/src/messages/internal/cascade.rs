//! Ported from packages/lhc/src/messages/internal/cascade.ts. Phase 1 skeleton.
//!
//! CascadeClear (Wave 3) + CascadeOutcome. TS `REBUILD_KIND_ORDER: Record<WorkKind, number>`
//! → private exhaustive `rebuild_kind_order` (Wave 0 closed-Record ruling).
//! `DERIVATION_REBUILD_KINDS` stays an ordered map (open-string Record). SQL
//! literals private (TS module-local). Cascade helpers `todo!("phase 2")`.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::SubjectKind;
use crate::shared_tech::persist::DbWriteTransaction;
use crate::shared_tech::storage::Db;
use crate::shared_tech::work_queue::{EnqueueDerivationTarget, WorkKind, WorkSourceRef};

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
#[allow(dead_code)]
const SQL_CHAIN_TURN: &str = r#"SELECT turn_id FROM message WHERE message_id = ?"#;
#[allow(dead_code)]
const SQL_CHAIN_CHUNK: &str = r#"SELECT chunk_id FROM chunk_member WHERE turn_id = ?"#;
#[allow(dead_code)]
const SQL_PAIRED_OWN_BLOCK: &str = r#"SELECT block_type, json_extract(content, '$.toolCallId') AS tool_call_id
       FROM message_block
       WHERE message_id = ? AND block_type IN ('tool_call', 'tool_result')
       LIMIT 1"#;
#[allow(dead_code)]
const SQL_PAIRED_COUNTERPART: &str = r#"SELECT m.message_id FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
         AND m.message_id <> ?
       ORDER BY m.source_event_order LIMIT 1"#;
#[allow(dead_code)]
const SQL_READ_DERIVATIONS: &str = r#"SELECT derivation_type, source_version FROM derivation
     WHERE subject_kind = ? AND subject_id = ? ORDER BY derivation_type"#;
#[allow(dead_code)]
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

fn source_ref_for(_subject: &ChainSubject) -> WorkSourceRef {
    todo!("phase 2")
}

fn chain_subjects(_db: &Db, _message_id: &str) -> Vec<ChainSubject> {
    todo!("phase 2")
}

fn paired_counterpart_subject(_db: &Db, _message_id: &str) -> Option<ChainSubject> {
    todo!("phase 2")
}

#[allow(dead_code)]
struct RebuildGroup {
    subject: ChainSubject,
    kind: WorkKind,
    derivations: Vec<EnqueueDerivationTarget>,
    max_source_version: i64,
}

fn rebuild_kind_for(_derivation_type: &str) -> WorkKind {
    todo!("phase 2")
}

fn run_cascade(
    _transaction: &DbWriteTransaction,
    _drop_subjects: &[ChainSubject],
    _clear_subjects: &[ChainSubject],
) -> CascadeOutcome {
    todo!("phase 2")
}

pub fn cascade_from_message(
    _transaction: &DbWriteTransaction,
    _message_id: &str,
) -> CascadeOutcome {
    todo!("phase 2")
}

pub fn cascade_message_delete(
    _transaction: &DbWriteTransaction,
    _message_id: &str,
) -> CascadeOutcome {
    todo!("phase 2")
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
