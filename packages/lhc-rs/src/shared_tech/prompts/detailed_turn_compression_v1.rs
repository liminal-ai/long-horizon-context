//! Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v1.ts. Phase 1 skeleton.

use crate::shared_tech::derivation::InferenceRequestMessage;
use serde_json::Value;

pub const NAME: &str = "detailed-turn-compression-v1";

pub const SYSTEM_PART_00: &str = r#"Below is one exchange from a coding conversation."#;

pub const SYSTEM_PART_01: &str = r#""#;

pub const SYSTEM_TMPL_02: &str = r#"It is about ${i.inputTokens} tokens long."#;

pub const SYSTEM_PART_03: &str = r#""#;

pub const SYSTEM_TMPL_04: &str = r#"Shorten it to about ${i.targetAimTokens} tokens. The final output must fall within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_05: &str = r#""#;

pub const SYSTEM_PART_06: &str = r#"Write the shortened version as compact prose."#;

pub const SYSTEM_PART_07: &str = r#""#;

pub const SYSTEM_PART_08: &str = r#"Preserve:"#;

pub const SYSTEM_PART_09: &str = r#"- the user's request, correction, decision, or preference"#;

pub const SYSTEM_PART_10: &str = r#"- the agent's answer, action, mistake, or commitment"#;

pub const SYSTEM_PART_11: &str =
    r#"- the useful conclusion from thinking, if it affected the work"#;

pub const SYSTEM_PART_12: &str =
    r#"- the useful outcome from tool calls/results, if it affected the work"#;

pub const SYSTEM_PART_13: &str = r#"- concrete files, paths, commands, model names, numbers, errors, test results, and commit hashes"#;

pub const SYSTEM_PART_14: &str = r#"- unresolved questions or blocked work"#;

pub const SYSTEM_PART_15: &str = r#""#;

pub const SYSTEM_PART_16: &str = r#"Remove:"#;

pub const SYSTEM_PART_17: &str = r#"- raw thinking text"#;

pub const SYSTEM_PART_18: &str = r#"- raw tool output"#;

pub const SYSTEM_PART_19: &str = r#"- repeated acknowledgements"#;

pub const SYSTEM_PART_20: &str = r#"- apologies and status chatter"#;

pub const SYSTEM_PART_21: &str = r#"- local filler"#;

pub const SYSTEM_PART_22: &str = r#"- details that did not affect what happened next"#;

pub const SYSTEM_PART_23: &str = r#""#;

pub const SYSTEM_PART_24: &str = r#"Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do."#;

pub const SYSTEM_PART_25: &str = r#""#;

pub const SYSTEM_TMPL_26: &str = r#"Before returning, estimate whether the output is within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_27: &str = r#"If it is too short, expand it by restoring missing substance."#;

pub const SYSTEM_PART_28: &str =
    r#"If it is too long, contract it by removing lower-value detail and repeated explanation."#;

pub const SYSTEM_PART_29: &str = r#""#;

pub const SYSTEM_TMPL_30: &str =
    r#"The final answer must be within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_31: &str = r#""#;

pub const SYSTEM_PART_32: &str = r#"Rewrite only the text inside <turn_rendering_to_compress>."#;

pub const SYSTEM_PART_33: &str = r#"Return only the shortened exchange, without XML tags."#;

pub const USER_WRAPPER_PREFIX: &str = r#"<turn_rendering_to_compress>
"#;

pub const USER_WRAPPER_SUFFIX: &str = r#"
</turn_rendering_to_compress>"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedTurnCompressionV1Input {
    pub dialogue_text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

pub struct DetailedTurnCompressionV1;

impl DetailedTurnCompressionV1 {
    pub const NAME: &'static str = NAME;

    pub fn render(_input: &DetailedTurnCompressionV1Input) -> Vec<InferenceRequestMessage> {
        todo!("phase 2")
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(_input: &Value) -> Vec<InferenceRequestMessage> {
    todo!("phase 2")
}
