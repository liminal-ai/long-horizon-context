//! Ported from packages/lhc/src/messages/internal/derive.ts.
//! Wave 2 PARTIAL: `MessageDeriveResult` (canonical owner) + stub helpers.
//! Full derive bodies land with the messages wave.

use crate::shared_tech::errors::ErrorResult;

/// Closed derivation types a successful `messages.derive` may stamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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

/// TS `MessageDeriveResult` — tagged by `outcome`.
#[derive(Debug, Clone, PartialEq)]
pub enum MessageDeriveResult {
    Derived {
        message_id: String,
        derivation_type: MessageDeriveDerivationType,
        source_version: i64,
    },
    NotDerivable {
        message_id: String,
    },
    Failed {
        message_id: String,
        error: ErrorResult,
    },
}
