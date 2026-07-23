//! Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v1.ts. Phase 1 skeleton.
//!
//! Pre-dial-in template kept under its versioned name for provenance.

use crate::shared_tech::derivation::{InferenceRequestMessage, ToolOutcome};
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

    pub fn render(_input: &ChunkBriefV1Input) -> Vec<InferenceRequestMessage> {
        todo!("phase 2")
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(_input: &Value) -> Vec<InferenceRequestMessage> {
    todo!("phase 2")
}

pub fn outcomes_section(_member_outcomes: Option<&[Vec<ToolOutcome>]>) -> String {
    todo!("phase 2")
}
