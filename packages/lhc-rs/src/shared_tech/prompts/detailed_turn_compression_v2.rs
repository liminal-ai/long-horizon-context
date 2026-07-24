//! Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v2.ts.

use crate::shared_tech::derivation::{InferenceRequestMessage, InferenceRequestRole};
use serde_json::Value;

pub const NAME: &str = "detailed-turn-compression-v2";

pub const SYSTEM_PART_00: &str =
    r#"Below is a user↔assistant dialogue from a coding conversation."#;

pub const SYSTEM_PART_01: &str = r#""#;

pub const SYSTEM_TMPL_02: &str = r#"It is about ${dialogue.inputTokens} tokens long."#;

pub const SYSTEM_PART_03: &str = r#""#;

pub const SYSTEM_TMPL_04: &str = r#"Compress it to about ${dialogue.targetAimTokens} tokens (roughly 30-50% of the input). The final output must fall within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_05: &str = r#""#;

pub const SYSTEM_PART_06: &str =
    r#"Write the compressed version as compact prose in the same dialogue register."#;

pub const SYSTEM_PART_07: &str = r#""#;

pub const SYSTEM_PART_08: &str = r#"Preserve:"#;

pub const SYSTEM_PART_09: &str = r#"- user constraints, corrections, decisions, and preferences"#;

pub const SYSTEM_PART_10: &str = r#"- exact identifiers: file paths, commands, model names, numbers, errors, test results, commit hashes"#;

pub const SYSTEM_PART_11: &str = r#"- decisions made during the exchange"#;

pub const SYSTEM_PART_12: &str = r#"- outcomes and conclusions the assistant stated"#;

pub const SYSTEM_PART_13: &str = r#""#;

pub const SYSTEM_PART_14: &str = r#"Remove:"#;

pub const SYSTEM_PART_15: &str = r#"- pleasantries and repeated acknowledgements"#;

pub const SYSTEM_PART_16: &str = r#"- repetition and meta-commentary"#;

pub const SYSTEM_PART_17: &str = r#"- filler that does not change what happened"#;

pub const SYSTEM_PART_18: &str = r#""#;

pub const SYSTEM_TMPL_19: &str = r#"Before returning, estimate whether the output is within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_20: &str = r#"If it is too short, expand it by restoring missing substance."#;

pub const SYSTEM_PART_21: &str =
    r#"If it is too long, contract it by removing lower-value detail and repeated explanation."#;

pub const SYSTEM_PART_22: &str = r#""#;

pub const SYSTEM_TMPL_23: &str = r#"The final answer must be within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."#;

pub const SYSTEM_PART_24: &str = r#""#;

pub const SYSTEM_PART_25: &str = r#"Rewrite only the text inside <dialogue_to_compress>."#;

pub const SYSTEM_PART_26: &str = r#"Return only the compressed dialogue, without XML tags."#;

pub const USER_WRAPPER_PREFIX: &str = r#"<dialogue_to_compress>
"#;

pub const USER_WRAPPER_SUFFIX: &str = r#"
</dialogue_to_compress>"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedTurnCompressionV2Input {
    pub dialogue_text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

pub struct DetailedTurnCompressionV2;

impl DetailedTurnCompressionV2 {
    pub const NAME: &'static str = NAME;

    pub fn render(dialogue: &DetailedTurnCompressionV2Input) -> Vec<InferenceRequestMessage> {
        let tmpl_02 = SYSTEM_TMPL_02.replace(
            "${dialogue.inputTokens}",
            &dialogue.input_tokens.to_string(),
        );
        let tmpl_04 = SYSTEM_TMPL_04
            .replace(
                "${dialogue.targetAimTokens}",
                &dialogue.target_aim_tokens.to_string(),
            )
            .replace(
                "${dialogue.targetMinTokens}",
                &dialogue.target_min_tokens.to_string(),
            )
            .replace(
                "${dialogue.targetMaxTokens}",
                &dialogue.target_max_tokens.to_string(),
            );
        let tmpl_19 = SYSTEM_TMPL_19
            .replace(
                "${dialogue.targetMinTokens}",
                &dialogue.target_min_tokens.to_string(),
            )
            .replace(
                "${dialogue.targetMaxTokens}",
                &dialogue.target_max_tokens.to_string(),
            );
        let tmpl_23 = SYSTEM_TMPL_23
            .replace(
                "${dialogue.targetMinTokens}",
                &dialogue.target_min_tokens.to_string(),
            )
            .replace(
                "${dialogue.targetMaxTokens}",
                &dialogue.target_max_tokens.to_string(),
            );
        let system_content = [
            SYSTEM_PART_00,
            SYSTEM_PART_01,
            tmpl_02.as_str(),
            SYSTEM_PART_03,
            tmpl_04.as_str(),
            SYSTEM_PART_05,
            SYSTEM_PART_06,
            SYSTEM_PART_07,
            SYSTEM_PART_08,
            SYSTEM_PART_09,
            SYSTEM_PART_10,
            SYSTEM_PART_11,
            SYSTEM_PART_12,
            SYSTEM_PART_13,
            SYSTEM_PART_14,
            SYSTEM_PART_15,
            SYSTEM_PART_16,
            SYSTEM_PART_17,
            SYSTEM_PART_18,
            tmpl_19.as_str(),
            SYSTEM_PART_20,
            SYSTEM_PART_21,
            SYSTEM_PART_22,
            tmpl_23.as_str(),
            SYSTEM_PART_24,
            SYSTEM_PART_25,
            SYSTEM_PART_26,
        ]
        .join("\n");
        vec![
            InferenceRequestMessage {
                role: InferenceRequestRole::System,
                content: system_content,
            },
            InferenceRequestMessage {
                role: InferenceRequestRole::User,
                content: format!(
                    "{USER_WRAPPER_PREFIX}{}{USER_WRAPPER_SUFFIX}",
                    dialogue.dialogue_text
                ),
            },
        ]
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(input: &Value) -> Vec<InferenceRequestMessage> {
    let input: DetailedTurnCompressionV2Input =
        serde_json::from_value(input.clone()).expect("detailed-turn-compression-v2 input");
    DetailedTurnCompressionV2::render(&input)
}
