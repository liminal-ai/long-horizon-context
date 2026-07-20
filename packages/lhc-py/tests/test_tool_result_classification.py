"""Ported from packages/lhc/test/tool-result-classification.test.ts. Phase 1.

EXEMPLAR TEST — canonical pattern for porting a vitest file. `describe` becomes
the module docstring context, each `it(...)` becomes a test function keeping
the original description in its docstring. Dataclass fields are snake_case;
facts dict KEYS stay camelCase verbatim (they are data, not identifiers).
`toMatchObject` becomes per-field asserts; `expect(...).not.toThrow()` becomes
a bare call.
"""

from lhc.messages.internal.classify_tool_result import (
    ToolResultClassificationInput,
    classify_tool_result,
)


def test_maps_tool_names_and_bash_commands_to_operation_classes() -> None:
    """maps tool names and bash commands to operation classes"""
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="read",
                outcome="succeeded",
                raw_output="export const value = 1;",
            )
        ).operation_class
        == "read"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="write",
                outcome="succeeded",
                raw_output="Successfully wrote 1234 bytes to src/file.ts",
            )
        ).operation_class
        == "mutation_write"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="edit",
                outcome="succeeded",
                raw_output="Successfully replaced 1 block(s) in src/file.ts",
            )
        ).operation_class
        == "mutation_edit"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="bash",
                tool_input={"command": "rg TODO src"},
                outcome="succeeded",
                raw_output="src/file.ts:12:// TODO",
            )
        ).operation_class
        == "search_or_listing"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="bash",
                tool_input={"command": "pnpm test"},
                outcome="failed",
                raw_output="Tests 1 failed, 2 passed\nCommand exited with code 1",
            )
        ).operation_class
        == "verification"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="bash",
                tool_input={"command": "git diff -- src/file.ts"},
                outcome="succeeded",
                raw_output="diff --git a/src/file.ts b/src/file.ts",
            )
        ).operation_class
        == "vcs_inspection"
    )
    assert (
        classify_tool_result(
            ToolResultClassificationInput(
                tool_name="multi_tool_use.parallel",
                outcome="unknown",
                raw_output="read package.json: succeeded, 1750 bytes returned.",
            )
        ).operation_class
        == "multi_tool"
    )


def test_extracts_deterministic_failure_facts_for_command_not_found_output() -> None:
    """extracts deterministic failure facts for command-not-found output"""
    first = classify_tool_result(
        ToolResultClassificationInput(
            tool_name="bash",
            tool_input={"command": "frobnicate --version"},
            outcome="failed",
            raw_output="zsh: frobnicate: command not found\nCommand exited with code 127",
        )
    )
    second = classify_tool_result(
        ToolResultClassificationInput(
            tool_name="bash",
            tool_input={"command": "frobnicate --version"},
            outcome="failed",
            raw_output="zsh: frobnicate: command not found\nCommand exited with code 127",
        )
    )

    assert first == second
    assert first.operation_class == "command"
    assert first.response_shape == "simple_failure"
    assert first.prompt_mode == "failure"
    assert first.facts["exitCode"] == 127
    assert first.facts["failureType"] == "command_not_found"
    assert first.facts["missingCommand"] == "frobnicate"
    assert first.facts["retryGuidance"] == (
        "install the command or invoke it through the project package runner"
    )


def test_routes_receipt_and_test_shaped_responses_to_prompt_modes() -> None:
    """routes receipt and test-shaped responses to prompt modes"""
    receipt = classify_tool_result(
        ToolResultClassificationInput(
            tool_name="write",
            outcome="succeeded",
            raw_output="Successfully wrote 1234 bytes to path/file.ts",
        )
    )
    assert receipt.response_shape == "structured_receipt"
    assert receipt.prompt_mode == "receipt"
    assert receipt.facts["targetPath"] == "path/file.ts"
    assert receipt.facts["byteCount"] == 1234
    assert receipt.facts["mutationDetailsAvailable"] is False

    test_shaped = classify_tool_result(
        ToolResultClassificationInput(
            tool_name="bash",
            tool_input={"command": "pnpm test"},
            outcome="failed",
            raw_output=(
                "Tests 1 failed, 2 passed\nx writes output\n"
                "AssertionError: expected true\nCommand exited with code 1"
            ),
        )
    )
    assert test_shaped.operation_class == "verification"
    assert test_shaped.response_shape == "test_result"
    assert test_shaped.prompt_mode == "test_summary"
    test_summary = test_shaped.facts["testSummary"]
    assert isinstance(test_summary, dict)
    # expect.objectContaining — assert the named keys, allow extras.
    assert test_summary["failed"] == 1
    assert test_summary["passed"] == 2
    assert test_summary["total"] == 3
    assert test_summary["exitCode"] == 1


def test_handles_empty_and_very_large_unexpected_output_without_throwing() -> None:
    """handles empty and very large unexpected output without throwing"""
    classify_tool_result(
        ToolResultClassificationInput(
            tool_name="",
            outcome="unknown",
            raw_output="",
        )
    )
    classify_tool_result(
        ToolResultClassificationInput(
            tool_name="bash",
            tool_input={},
            outcome="succeeded",
            raw_output="log line\n" * 50_000,
        )
    )
