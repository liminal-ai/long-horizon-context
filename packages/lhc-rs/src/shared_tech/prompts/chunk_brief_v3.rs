//! Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v3.ts. Phase 1 skeleton.

use crate::shared_tech::derivation::InferenceRequestMessage;
use serde_json::Value;

pub const NAME: &str = "chunk-brief-v3";

pub const INSTRUCTIONS_OPEN: &str = r#"<instructions-for-summarizing>"#;

pub const INSTRUCTIONS_INTRO: &str = r#"You write brief memory notes from AI coding-session history. The note below replaces a longer stretch of conversation in an agent's memory, so it must carry what a future agent would otherwise have to rediscover: what was decided, what was corrected, what was learned, what was left open."#;

pub const JOB_TEMPLATE: &str = r#"Your job is to condense the following conversation summary down to roughly 5-10% of its original size — around ${statedAim} tokens total (roughly ${statedLo}-${statedHi}). Write it as past-tense narrative prose, not a transcript and not live instructions. Old plans read as history ("at that point the next step was..."), never as commands to the reader. Keep exact names, paths, numbers, and error text when they carry the meaning."#;

pub const INSTRUCTIONS_CLOSE: &str = r#"</instructions-for-summarizing>"#;

pub const CONTENT_OPEN: &str = r#"<content-for-summarizing>"#;

pub const CONTENT_CLOSE: &str = r#"</content-for-summarizing>"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkBriefV3Input {
    pub text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

pub struct ChunkBriefV3;

impl ChunkBriefV3 {
    pub const NAME: &'static str = NAME;

    pub fn render(_input: &ChunkBriefV3Input) -> Vec<InferenceRequestMessage> {
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
