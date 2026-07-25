//! Ported from packages/lhc/src/messages/internal/outcome.ts.
//!
//! Mechanical ToolOutcome stamping: the outcome on a tool-activity summary is a
//! pure function of the record — paired-result presence and its isError flag —
//! and nothing else.

use crate::shared_tech::derivation::ToolOutcome;

/// TS `{ isError: boolean }` argument shape for [`derive_tool_outcome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairedResult {
    pub is_error: bool,
}

pub fn derive_tool_outcome(paired_result: Option<PairedResult>) -> ToolOutcome {
    match paired_result {
        None => ToolOutcome::Unknown,
        Some(PairedResult { is_error: true }) => ToolOutcome::Failed,
        Some(PairedResult { is_error: false }) => ToolOutcome::Succeeded,
    }
}
