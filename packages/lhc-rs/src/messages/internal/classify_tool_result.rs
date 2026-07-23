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

pub fn classify_tool_result(_input: &ToolResultClassificationInput) -> ToolResultClassification {
    todo!("phase 2")
}

fn command_of(_tool_input: Option<&serde_json::Map<String, Value>>) -> String {
    todo!("phase 2")
}

fn classify_operation(
    _tool_name: &str,
    _tool_input: Option<&serde_json::Map<String, Value>>,
    _raw_output: &str,
) -> ToolResultOperationClass {
    todo!("phase 2")
}

fn classify_shape(
    _tool_name: &str,
    _outcome: ToolOutcome,
    _raw_output: &str,
    _operation_class: ToolResultOperationClass,
) -> ToolResultResponseShape {
    todo!("phase 2")
}

fn prompt_mode_for(
    _response_shape: ToolResultResponseShape,
    _outcome: ToolOutcome,
) -> ToolResultPromptMode {
    todo!("phase 2")
}

fn parse_facts(
    _input: &ToolResultClassificationInput,
    _operation_class: ToolResultOperationClass,
    _response_shape: ToolResultResponseShape,
) -> ToolResultFacts {
    todo!("phase 2")
}

fn looks_like_test_runner_output(_output: &str) -> bool {
    todo!("phase 2")
}

fn is_structured_receipt_output(_output: &str) -> bool {
    todo!("phase 2")
}

fn is_search_no_match_output(_output: &str) -> bool {
    todo!("phase 2")
}

fn search_content_lines(_output: &str) -> Vec<String> {
    todo!("phase 2")
}

fn parse_search_match_count(
    _operation_class: ToolResultOperationClass,
    _output: &str,
) -> Option<i64> {
    todo!("phase 2")
}

fn parse_search_matches(
    _operation_class: ToolResultOperationClass,
    _output: &str,
) -> Vec<serde_json::Map<String, Value>> {
    todo!("phase 2")
}

fn parse_test_summary(
    _operation_class: ToolResultOperationClass,
    _output: &str,
) -> Option<serde_json::Map<String, Value>> {
    todo!("phase 2")
}

fn parse_subtool_results(
    _operation_class: ToolResultOperationClass,
    _output: &str,
) -> Option<Vec<serde_json::Map<String, Value>>> {
    todo!("phase 2")
}

fn parse_exit_code(_output: &str) -> Option<i64> {
    todo!("phase 2")
}

fn parse_byte_count(_output: &str) -> Option<i64> {
    todo!("phase 2")
}

fn parse_block_count(_output: &str) -> Option<i64> {
    todo!("phase 2")
}

fn parse_match_count(_output: &str) -> Option<i64> {
    todo!("phase 2")
}

fn parse_mutation_details_available(_tool_name: &str, _output: &str) -> Option<bool> {
    todo!("phase 2")
}

fn parse_failed_field(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_required_condition(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_retry_guidance(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_missing_command(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_system_error(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_failure_type(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_primary_path(_output: &str) -> Option<String> {
    todo!("phase 2")
}

fn parse_path_mentions(_output: &str) -> Vec<String> {
    todo!("phase 2")
}

fn trim_path(_value: &str) -> String {
    todo!("phase 2")
}

/// TS `removeNullish`: drops null/undefined values and empty arrays from a
/// facts bag before it is stored.
fn remove_nullish(_value: serde_json::Map<String, Value>) -> ToolResultFacts {
    todo!("phase 2")
}
