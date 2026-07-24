//! Ported from packages/lhc/src/shared-tech/prompts/tool-result-v2.ts.
//!
//! MODE_GUIDANCE and static prompt fragments are real and byte-identical.

use crate::shared_tech::derivation::{
    InferenceRequestMessage, InferenceRequestRole, ToolOutcome, ToolResultFacts,
    ToolResultPromptMode, ToolResultResponseShape,
};
use crate::shared_tech::js_json::{js_json_stringify_pretty, js_len, js_slice};
use serde_json::{Map, Value};

pub const NAME: &str = "tool-result-v2";

pub const MODE_GUIDANCE_RECEIPT: &str = r#"Write a concise tool-result receipt. Preserve status, concrete paths, counts, identifiers, and retry guidance. For write/edit receipts, do not infer changed content. If mutationDetailsAvailable is false, say the content/edit details were not available in the response when that matters. Do not quote the raw response."#;

pub const MODE_GUIDANCE_FAILURE: &str = r#"Write a concise failure receipt. Preserve what failed, why, the target path or command, exit code, and actionable retry guidance. Do not generalize away the concrete error."#;

pub const MODE_GUIDANCE_SEARCH_SUMMARY: &str = r#"Summarize the search/listing result. Preserve query/command if present, match or no-match status, relevant paths, counts, and key locations. Do not list every match unless the output is already small."#;

pub const MODE_GUIDANCE_TEST_SUMMARY: &str = r#"Write a compact verification receipt. Preserve command, final status, exit code, pass/fail counts, failed test names, and the core assertion/error reason. Prefer parsed testSummary over raw log detail. Do not list stack frames or every path. Keep it short unless multiple distinct failures need naming."#;

pub const MODE_GUIDANCE_CONTENT_SUMMARY: &str = r#"Summarize what the file/output contains that matters for future work. Preserve file path, major sections/exports/config, and important values. Do not restate full contents."#;

pub const MODE_GUIDANCE_DIFF_SUMMARY: &str = r#"Summarize changed files and nature of changes. Preserve insertion/deletion scale if available. Do not reproduce full diff."#;

pub const MODE_GUIDANCE_LARGE_LOG: &str = r#"Extract the final status, key errors, paths, counts, and next actionable facts. Drop repeated boilerplate and long logs."#;

pub const MODE_GUIDANCE_NO_OUTPUT: &str = r#"Write a concise receipt for a successful command that produced no output. Preserve the command and explain that no output means a clean/no-change result only if the parsed outcome says succeeded."#;

pub const MODE_GUIDANCE_MULTI_TOOL_SUMMARY: &str = r#"Summarize each subtool result separately. Preserve which subcalls succeeded or failed, missing paths/errors, and no-output clean statuses. Do not collapse mixed success/failure into one vague result."#;

pub const MODE_GUIDANCE_GENERIC_SUMMARY: &str = r#"Summarize the tool result for future coding context. Preserve concrete facts and avoid inventing missing details."#;

pub const TOOL_RESULT_V2_INTRO: &str =
    r#"Summarize this tool response for long-horizon coding context."#;

pub const TOOL_RESULT_V2_FACTS_RULE: &str = r#"Use the parsed fields as authoritative facts. Do not infer success or failure from prose. Do not mention details that are not in the parsed fields or raw response."#;

pub const TOOL_RESULT_V2_FIELD_RULE: &str = r#"Use parsed field values, but do not mention parsed field labels such as failureType, failedField, retryGuidance, matchCount, targetPath, responseShape, operationClass, mutationDetailsAvailable, searchNoMatches, noOutput, subtoolResults, or testSummary. Preserve paths, commands, identifiers, counts, and exit codes verbatim. Do not quote or label the raw response. Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what the parsed fields or raw response directly support."#;

pub const TOOL_RESULT_V2_TARGET_LENGTH_PREFIX: &str = r#"Target length: about "#;

pub const TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX: &str = r#" tokens."#;

pub const TOOL_RESULT_V2_PROMPT_MODE_PREFIX: &str = r#"Prompt mode: "#;

pub const TOOL_RESULT_V2_MODE_GUIDANCE_HEADER: &str = r#"Mode guidance:"#;

pub const TOOL_RESULT_V2_PARSED_FIELDS_HEADER: &str = r#"Parsed fields:"#;

pub const TOOL_RESULT_V2_USER_TOOL_PREFIX: &str = r#"Tool: "#;

pub const TOOL_RESULT_V2_USER_OUTCOME_PREFIX: &str = r#"
Outcome: "#;

pub const TOOL_RESULT_V2_USER_EXCERPT_OPEN: &str = r#"

Raw tool response excerpt:
```text
"#;

pub const TOOL_RESULT_V2_USER_EXCERPT_CLOSE: &str = r#"
```

Return only the summary."#;

pub const TOOL_RESULT_V2_SEARCH_OMIT_PREFIX: &str = r#"

[omitted "#;

pub const TOOL_RESULT_V2_SEARCH_OMIT_SUFFIX: &str = r#" additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]"#;

pub const TOOL_RESULT_V2_MIDDLE_OMIT_PREFIX: &str = r#"

[omitted "#;

pub const TOOL_RESULT_V2_MIDDLE_OMIT_SUFFIX: &str = r#" middle characters]

"#;

/// TS `MODE_GUIDANCE: Record<ToolResultPromptMode, string>` — exhaustive, no wildcard.
pub fn mode_guidance(mode: ToolResultPromptMode) -> &'static str {
    match mode {
        ToolResultPromptMode::Receipt => MODE_GUIDANCE_RECEIPT,
        ToolResultPromptMode::Failure => MODE_GUIDANCE_FAILURE,
        ToolResultPromptMode::SearchSummary => MODE_GUIDANCE_SEARCH_SUMMARY,
        ToolResultPromptMode::TestSummary => MODE_GUIDANCE_TEST_SUMMARY,
        ToolResultPromptMode::ContentSummary => MODE_GUIDANCE_CONTENT_SUMMARY,
        ToolResultPromptMode::DiffSummary => MODE_GUIDANCE_DIFF_SUMMARY,
        ToolResultPromptMode::LargeLog => MODE_GUIDANCE_LARGE_LOG,
        ToolResultPromptMode::NoOutput => MODE_GUIDANCE_NO_OUTPUT,
        ToolResultPromptMode::MultiToolSummary => MODE_GUIDANCE_MULTI_TOOL_SUMMARY,
        ToolResultPromptMode::GenericSummary => MODE_GUIDANCE_GENERIC_SUMMARY,
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultV2Input {
    pub tool_name: String,
    pub content: String,
    pub outcome: ToolOutcome,
    pub target_tokens: i64,
    pub prompt_mode: ToolResultPromptMode,
    pub response_shape: ToolResultResponseShape,
    pub facts: ToolResultFacts,
}

pub struct ToolResultV2;

impl ToolResultV2 {
    pub const NAME: &'static str = NAME;

    pub fn render(input: &ToolResultV2Input) -> Vec<InferenceRequestMessage> {
        let facts = facts_for_prompt(&input.facts);
        // TS: MODE_GUIDANCE[i.promptMode] ?? MODE_GUIDANCE.generic_summary
        let guidance = mode_guidance(input.prompt_mode);
        let target_line = format!(
            "{TOOL_RESULT_V2_TARGET_LENGTH_PREFIX}{}{TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX}",
            input.target_tokens
        );
        let mode_line = format!(
            "{TOOL_RESULT_V2_PROMPT_MODE_PREFIX}{}",
            input.prompt_mode.as_str()
        );
        let facts_json = js_json_stringify_pretty(&Value::Object(facts));
        let system_content = [
            TOOL_RESULT_V2_INTRO,
            "",
            TOOL_RESULT_V2_FACTS_RULE,
            "",
            TOOL_RESULT_V2_FIELD_RULE,
            "",
            target_line.as_str(),
            mode_line.as_str(),
            "",
            TOOL_RESULT_V2_MODE_GUIDANCE_HEADER,
            guidance,
            "",
            TOOL_RESULT_V2_PARSED_FIELDS_HEADER,
            facts_json.as_str(),
        ]
        .join("\n");
        let user_content = format!(
            "{TOOL_RESULT_V2_USER_TOOL_PREFIX}{}{TOOL_RESULT_V2_USER_OUTCOME_PREFIX}{}{TOOL_RESULT_V2_USER_EXCERPT_OPEN}{}{TOOL_RESULT_V2_USER_EXCERPT_CLOSE}",
            input.tool_name,
            input.outcome.as_str(),
            raw_output_for_prompt(&input.content, input.response_shape),
        );
        vec![
            InferenceRequestMessage {
                role: InferenceRequestRole::System,
                content: system_content,
            },
            InferenceRequestMessage {
                role: InferenceRequestRole::User,
                content: user_content,
            },
        ]
    }
}

/// Type-erased registry dispatch (TS `PromptTemplate.render`).
pub fn render_value(input: &Value) -> Vec<InferenceRequestMessage> {
    let input: ToolResultV2Input =
        serde_json::from_value(input.clone()).expect("tool-result-v2 input");
    ToolResultV2::render(&input)
}

fn facts_for_prompt(facts: &ToolResultFacts) -> Map<String, Value> {
    let excluded = [
        "operationClass",
        "responseShape",
        "outputChars",
        "outputWords",
    ];
    facts
        .iter()
        .filter(|(key, _)| !excluded.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn raw_output_for_prompt(raw_output: &str, response_shape: ToolResultResponseShape) -> String {
    let lines: Vec<&str> = split_js_lines(raw_output);
    if response_shape == ToolResultResponseShape::SearchResult && lines.len() > 60 {
        return format!(
            "{}{TOOL_RESULT_V2_SEARCH_OMIT_PREFIX}{}{TOOL_RESULT_V2_SEARCH_OMIT_SUFFIX}",
            lines[..60].join("\n"),
            lines.len() - 60,
        );
    }
    // TS: rawOutput.length / slice — UTF-16 code units.
    if js_len(raw_output) > 20_000 {
        let head = js_slice(raw_output, 0, Some(12_000));
        let tail = js_slice(raw_output, -4_000, None);
        return format!(
            "{head}{TOOL_RESULT_V2_MIDDLE_OMIT_PREFIX}{}{TOOL_RESULT_V2_MIDDLE_OMIT_SUFFIX}{tail}",
            js_len(raw_output) - js_len(&head) - js_len(&tail),
        );
    }
    raw_output.to_string()
}

/// JS `String.prototype.split(/\r?\n/)`.
fn split_js_lines(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            lines.push(&s[start..i]);
            i += 2;
            start = i;
        } else if bytes[i] == b'\n' {
            lines.push(&s[start..i]);
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    lines.push(&s[start..]);
    lines
}
