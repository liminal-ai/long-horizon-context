"""Ported from packages/lhc/src/messages/internal/classify-tool-result.ts. Phase 1 skeleton.

EXEMPLAR MODULE — canonical pattern for a logic module. Public surface plus
every private helper (TS non-exported functions become _underscore-prefixed),
all with full signatures and NotImplementedError bodies. The regex-heavy
bodies port in Phase 2; JS→Python regex translation notes belong there.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...shared_tech.derivation import (
    ToolOutcome,
    ToolResultClassification,
    ToolResultOperationClass,
    ToolResultPromptMode,
    ToolResultResponseShape,
)


@dataclass(frozen=True, slots=True)
class ToolResultClassificationInput:
    tool_name: str
    outcome: ToolOutcome
    raw_output: str
    tool_input: dict[str, object] | None = None


def classify_tool_result(input: ToolResultClassificationInput) -> ToolResultClassification:
    raise NotImplementedError


def _command_of(tool_input: dict[str, object] | None) -> str:
    raise NotImplementedError


def _classify_operation(
    tool_name: str,
    tool_input: dict[str, object] | None,
    raw_output: str,
) -> ToolResultOperationClass:
    raise NotImplementedError


def _classify_shape(
    tool_name: str,
    outcome: ToolOutcome,
    raw_output: str,
    operation_class: ToolResultOperationClass,
) -> ToolResultResponseShape:
    raise NotImplementedError


def _prompt_mode_for(response_shape: ToolResultResponseShape, outcome: ToolOutcome) -> ToolResultPromptMode:
    raise NotImplementedError


def _parse_facts(
    input: ToolResultClassificationInput,
    operation_class: ToolResultOperationClass,
    response_shape: ToolResultResponseShape,
) -> dict[str, object]:
    raise NotImplementedError


def _looks_like_test_runner_output(output: str) -> bool:
    raise NotImplementedError


def _is_structured_receipt_output(output: str) -> bool:
    raise NotImplementedError


def _is_search_no_match_output(output: str) -> bool:
    raise NotImplementedError


def _search_content_lines(output: str) -> list[str]:
    raise NotImplementedError


def _parse_search_match_count(operation_class: ToolResultOperationClass, output: str) -> int | None:
    raise NotImplementedError


def _parse_search_matches(operation_class: ToolResultOperationClass, output: str) -> list[dict[str, object]]:
    raise NotImplementedError


def _parse_test_summary(operation_class: ToolResultOperationClass, output: str) -> dict[str, object] | None:
    raise NotImplementedError


def _parse_subtool_results(
    operation_class: ToolResultOperationClass,
    output: str,
) -> list[dict[str, object]] | None:
    raise NotImplementedError


def _parse_exit_code(output: str) -> int | None:
    raise NotImplementedError


def _parse_byte_count(output: str) -> int | None:
    raise NotImplementedError


def _parse_block_count(output: str) -> int | None:
    raise NotImplementedError


def _parse_match_count(output: str) -> int | None:
    raise NotImplementedError


def _parse_mutation_details_available(tool_name: str, output: str) -> bool | None:
    raise NotImplementedError


def _parse_failed_field(output: str) -> str | None:
    raise NotImplementedError


def _parse_required_condition(output: str) -> str | None:
    raise NotImplementedError


def _parse_retry_guidance(output: str) -> str | None:
    raise NotImplementedError


def _parse_missing_command(output: str) -> str | None:
    raise NotImplementedError


def _parse_system_error(output: str) -> str | None:
    raise NotImplementedError


def _parse_failure_type(output: str) -> str | None:
    raise NotImplementedError


def _parse_primary_path(output: str) -> str | None:
    raise NotImplementedError


def _parse_path_mentions(output: str) -> list[str]:
    raise NotImplementedError


def _trim_path(value: str) -> str:
    raise NotImplementedError


def _remove_nullish(value: dict[str, object]) -> dict[str, object]:
    raise NotImplementedError
