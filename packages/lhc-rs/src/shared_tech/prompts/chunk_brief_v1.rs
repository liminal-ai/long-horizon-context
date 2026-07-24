//! Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v1.ts.
//!
//! Pre-dial-in template kept under its versioned name for provenance.

use crate::shared_tech::derivation::{InferenceRequestMessage, InferenceRequestRole, ToolOutcome};
use serde_json::Value;

pub const NAME: &str = "chunk-brief-v1";

pub const SYSTEM_PROMPT: &str = r#"You write a brief summary of a sequence of conversation turns. State what was worked on and what was accomplished, and reflect the tool outcomes given. No detail beyond outcomes, no speculation, three sentences maximum."#;

pub const USER_TURNS_PREFIX: &str = r#"Turns, in order:

"#;

pub const OUTCOMES_SECTION_TEMPLATE: &str = r#"

Tool outcomes, in order: ${outcomes.join(", ")}"#;

pub const OUTCOMES_SECTION_PREFIX: &str = "\n\nTool outcomes, in order: ";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkBriefV1Input {
    pub member_projections: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_outcomes: Option<Vec<Vec<ToolOutcome>>>,
}

pub struct ChunkBriefV1;

impl ChunkBriefV1 {
    pub const NAME: &'static str = NAME;

    pub fn render(input: &ChunkBriefV1Input) -> Vec<InferenceRequestMessage> {
        let turns = input
            .member_projections
            .iter()
            .enumerate()
            .map(|(idx, member_text)| format!("{}. {member_text}", idx + 1))
            .collect::<Vec<_>>()
            .join("\n\n");
        let user = format!(
            "{USER_TURNS_PREFIX}{turns}{}",
            outcomes_section(input.member_outcomes.as_deref())
        );
        vec![
            InferenceRequestMessage {
                role: InferenceRequestRole::System,
                content: SYSTEM_PROMPT.to_string(),
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
    let input: ChunkBriefV1Input =
        serde_json::from_value(input.clone()).expect("chunk-brief-v1 input");
    ChunkBriefV1::render(&input)
}

pub fn outcomes_section(member_outcomes: Option<&[Vec<ToolOutcome>]>) -> String {
    let outcomes: Vec<&ToolOutcome> = member_outcomes
        .unwrap_or(&[])
        .iter()
        .flat_map(|m| m.iter())
        .collect();
    if outcomes.is_empty() {
        return String::new();
    }
    format!(
        "{OUTCOMES_SECTION_PREFIX}{}",
        outcomes
            .iter()
            .map(|o| o.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}
