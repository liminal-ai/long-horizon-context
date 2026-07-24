//! Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v3.ts.

use crate::shared_tech::derivation::{InferenceRequestMessage, InferenceRequestRole};
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

    pub fn render(input: &ChunkBriefV3Input) -> Vec<InferenceRequestMessage> {
        let stated_aim = stated_target(input.input_tokens, 0.075);
        let stated_lo = stated_target(input.input_tokens, 0.05);
        let stated_hi = stated_target(input.input_tokens, 0.1);
        let job = JOB_TEMPLATE
            .replace("${statedAim}", &stated_aim.to_string())
            .replace("${statedLo}", &stated_lo.to_string())
            .replace("${statedHi}", &stated_hi.to_string());
        let content = [
            INSTRUCTIONS_OPEN,
            INSTRUCTIONS_INTRO,
            "",
            job.as_str(),
            INSTRUCTIONS_CLOSE,
            "",
            CONTENT_OPEN,
            input.text.as_str(),
            CONTENT_CLOSE,
        ]
        .join("\n");
        vec![InferenceRequestMessage {
            role: InferenceRequestRole::User,
            content,
        }]
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(input: &Value) -> Vec<InferenceRequestMessage> {
    let input: ChunkBriefV3Input =
        serde_json::from_value(input.clone()).expect("chunk-brief-v3 input");
    ChunkBriefV3::render(&input)
}

fn stated_target(input_tokens: i64, ratio: f64) -> i64 {
    let raw = input_tokens as f64 * ratio;
    let step = if raw >= 1000.0 { 100.0 } else { 10.0 };
    // JS Math.round(raw / step) * step
    ((raw / step) + 0.5).floor() as i64 * step as i64
}
