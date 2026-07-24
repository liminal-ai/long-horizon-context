//! Ported from packages/lhc/src/shared-tech/prompts/tool-result-v1.ts.

use crate::shared_tech::derivation::{InferenceRequestMessage, InferenceRequestRole, ToolOutcome};
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

    pub fn render(input: &ToolResultV1Input) -> Vec<InferenceRequestMessage> {
        let system = format!(
            "{SYSTEM_STATIC_PREFIX}{}{SYSTEM_STATIC_MID}{} tokens. {}{SYSTEM_STATIC_SUFFIX}",
            input.outcome.as_str(),
            input.target_tokens,
            input.guidance,
        );
        let user = format!(
            "{USER_STATIC_TOOL_PREFIX}{}{USER_STATIC_OUTCOME_MID}{}{USER_STATIC_OUTPUT_MID}{}",
            input.tool_name,
            input.outcome.as_str(),
            input.content,
        );
        vec![
            InferenceRequestMessage {
                role: InferenceRequestRole::System,
                content: system,
            },
            InferenceRequestMessage {
                role: InferenceRequestRole::User,
                content: user,
            },
        ]
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(input: &Value) -> Vec<InferenceRequestMessage> {
    let input: ToolResultV1Input =
        serde_json::from_value(input.clone()).expect("tool-result-v1 input");
    ToolResultV1::render(&input)
}
