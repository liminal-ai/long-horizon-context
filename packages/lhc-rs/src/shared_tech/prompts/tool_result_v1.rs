//! Ported from packages/lhc/src/shared-tech/prompts/tool-result-v1.ts. Phase 1 skeleton.

use crate::shared_tech::derivation::{InferenceRequestMessage, ToolOutcome};
use serde_json::Value;

pub const NAME: &str = "tool-result-v1";

pub const SYSTEM_TEMPLATE: &str = r#"You summarize tool output for an engineering record. Preserve the outcome/status exactly as "${i.outcome}". Target about ${i.targetTokens} tokens. ${i.guidance} No commentary, no speculation."#;

pub const USER_TEMPLATE: &str = r#"Tool: ${i.toolName}
Outcome: ${i.outcome}

Output:
${i.content}"#;

pub const SYSTEM_STATIC_PREFIX: &str = "You summarize tool output for an engineering record. Preserve the outcome/status exactly as \"";
pub const SYSTEM_STATIC_MID: &str = "\". Target about ";
pub const SYSTEM_STATIC_SUFFIX: &str = " No commentary, no speculation.";
pub const USER_STATIC_TOOL_PREFIX: &str = "Tool: ";
pub const USER_STATIC_OUTCOME_MID: &str = "\nOutcome: ";
pub const USER_STATIC_OUTPUT_MID: &str = "\n\nOutput:\n";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultV1Input {
    pub tool_name: String,
    pub content: String,
    pub outcome: ToolOutcome,
    pub target_tokens: i64,
    pub guidance: String,
}

pub struct ToolResultV1;

impl ToolResultV1 {
    pub const NAME: &'static str = NAME;

    pub fn render(_input: &ToolResultV1Input) -> Vec<InferenceRequestMessage> {
        todo!("phase 2")
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(_input: &Value) -> Vec<InferenceRequestMessage> {
    todo!("phase 2")
}
