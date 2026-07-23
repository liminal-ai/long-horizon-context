//! Ported from packages/lhc/test/tool-result-classification.test.ts.
//! Phase 1 skeleton-expected: these tests call `todo!("phase 2")` bodies and
//! panic until Phase 2 lands — the gate classifies that as `notimpl`.
//!
//! EXEMPLAR TEST — canonical pattern for a vitest→cargo-test port:
//! - one `it(...)` → one `#[test]` fn, name snake_cased from the it-string
//! - `toBe`/`toEqual` → `assert_eq!`
//! - `toMatchObject` → field asserts on the typed struct plus `fact(...)`
//!   subset lookups on the facts bag (asserting only the named keys)
//! - `.not.toThrow()` → the call simply must return (a panic fails the test)

use serde_json::{Map, Value, json};

use lhc::messages::internal::classify_tool_result::{
    ToolResultClassificationInput, classify_tool_result,
};
use lhc::shared_tech::derivation::{
    ToolOutcome, ToolResultOperationClass, ToolResultPromptMode, ToolResultResponseShape,
};

fn input(
    tool_name: &str,
    tool_input: Option<Value>,
    outcome: ToolOutcome,
    raw_output: &str,
) -> ToolResultClassificationInput {
    ToolResultClassificationInput {
        tool_name: tool_name.to_string(),
        tool_input: tool_input.map(|v| match v {
            Value::Object(map) => map,
            other => panic!("tool_input fixture must be an object, got {other}"),
        }),
        outcome,
        raw_output: raw_output.to_string(),
    }
}

fn fact<'a>(facts: &'a Map<String, Value>, key: &str) -> &'a Value {
    facts
        .get(key)
        .unwrap_or_else(|| panic!("expected fact {key:?} to be present"))
}

#[test]
fn maps_tool_names_and_bash_commands_to_operation_classes() {
    assert_eq!(
        classify_tool_result(&input(
            "read",
            None,
            ToolOutcome::Succeeded,
            "export const value = 1;",
        ))
        .operation_class,
        ToolResultOperationClass::Read,
    );
    assert_eq!(
        classify_tool_result(&input(
            "write",
            None,
            ToolOutcome::Succeeded,
            "Successfully wrote 1234 bytes to src/file.ts",
        ))
        .operation_class,
        ToolResultOperationClass::MutationWrite,
    );
    assert_eq!(
        classify_tool_result(&input(
            "edit",
            None,
            ToolOutcome::Succeeded,
            "Successfully replaced 1 block(s) in src/file.ts",
        ))
        .operation_class,
        ToolResultOperationClass::MutationEdit,
    );
    assert_eq!(
        classify_tool_result(&input(
            "bash",
            Some(json!({"command": "rg TODO src"})),
            ToolOutcome::Succeeded,
            "src/file.ts:12:// TODO",
        ))
        .operation_class,
        ToolResultOperationClass::SearchOrListing,
    );
    assert_eq!(
        classify_tool_result(&input(
            "bash",
            Some(json!({"command": "pnpm test"})),
            ToolOutcome::Failed,
            "Tests 1 failed, 2 passed\nCommand exited with code 1",
        ))
        .operation_class,
        ToolResultOperationClass::Verification,
    );
    assert_eq!(
        classify_tool_result(&input(
            "bash",
            Some(json!({"command": "git diff -- src/file.ts"})),
            ToolOutcome::Succeeded,
            "diff --git a/src/file.ts b/src/file.ts",
        ))
        .operation_class,
        ToolResultOperationClass::VcsInspection,
    );
    assert_eq!(
        classify_tool_result(&input(
            "multi_tool_use.parallel",
            None,
            ToolOutcome::Unknown,
            "read package.json: succeeded, 1750 bytes returned.",
        ))
        .operation_class,
        ToolResultOperationClass::MultiTool,
    );
}

#[test]
fn extracts_deterministic_failure_facts_for_command_not_found_output() {
    let make = || {
        classify_tool_result(&input(
            "bash",
            Some(json!({"command": "frobnicate --version"})),
            ToolOutcome::Failed,
            "zsh: frobnicate: command not found\nCommand exited with code 127",
        ))
    };
    let first = make();
    let second = make();

    assert_eq!(first, second);
    assert_eq!(first.operation_class, ToolResultOperationClass::Command);
    assert_eq!(first.response_shape, ToolResultResponseShape::SimpleFailure);
    assert_eq!(first.prompt_mode, ToolResultPromptMode::Failure);
    assert_eq!(fact(&first.facts, "exitCode"), &json!(127));
    assert_eq!(
        fact(&first.facts, "failureType"),
        &json!("command_not_found")
    );
    assert_eq!(fact(&first.facts, "missingCommand"), &json!("frobnicate"));
    assert_eq!(
        fact(&first.facts, "retryGuidance"),
        &json!("install the command or invoke it through the project package runner"),
    );
}

#[test]
fn routes_receipt_and_test_shaped_responses_to_prompt_modes() {
    let receipt = classify_tool_result(&input(
        "write",
        None,
        ToolOutcome::Succeeded,
        "Successfully wrote 1234 bytes to path/file.ts",
    ));
    assert_eq!(
        receipt.response_shape,
        ToolResultResponseShape::StructuredReceipt
    );
    assert_eq!(receipt.prompt_mode, ToolResultPromptMode::Receipt);
    assert_eq!(fact(&receipt.facts, "targetPath"), &json!("path/file.ts"));
    assert_eq!(fact(&receipt.facts, "byteCount"), &json!(1234));
    assert_eq!(
        fact(&receipt.facts, "mutationDetailsAvailable"),
        &json!(false)
    );

    let tests = classify_tool_result(&input(
        "bash",
        Some(json!({"command": "pnpm test"})),
        ToolOutcome::Failed,
        "Tests 1 failed, 2 passed\nx writes output\nAssertionError: expected true\nCommand exited with code 1",
    ));
    assert_eq!(
        tests.operation_class,
        ToolResultOperationClass::Verification
    );
    assert_eq!(tests.response_shape, ToolResultResponseShape::TestResult);
    assert_eq!(tests.prompt_mode, ToolResultPromptMode::TestSummary);
    let summary = fact(&tests.facts, "testSummary");
    // expect.objectContaining: assert the named keys only.
    assert_eq!(summary.get("failed"), Some(&json!(1)));
    assert_eq!(summary.get("passed"), Some(&json!(2)));
    assert_eq!(summary.get("total"), Some(&json!(3)));
    assert_eq!(summary.get("exitCode"), Some(&json!(1)));
}

#[test]
fn handles_empty_and_very_large_unexpected_output_without_throwing() {
    // `.not.toThrow()`: returning at all is the assertion.
    let _ = classify_tool_result(&input("", None, ToolOutcome::Unknown, ""));
    let _ = classify_tool_result(&input(
        "bash",
        Some(json!({})),
        ToolOutcome::Succeeded,
        &"log line\n".repeat(50_000),
    ));
}
