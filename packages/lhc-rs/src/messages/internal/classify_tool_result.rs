//! Ported from packages/lhc/src/messages/internal/classify-tool-result.ts.
//! Phase 1 skeleton.
//!
//! EXEMPLAR MODULE — canonical pattern for a logic module. Public surface
//! plus every private helper (TS non-exported functions stay private fns),
//! all with full signatures and `todo!("phase 2")` bodies. The regex-heavy
//! bodies port in Phase 2; JS→Rust regex dialect notes belong there (the
//! `regex` crate lacks lookaround — `parseExitCode`-family patterns using
//! `(?!0\b)` need `fancy-regex` or a rewrite; JS `\b`/`\w` are ASCII-only
//! while Rust's default is Unicode-aware — match the JS semantics).

use serde_json::Value;

use crate::shared_tech::derivation::{
    ToolOutcome, ToolResultClassification, ToolResultFacts, ToolResultOperationClass,
    ToolResultPromptMode, ToolResultResponseShape,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultClassificationInput {
    pub tool_name: String,
    pub tool_input: Option<serde_json::Map<String, Value>>,
    pub outcome: ToolOutcome,
    pub raw_output: String,
}

pub fn classify_tool_result(input: &ToolResultClassificationInput) -> ToolResultClassification {
    let _ = input;
    todo!("phase 2")
}

fn command_of(tool_input: Option<&serde_json::Map<String, Value>>) -> String {
    let _ = tool_input;
    todo!("phase 2")
}

fn classify_operation(
    tool_name: &str,
    tool_input: Option<&serde_json::Map<String, Value>>,
    raw_output: &str,
) -> ToolResultOperationClass {
    let _ = (tool_name, tool_input, raw_output);
    todo!("phase 2")
}

fn classify_shape(
    tool_name: &str,
    outcome: ToolOutcome,
    raw_output: &str,
    operation_class: ToolResultOperationClass,
) -> ToolResultResponseShape {
    let _ = (tool_name, outcome, raw_output, operation_class);
    todo!("phase 2")
}

fn prompt_mode_for(
    response_shape: ToolResultResponseShape,
    outcome: ToolOutcome,
) -> ToolResultPromptMode {
    let _ = (response_shape, outcome);
    todo!("phase 2")
}

fn parse_facts(
    input: &ToolResultClassificationInput,
    operation_class: ToolResultOperationClass,
    response_shape: ToolResultResponseShape,
) -> ToolResultFacts {
    let _ = (input, operation_class, response_shape);
    todo!("phase 2")
}

fn looks_like_test_runner_output(output: &str) -> bool {
    let _ = output;
    todo!("phase 2")
}

fn is_structured_receipt_output(output: &str) -> bool {
    let _ = output;
    todo!("phase 2")
}

fn is_search_no_match_output(output: &str) -> bool {
    let _ = output;
    todo!("phase 2")
}

fn search_content_lines(output: &str) -> Vec<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_search_match_count(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<i64> {
    let _ = (operation_class, output);
    todo!("phase 2")
}

fn parse_search_matches(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Vec<serde_json::Map<String, Value>> {
    let _ = (operation_class, output);
    todo!("phase 2")
}

fn parse_test_summary(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<serde_json::Map<String, Value>> {
    let _ = (operation_class, output);
    todo!("phase 2")
}

fn parse_subtool_results(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<Vec<serde_json::Map<String, Value>>> {
    let _ = (operation_class, output);
    todo!("phase 2")
}

fn parse_exit_code(output: &str) -> Option<i64> {
    let _ = output;
    todo!("phase 2")
}

fn parse_byte_count(output: &str) -> Option<i64> {
    let _ = output;
    todo!("phase 2")
}

fn parse_block_count(output: &str) -> Option<i64> {
    let _ = output;
    todo!("phase 2")
}

fn parse_match_count(output: &str) -> Option<i64> {
    let _ = output;
    todo!("phase 2")
}

fn parse_mutation_details_available(tool_name: &str, output: &str) -> Option<bool> {
    let _ = (tool_name, output);
    todo!("phase 2")
}

fn parse_failed_field(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_required_condition(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_retry_guidance(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_missing_command(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_system_error(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_failure_type(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_primary_path(output: &str) -> Option<String> {
    let _ = output;
    todo!("phase 2")
}

fn parse_path_mentions(output: &str) -> Vec<String> {
    let _ = output;
    todo!("phase 2")
}

fn trim_path(value: &str) -> String {
    let _ = value;
    todo!("phase 2")
}

/// TS `removeNullish`: drops null/undefined values and empty arrays from a
/// facts bag before it is stored.
fn remove_nullish(value: serde_json::Map<String, Value>) -> ToolResultFacts {
    let _ = value;
    todo!("phase 2")
}
