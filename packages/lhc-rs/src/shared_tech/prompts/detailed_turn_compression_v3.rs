//! Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts. Phase 1 skeleton.

use crate::shared_tech::derivation::InferenceRequestMessage;
use serde_json::Value;

pub const NAME: &str = "detailed-turn-compression-v3";

pub const INSTRUCTIONS_OPEN: &str = r#"<instructions-for-summarizing>"#;

pub const INSTRUCTIONS_INTRO: &str = r#"You condense dialogues from AI coding sessions so they can stand in for the original in a long-running conversation history. The condensed version is what the assistant will "remember" about this exchange later, so it must carry everything a future reader needs and nothing they don't."#;

pub const JOB_TEMPLATE: &str = r#"Your job is to summarize the following dialogue between a user and an llm assistant to 20% to 30% of its original size and turn the back and forth dialog into a narrative generally 3rd person voicing of the events unfolding across the back and forth. keep it in narrative past tense voicing targetting approximately 20%-30% of original size. That comes out to around ${statedAim} tokens total (roughly ${statedLo}-${statedHi}). Retain maximal meaning despite compression. > represents the user and ⏺ represents the agent."#;

pub const INSTRUCTIONS_PROSE: &str = r#"Write it as prose occasionally using bullets or headings as appropriate to what's being discussed or when techincal information needs to be retained. use best judgement on code blocks or fenced content as to whether to try and retain verbatim or simply create a fense and describe in parenthesis what was in the code block without reproducing based on best judgement as to how important that content or code block is"#;

pub const INSTRUCTIONS_CLOSE: &str = r#"</instructions-for-summarizing>"#;

pub const CONTENT_OPEN: &str = r#"<content-for-summarizing>"#;

pub const CONTENT_CLOSE: &str = r#"</content-for-summarizing>"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedTurnCompressionV3Input {
    pub dialogue_text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

pub struct DetailedTurnCompressionV3;

impl DetailedTurnCompressionV3 {
    pub const NAME: &'static str = NAME;

    pub fn render(_input: &DetailedTurnCompressionV3Input) -> Vec<InferenceRequestMessage> {
        todo!("phase 2")
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(_input: &Value) -> Vec<InferenceRequestMessage> {
    todo!("phase 2")
}

fn stated_target(_input_tokens: i64, _ratio: f64) -> i64 {
    todo!("phase 2")
}
