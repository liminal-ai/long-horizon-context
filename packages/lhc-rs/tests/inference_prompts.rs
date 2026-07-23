//! Ported from packages/lhc/test/inference-prompts.test.ts. Phase 1.
//!
//! Exactly 25 runtime cases matching the TS suite (9 fixed + 8 golden + 8 embed).

mod fixtures;

use std::path::PathBuf;

use lhc::shared_tech::derivation::{
    InferenceRequestMessage, InferenceRequestRole, SummarizeChunkBriefInput,
    SummarizeToolResultInput,
};
use lhc::shared_tech::inference_adapter::create_inference_callbacks;
use lhc::shared_tech::inference_types::{
    ModelCall, ModelCallInput, ModelCallMessageRole, ResolvedInferenceConfig, resolve_guards,
};
use lhc::shared_tech::prompts::{
    DEFAULT_PROMPT_NAMES, PROMPT_NAMES, PROMPT_REGISTRY, registry_get,
};
use serde_json::{Value, json};

use fixtures::{FAKE_MODEL_PREFIX, canned_responses, recording_call, valid_assignments};

fn goldens_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/prompts")
}

struct PromptFixture {
    input: Value,
    embedded: &'static [&'static str],
}

fn fixture_for(name: &str) -> PromptFixture {
    match name {
        "smoothing-v1" => PromptFixture {
            input: json!({"text": "plz smooth this prmpt about src/app.ts line 42 thx"}),
            embedded: &[
                "src/app.ts line 42",
                "almost word-for-word",
                "Do not summarize.",
                "Do not answer the prompt.",
                "<system_instructions>",
                "<user_prompt_to_rewrite>",
            ],
        },
        "tool-result-v2" => PromptFixture {
            input: json!({
                "toolName": "read_file",
                "content": "contents of notes/plan.md: 3 open items",
                "outcome": "succeeded",
                "targetTokens": 120,
                "operationClass": "read",
                "responseShape": "file_content",
                "promptMode": "content_summary",
                "facts": {
                    "toolName": "read_file",
                    "outcome": "succeeded",
                    "targetPath": "notes/plan.md",
                    "operationClass": "read",
                    "responseShape": "file_content",
                    "outputChars": 39,
                },
            }),
            embedded: &[
                "contents of notes/plan.md: 3 open items",
                "succeeded",
                "120",
                "content_summary",
                "responseShape",
            ],
        },
        "detailed-turn-compression-v1" => PromptFixture {
            input: json!({
                "dialogueText": "User prompt\nPlease inspect notes/plan.md\n\nAssistant response\nIt has 3 open items.",
                "inputTokens": 120,
                "targetMinTokens": 42,
                "targetAimTokens": 60,
                "targetMaxTokens": 78,
            }),
            embedded: &[
                "notes/plan.md",
                "42-78",
                "Below is one exchange from a coding conversation.",
                "Preserve:",
                "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.",
                "If it is too short, expand it by restoring missing substance.",
                "If it is too long, contract it by removing lower-value detail and repeated explanation.",
                "<turn_rendering_to_compress>",
            ],
        },
        "detailed-turn-compression-v2" => PromptFixture {
            input: json!({
                "dialogueText": "User:\nPlease inspect notes/plan.md\n\nAssistant:\nIt has 3 open items.",
                "inputTokens": 120,
                "targetMinTokens": 42,
                "targetAimTokens": 60,
                "targetMaxTokens": 78,
            }),
            embedded: &[
                "notes/plan.md",
                "42-78",
                "user↔assistant dialogue",
                "30-50%",
                "Preserve:",
                "Remove:",
                "<dialogue_to_compress>",
            ],
        },
        "detailed-turn-compression-v3" => PromptFixture {
            input: json!({
                "dialogueText": "User:\nPlease inspect notes/plan.md\n\n⏺ It has 3 open items.",
                "inputTokens": 120,
                "targetMinTokens": 42,
                "targetAimTokens": 60,
                "targetMaxTokens": 78,
            }),
            embedded: &[
                "notes/plan.md",
                "around 30 tokens total (roughly 20-40)",
                "<instructions-for-summarizing>",
                "techincal",
                "targetting approximately 20%-30%",
                "⏺ represents the agent",
                "<content-for-summarizing>",
            ],
        },
        "chunk-brief-v1" => PromptFixture {
            input: json!({
                "memberProjections": ["turn one: read notes/plan.md", "turn two: edited src/app.ts"],
                "memberOutcomes": [["succeeded"], []],
            }),
            embedded: &[
                "turn two: edited src/app.ts",
                "Tool outcomes, in order: succeeded",
            ],
        },
        "chunk-brief-v2" => PromptFixture {
            input: json!({
                "text": "User inspected notes/plan.md and found 3 open items.",
                "inputTokens": 2000,
                "targetMinTokens": 160,
                "targetAimTokens": 240,
                "targetMaxTokens": 400,
            }),
            embedded: &[
                "historical memory",
                "160–400",
                "Aim for about 240",
                "<good-example-1-input>",
                "<bad-example-1-input>",
                "<bad-example-2-input>",
            ],
        },
        "chunk-brief-v3" => PromptFixture {
            input: json!({
                "text": "User inspected notes/plan.md and found 3 open items.",
                "inputTokens": 2000,
                "targetMinTokens": 160,
                "targetAimTokens": 240,
                "targetMaxTokens": 400,
            }),
            embedded: &[
                "notes/plan.md",
                "brief memory notes",
                "around 150 tokens total (roughly 100-200)",
                "<instructions-for-summarizing>",
                "past-tense narrative prose",
                "<content-for-summarizing>",
            ],
        },
        other => panic!("no fixture for {other}"),
    }
}

/// Resolve render through the registry entry's function pointer (TS
/// `PROMPT_REGISTRY[name].render`), not a separate match switch.
fn registry_render(name: &str, input: &Value) -> Vec<InferenceRequestMessage> {
    let entry = registry_get(name).unwrap_or_else(|| panic!("template \"{name}\" not in registry"));
    (entry.render)(input)
}

fn messages_to_json(messages: &[InferenceRequestMessage]) -> Value {
    Value::Array(
        messages
            .iter()
            .map(|m| {
                json!({
                    "role": match m.role {
                        InferenceRequestRole::System => "system",
                        InferenceRequestRole::User => "user",
                    },
                    "content": m.content,
                })
            })
            .collect(),
    )
}

fn assert_prompt_golden(name: &str) {
    let fixture = fixture_for(name);
    let rendered = registry_render(name, &fixture.input);
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(goldens_dir().join(format!("{name}.golden.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(
        messages_to_json(&rendered),
        golden,
        "golden mismatch for {name}"
    );
}

fn assert_prompt_embeds(name: &str) {
    let fixture = fixture_for(name);
    let rendered = registry_render(name, &fixture.input);
    let expected_users = if name == "smoothing-v1" { 2 } else { 1 };
    assert_eq!(
        rendered
            .iter()
            .filter(|m| m.role == InferenceRequestRole::User)
            .count(),
        expected_users
    );
    for message in &rendered {
        assert!(matches!(
            message.role,
            InferenceRequestRole::System | InferenceRequestRole::User
        ));
        // TS: expect(typeof message.content).toBe("string")
        let _: &str = message.content.as_str();
    }
    let joined: String = rendered
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    for needle in fixture.embedded {
        assert!(joined.contains(needle), "{name} missing {needle}");
    }
}

fn resolved_config(call: ModelCall, max_input_chars: Option<i64>) -> ResolvedInferenceConfig {
    ResolvedInferenceConfig {
        call,
        assignments: valid_assignments(None),
        guards: resolve_guards(None),
        timeout_ms: 60_000,
        max_input_chars: max_input_chars.unwrap_or(200_000),
    }
}

fn user_content(input: &ModelCallInput) -> String {
    input
        .messages
        .iter()
        .find(|m| m.role == ModelCallMessageRole::User)
        .map(|m| m.content.clone())
        .expect("no user message in rendered call")
}

fn raw_tool_response_excerpt(input: &ModelCallInput) -> String {
    let user = user_content(input);
    let marker = "Raw tool response excerpt:\n```text\n";
    let start = user
        .find(marker)
        .expect("no raw tool response marker in rendered call");
    let after = &user[start + marker.len()..];
    let end = after
        .find("\n```")
        .expect("no closing raw tool response fence in rendered call");
    after[..end].to_string()
}

fn inference_messages_to_model_call(rendered: Vec<InferenceRequestMessage>) -> ModelCallInput {
    let messages: Vec<_> = rendered
        .into_iter()
        .map(|m| lhc::shared_tech::inference_types::ModelCallMessage {
            role: match m.role {
                InferenceRequestRole::System => ModelCallMessageRole::System,
                InferenceRequestRole::User => ModelCallMessageRole::User,
            },
            content: m.content,
        })
        .collect();
    ModelCallInput {
        provider: "p".into(),
        model: "m".into(),
        messages,
        thinking: None,
    }
}

// --- 8 golden cases (TS loop) ------------------------------------------------

#[test]
fn smoothing_v1_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("smoothing-v1");
}

#[test]
fn tool_result_v2_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("tool-result-v2");
}

#[test]
fn detailed_turn_compression_v1_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("detailed-turn-compression-v1");
}

#[test]
fn detailed_turn_compression_v2_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("detailed-turn-compression-v2");
}

#[test]
fn detailed_turn_compression_v3_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("detailed-turn-compression-v3");
}

#[test]
fn chunk_brief_v1_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("chunk-brief-v1");
}

#[test]
fn chunk_brief_v2_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("chunk-brief-v2");
}

#[test]
fn chunk_brief_v3_renders_fixture_input_to_committed_golden() {
    assert_prompt_golden("chunk-brief-v3");
}

// --- 8 embedding/shape cases (TS loop) ---------------------------------------

#[test]
fn smoothing_v1_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("smoothing-v1");
}

#[test]
fn tool_result_v2_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("tool-result-v2");
}

#[test]
fn detailed_turn_compression_v1_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("detailed-turn-compression-v1");
}

#[test]
fn detailed_turn_compression_v2_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("detailed-turn-compression-v2");
}

#[test]
fn detailed_turn_compression_v3_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("detailed-turn-compression-v3");
}

#[test]
fn chunk_brief_v1_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("chunk-brief-v1");
}

#[test]
fn chunk_brief_v2_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("chunk-brief-v2");
}

#[test]
fn chunk_brief_v3_embeds_fixture_content_in_single_turn_shape() {
    assert_prompt_embeds("chunk-brief-v3");
}

// --- 9 fixed cases -----------------------------------------------------------

#[test]
fn every_registry_key_resolves_to_a_template_carrying_that_exact_name() {
    // TS: Object.keys(PROMPT_REGISTRY).length >= 4 and
    // PROMPT_REGISTRY[name].name === name && typeof render === "function".
    assert!(PROMPT_REGISTRY.len() >= 4);
    assert_eq!(PROMPT_NAMES.len(), PROMPT_REGISTRY.len());
    for (i, entry) in PROMPT_REGISTRY.iter().enumerate() {
        assert_eq!(
            entry.name, PROMPT_NAMES[i],
            "registry entry name must match catalog key order"
        );
        // typeof render === "function": store the fn item and type-check it.
        let f = entry.render;
        let _: fn(&Value) -> Vec<InferenceRequestMessage> = f;
        assert!(
            registry_get(entry.name).is_some_and(|e| e.name == entry.name),
            "registry_get must resolve {}",
            entry.name
        );
    }
}

#[test]
fn default_names_cover_all_inference_kinds_and_each_resolves_in_the_registry() {
    let mut default_names = std::collections::BTreeSet::new();
    for (kind, name) in DEFAULT_PROMPT_NAMES {
        assert!(
            PROMPT_REGISTRY.iter().any(|e| e.name == *name),
            "{kind} default {name} missing from registry"
        );
        assert!(registry_get(name).is_some());
        default_names.insert(*name);
    }
    assert_eq!(default_names.len(), DEFAULT_PROMPT_NAMES.len());
}

#[test]
fn chunk_brief_v2_golden_contains_framing_examples_self_check_and_anti_pattern_guidance() {
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(goldens_dir().join("chunk-brief-v2.golden.json")).unwrap(),
    )
    .unwrap();
    let content = golden
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    for needle in [
        "historical memory",
        "The target is a guide, not permission to lose essential meaning.",
        "Usually preserve:",
        "Compress by moving up one level:",
        "Old context must not sound like live instructions.",
        "<good-example-1-input>",
        "<good-example-1-output>",
        "<bad-example-1-input>",
        "<bad-example-1-output>",
        "<bad-example-2-input>",
        "<bad-example-2-output>",
        "Why this example matters:",
        "Before returning, check your draft:",
        "Avoid empty compression",
        "Avoid over-preserving local detail",
        "Avoid exhaustive checklists",
    ] {
        assert!(content.contains(needle), "missing {needle}");
    }
}

#[test]
fn does_not_render_operation_class_response_shape_output_chars_or_output_words() {
    let rendered = registry_render(
        "tool-result-v2",
        &json!({
            "toolName": "bash",
            "content": "zsh: nope: command not found\nCommand exited with code 127",
            "outcome": "failed",
            "targetTokens": 80,
            "operationClass": "command",
            "responseShape": "simple_failure",
            "promptMode": "failure",
            "facts": {
                "operationClass": "command",
                "responseShape": "simple_failure",
                "outputChars": 56,
                "outputWords": 8,
                "exitCode": 127,
                "failureType": "command_not_found",
            },
        }),
    );
    let joined: String = rendered
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let parsed_start = joined.find("Parsed fields:").unwrap();
    let parsed_end = joined.find("\nTool:").unwrap();
    let parsed_fields = &joined[parsed_start..parsed_end];
    assert!(!parsed_fields.contains("operationClass"));
    assert!(!parsed_fields.contains("responseShape"));
    assert!(!parsed_fields.contains("outputChars"));
    assert!(!parsed_fields.contains("outputWords"));
    assert!(joined.contains("\"exitCode\": 127"));
    assert!(joined.contains("\"failureType\": \"command_not_found\""));
}

#[test]
fn truncates_long_search_result_raw_output_by_line_count_before_prompt_rendering() {
    let content = (0..65)
        .map(|i| format!("match line {}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let rendered = registry_render(
        "tool-result-v2",
        &json!({
            "toolName": "rg",
            "content": content,
            "outcome": "succeeded",
            "targetTokens": 80,
            "responseShape": "search_result",
            "promptMode": "search_summary",
            "facts": {
                "toolName": "rg",
                "outcome": "succeeded",
                "responseShape": "search_result",
                "searchMatchCount": 65,
            },
        }),
    );
    let bounded = raw_tool_response_excerpt(&inference_messages_to_model_call(rendered));
    assert!(bounded.contains("match line 60"));
    assert!(!bounded.contains("match line 61"));
    assert!(bounded.contains(
        "[omitted 5 additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]"
    ));
}

#[tokio::test]
async fn brief_rendering_receives_detailed_text_and_target_tokens_through_the_adapter() {
    let receipt_account = "read_file fetched notes/plan.md and rewrote temp/out.txt";
    let built = recording_call(&canned_responses());
    let inference_callbacks = create_inference_callbacks(resolved_config(built.call, None));
    let brief = (inference_callbacks.summarize_chunk_brief)(SummarizeChunkBriefInput {
        text: format!("turn one: planning work without {receipt_account}"),
        input_tokens: 2000,
        target_min_tokens: 160,
        target_aim_tokens: 240,
        target_max_tokens: 400,
    })
    .await;
    assert!(matches!(brief, lhc::InferenceResult::Ok { .. }));
    let log = built.log.lock().unwrap();
    let brief_call = log
        .iter()
        .find(|inp| inp.model == format!("{FAKE_MODEL_PREFIX}chunk_summary_brief"));
    assert!(brief_call.is_some());
    let user = user_content(brief_call.unwrap());
    assert!(user.contains("turn one: planning work"));
    assert!(user.contains("around 150 tokens total (roughly 100-200)"));
    assert!(user.contains(receipt_account));
}

const MAX_INPUT_CHARS: i64 = 200;

#[tokio::test]
async fn oversized_summarize_tool_result_input_renders_head_tail_marker_under_max_input_chars() {
    let built = recording_call(&canned_responses());
    let inference_callbacks =
        create_inference_callbacks(resolved_config(built.call, Some(MAX_INPUT_CHARS)));
    let content = format!("{}{}{}", "H".repeat(150), "M".repeat(700), "T".repeat(150));
    let result = (inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
        tool_name: "read_file".into(),
        content: content.clone(),
        outcome: None,
        target_tokens: None,
        operation_class: None,
        response_shape: None,
        prompt_mode: None,
        facts: None,
    })
    .await;
    assert!(matches!(result, lhc::InferenceResult::Ok { .. }));
    let log = built.log.lock().unwrap();
    assert!(!log.is_empty());
    let inp = &log[0];
    let user = user_content(inp);
    let bounded = raw_tool_response_excerpt(inp);
    assert!(bounded.len() as i64 <= MAX_INPUT_CHARS);
    assert!(bounded.starts_with("HHHH"));
    assert!(bounded.ends_with("TTTT"));
    assert!(bounded.contains("truncated"));
    assert!(!user.contains(&"M".repeat(50)));
}

#[tokio::test]
async fn max_input_chars_below_truncation_marker_still_bounds_the_whole() {
    let built = recording_call(&canned_responses());
    let tiny_max = 40;
    let inference_callbacks =
        create_inference_callbacks(resolved_config(built.call, Some(tiny_max)));
    let content = format!("{}{}{}", "H".repeat(40), "M".repeat(700), "T".repeat(40));
    let result = (inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
        tool_name: "read_file".into(),
        content: content.clone(),
        outcome: None,
        target_tokens: None,
        operation_class: None,
        response_shape: None,
        prompt_mode: None,
        facts: None,
    })
    .await;
    assert!(matches!(result, lhc::InferenceResult::Ok { .. }));
    let log = built.log.lock().unwrap();
    let inp = &log[0];
    let user = user_content(inp);
    let bounded = raw_tool_response_excerpt(inp);
    assert!(bounded.len() as i64 <= tiny_max);
    assert!(content.starts_with(&bounded));
    assert!(!bounded.contains("truncated"));
    assert!(!user.contains(&"M".repeat(50)));
}

#[tokio::test]
async fn under_limit_input_renders_whole_no_marker() {
    let built = recording_call(&canned_responses());
    let inference_callbacks =
        create_inference_callbacks(resolved_config(built.call, Some(MAX_INPUT_CHARS)));
    let content = "W".repeat(MAX_INPUT_CHARS as usize);
    let result = (inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
        tool_name: "read_file".into(),
        content: content.clone(),
        outcome: None,
        target_tokens: None,
        operation_class: None,
        response_shape: None,
        prompt_mode: None,
        facts: None,
    })
    .await;
    assert!(matches!(result, lhc::InferenceResult::Ok { .. }));
    let log = built.log.lock().unwrap();
    let inp = &log[0];
    let user = user_content(inp);
    let bounded = raw_tool_response_excerpt(inp);
    assert_eq!(bounded, content);
    assert!(!user.contains("truncated"));
}
