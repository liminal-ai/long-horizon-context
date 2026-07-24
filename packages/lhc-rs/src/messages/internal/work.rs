//! Ported from packages/lhc/src/messages/internal/work.ts. Phase 1 skeleton.
//!
//! Mapping tables REAL (partial as TS); no behavior bodies.

use std::sync::LazyLock;

use indexmap::IndexMap;

use crate::intake_stream::EventKind;
use crate::shared_tech::work_queue::WorkKind;

/// Closed derivation types message work may stamp (`smoothed_prompt` |
/// `tool_result_summary`). Owns the MESSAGE_WORK_DERIVATIONS value vocab;
/// [`super::derive::MessageDeriveResult`] re-uses the same closed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDeriveDerivationType {
    SmoothedPrompt,
    ToolResultSummary,
}

impl MessageDeriveDerivationType {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageDeriveDerivationType::SmoothedPrompt => "smoothed_prompt",
            MessageDeriveDerivationType::ToolResultSummary => "tool_result_summary",
        }
    }
}

/// TS `MESSAGE_WORK_KINDS: Partial<Record<EventKind, WorkKind>>`.
pub static MESSAGE_WORK_KINDS: LazyLock<IndexMap<EventKind, WorkKind>> = LazyLock::new(|| {
    let mut map = IndexMap::new();
    map.insert(EventKind::UserPrompt, WorkKind::PromptSmoothing);
    map.insert(EventKind::ToolResult, WorkKind::ToolResultSummary);
    map
});

/// TS `MESSAGE_WORK_DERIVATIONS: Partial<Record<WorkKind, "smoothed_prompt" | "tool_result_summary">>`.
pub static MESSAGE_WORK_DERIVATIONS: LazyLock<IndexMap<WorkKind, MessageDeriveDerivationType>> =
    LazyLock::new(|| {
        let mut map = IndexMap::new();
        map.insert(
            WorkKind::PromptSmoothing,
            MessageDeriveDerivationType::SmoothedPrompt,
        );
        map.insert(
            WorkKind::ToolResultSummary,
            MessageDeriveDerivationType::ToolResultSummary,
        );
        map
    });

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_work_kinds_keys_values_and_insertion_order() {
        let keys: Vec<_> = MESSAGE_WORK_KINDS.keys().copied().collect();
        assert_eq!(keys, vec![EventKind::UserPrompt, EventKind::ToolResult]);
        assert_eq!(
            MESSAGE_WORK_KINDS.get(&EventKind::UserPrompt),
            Some(&WorkKind::PromptSmoothing)
        );
        assert_eq!(
            MESSAGE_WORK_KINDS.get(&EventKind::ToolResult),
            Some(&WorkKind::ToolResultSummary)
        );
    }

    #[test]
    fn message_work_derivations_keys_values_and_insertion_order() {
        let keys: Vec<_> = MESSAGE_WORK_DERIVATIONS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![WorkKind::PromptSmoothing, WorkKind::ToolResultSummary]
        );
        assert_eq!(
            MESSAGE_WORK_DERIVATIONS.get(&WorkKind::PromptSmoothing),
            Some(&MessageDeriveDerivationType::SmoothedPrompt)
        );
        assert_eq!(
            MESSAGE_WORK_DERIVATIONS.get(&WorkKind::ToolResultSummary),
            Some(&MessageDeriveDerivationType::ToolResultSummary)
        );
    }
}
