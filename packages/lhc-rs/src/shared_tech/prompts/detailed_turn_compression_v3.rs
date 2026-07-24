//! Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts.

use crate::shared_tech::derivation::{InferenceRequestMessage, InferenceRequestRole};
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

    pub fn render(dialogue: &DetailedTurnCompressionV3Input) -> Vec<InferenceRequestMessage> {
        let stated_aim = stated_target(dialogue.input_tokens, 0.25);
        let stated_lo = stated_target(dialogue.input_tokens, 0.2);
        let stated_hi = stated_target(dialogue.input_tokens, 0.3);
        let job = JOB_TEMPLATE
            .replace("${statedAim}", &stated_aim.to_string())
            .replace("${statedLo}", &stated_lo.to_string())
            .replace("${statedHi}", &stated_hi.to_string());
        let content = [
            INSTRUCTIONS_OPEN,
            INSTRUCTIONS_INTRO,
            "",
            job.as_str(),
            "",
            INSTRUCTIONS_PROSE,
            INSTRUCTIONS_CLOSE,
            "",
            CONTENT_OPEN,
            dialogue.dialogue_text.as_str(),
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
    let input: DetailedTurnCompressionV3Input =
        serde_json::from_value(input.clone()).expect("detailed-turn-compression-v3 input");
    DetailedTurnCompressionV3::render(&input)
}

fn stated_target(input_tokens: i64, ratio: f64) -> i64 {
    let raw = input_tokens as f64 * ratio;
    let step = if raw >= 1000.0 { 100.0 } else { 10.0 };
    // JS Math.round(raw / step) * step — floor(x + 0.5), not Rust .round()
    ((raw / step) + 0.5).floor() as i64 * step as i64
}
