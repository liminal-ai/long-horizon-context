"""Ported from packages/lhc/src/messages/internal/classify-tool-result.ts.

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
    operation_class = _classify_operation(input.tool_name, input.tool_input, input.raw_output)
    response_shape = _classify_shape(input.tool_name, input.outcome, input.raw_output, operation_class)
    prompt_mode = _prompt_mode_for(response_shape, input.outcome)
    facts = _parse_facts(input, operation_class, response_shape)
    return ToolResultClassification(
        operation_class=operation_class,
        response_shape=response_shape,
        prompt_mode=prompt_mode,
        facts=facts,
    )


def _command_of(tool_input: dict[str, object] | None) -> str:
    if tool_input is None:
        return ""
    command = tool_input.get("command")
    return command if isinstance(command, str) else ""


def _classify_operation(
    tool_name: str,
    tool_input: dict[str, object] | None,
    raw_output: str,
) -> ToolResultOperationClass:
    import re

    if tool_name == "read":
        return "read"
    if tool_name == "write":
        return "mutation_write"
    if tool_name == "edit":
        return "mutation_edit"
    if tool_name == "multi_tool_use.parallel":
        return "multi_tool"
    if tool_name == "bash":
        command = _command_of(tool_input)
        if re.search(r"\b(rg|grep|find)\b", command):
            return "search_or_listing"
        if re.search(
            r"\b(vitest|tsx --test|node --test|npm test|pnpm test|pnpm run verify|tsc|typecheck|lint)\b",
            command,
        ):
            return "verification"
        if re.search(r"\b(git diff|git status|git show|git log)\b", command):
            return "vcs_inspection"
        if re.search(r"\b(rm|mv|cp|mkdir|chmod|touch)\b", command):
            return "filesystem_mutation"
        if re.search(
            r"\b(diff --git|Test Files|Tests\s+\d|Command exited with code)\b|[\u2714\u2716]",
            raw_output,
        ):
            return "command"
        return "command"
    return "unknown"


def _classify_shape(
    tool_name: str,
    outcome: ToolOutcome,
    raw_output: str,
    operation_class: ToolResultOperationClass,
) -> ToolResultResponseShape:
    import re

    output = raw_output.strip()
    output_length = len(output.encode("utf-16-le")) // 2
    if operation_class == "multi_tool":
        return "multi_tool_result"
    if output == "(no output)" or output == "":
        return "no_output"
    if operation_class == "search_or_listing" and _is_search_no_match_output(output):
        return "search_result"
    if _is_structured_receipt_output(output):
        return "structured_receipt"
    if re.search(r"^Found\s+\d+\s+occurrences\s+of\s+.+?\s+in\s+.+?\.", output, re.IGNORECASE):
        return "structured_receipt"
    if re.search(
        r"\bENOENT\b|No such file or directory|command not found|invalid option|Cannot find package",
        output,
        re.IGNORECASE,
    ):
        return "simple_failure"
    if operation_class == "verification" and (
        re.search(
            r"\b(Test Files|Tests|failed|passed|vitest|tsc --noEmit|typecheck|lint|CACError|AssertionError|TAP version|# tests)\b",
            output,
            re.IGNORECASE,
        )
        or re.search(r"[\u2714\u2716]", output)
    ):
        return "test_result"
    if _looks_like_test_runner_output(output):
        return "test_result"
    if re.search(r"Command exited with code\s+(?!0\b)\d+", output, re.IGNORECASE) and output_length < 1200:
        return "simple_failure"
    if (
        re.search(r"^diff --git\b", output, re.MULTILINE)
        or re.search(r"\|\s+\d+\s+[+-]+", output, re.MULTILINE)
        or re.search(r"files? changed,\s+\d+ insertions?", output, re.IGNORECASE)
    ):
        return "diff_output"
    if operation_class == "search_or_listing" and (
        re.search(r"^\d+:", output, re.MULTILINE)
        or re.search(r"^[^\n:]+:\d+:", output, re.MULTILINE)
        or output_length > 0
    ):
        return "search_result"
    if re.search(r"^[^\n:]+:\d+:", output, re.MULTILINE) or re.search(
        r"^\S+\s+\d+\s*$", output, re.MULTILINE
    ):
        return "search_result"
    if tool_name == "read" and outcome != "failed":
        return "large_file_content" if output_length > 5000 else "file_content"
    if output_length > 5000:
        return "large_log"
    return "unknown_content"


def _prompt_mode_for(response_shape: ToolResultResponseShape, outcome: ToolOutcome) -> ToolResultPromptMode:
    if response_shape == "structured_receipt":
        return "receipt"
    if response_shape == "no_output":
        return "no_output"
    if response_shape == "multi_tool_result":
        return "multi_tool_summary"
    if response_shape == "simple_failure":
        return "failure"
    if response_shape == "search_result":
        return "search_summary"
    if response_shape == "test_result":
        return "test_summary"
    if response_shape == "diff_output":
        return "diff_summary"
    if response_shape == "file_content" or response_shape == "large_file_content":
        return "content_summary"
    if response_shape == "large_log":
        return "large_log"
    if outcome == "failed":
        return "failure"
    return "generic_summary"


def _parse_facts(
    input: ToolResultClassificationInput,
    operation_class: ToolResultOperationClass,
    response_shape: ToolResultResponseShape,
) -> dict[str, object]:
    import re

    raw_output = input.raw_output
    search_result = operation_class == "search_or_listing" and response_shape == "search_result"
    return _remove_nullish(
        {
            "toolName": input.tool_name,
            "outcome": input.outcome,
            "operationClass": operation_class,
            "responseShape": response_shape,
            "failureType": _parse_failure_type(raw_output),
            "command": _command_of(input.tool_input) or None,
            "exitCode": _parse_exit_code(raw_output),
            "targetPath": _parse_primary_path(raw_output),
            "byteCount": _parse_byte_count(raw_output),
            "blockCount": _parse_block_count(raw_output),
            "mutationDetailsAvailable": _parse_mutation_details_available(input.tool_name, raw_output),
            "failedField": _parse_failed_field(raw_output),
            "matchCount": _parse_match_count(raw_output),
            "requiredCondition": _parse_required_condition(raw_output),
            "retryGuidance": _parse_retry_guidance(raw_output),
            "missingCommand": _parse_missing_command(raw_output),
            "systemError": _parse_system_error(raw_output),
            "noOutput": raw_output.strip() == "(no output)" or raw_output.strip() == "",
            "searchNoMatches": _is_search_no_match_output(raw_output.strip()) if search_result else None,
            "searchMatchCount": _parse_search_match_count(operation_class, raw_output) if search_result else None,
            "searchMatches": _parse_search_matches(operation_class, raw_output)[:12] if search_result else [],
            "testSummary": _parse_test_summary(operation_class, raw_output),
            "subtoolResults": _parse_subtool_results(operation_class, raw_output),
            "pathMentions": _parse_path_mentions(raw_output)[:12],
            "outputChars": len(raw_output.encode("utf-16-le")) // 2,
            "outputWords": len([part for part in re.split(r"\s+", raw_output) if part]),
        }
    )


def _looks_like_test_runner_output(output: str) -> bool:
    import re

    return bool(
        re.search(r"\bTAP version\b", output, re.IGNORECASE)
        and re.search(r"#\s*tests\s+\d+", output, re.IGNORECASE)
    )


def _is_structured_receipt_output(output: str) -> bool:
    import re

    lines = [line.strip() for line in re.split(r"\r?\n", output) if line.strip()]
    if len(lines) == 0:
        return False
    return all(
        re.search(r"^Successfully wrote\s+\d+\s+bytes to\s+.+\.?$", line, re.IGNORECASE)
        or re.search(r"^Successfully replaced\s+\d+\s+block\(s\) in\s+.+\.?$", line, re.IGNORECASE)
        or re.search(r"^Found\s+\d+\s+occurrences\s+of\s+.+?\s+in\s+.+?\.", line, re.IGNORECASE)
        for line in lines
    )


def _is_search_no_match_output(output: str) -> bool:
    import re

    content_lines = [
        line.strip()
        for line in re.split(r"\r?\n", output)
        if line.strip() and not re.search(r"^Command exited with code\s+1$", line.strip(), re.IGNORECASE)
    ]
    return len(content_lines) == 0 and bool(
        re.search(r"Command exited with code\s+1", output, re.IGNORECASE)
    )


def _search_content_lines(output: str) -> list[str]:
    import re

    return [
        line.strip()
        for line in re.split(r"\r?\n", output)
        if line.strip()
        and not re.search(r"^Command exited with code\s+\d+$", line.strip(), re.IGNORECASE)
    ]


def _parse_search_match_count(operation_class: ToolResultOperationClass, output: str) -> int | None:
    if operation_class != "search_or_listing":
        return None
    if _is_search_no_match_output(output.strip()):
        return 0
    lines = _search_content_lines(output)
    return len(lines) or None


def _parse_search_matches(operation_class: ToolResultOperationClass, output: str) -> list[dict[str, object]]:
    import re

    if operation_class != "search_or_listing":
        return []
    results: list[dict[str, object]] = []
    for line in _search_content_lines(output):
        match = re.search(r"^([^:]+):(\d+):(.*)$", line)
        if match is not None:
            results.append({"path": match.group(1), "line": int(match.group(2)), "text": match.group(3).strip()})
            continue
        match = re.search(r"^(\d+):(.*)$", line)
        if match is not None:
            results.append({"line": int(match.group(1)), "text": match.group(2).strip()})
            continue
        results.append({"text": line})
    return results


def _parse_test_summary(operation_class: ToolResultOperationClass, output: str) -> dict[str, object] | None:
    import re

    if operation_class != "verification":
        return None
    lines = [line.strip() for line in re.split(r"\r?\n", output) if line.strip()]
    summary: dict[str, object] = {}
    tests_line = next(
        (
            line
            for line in lines
            if re.search(r"\btests?\b", line, re.IGNORECASE)
            and re.search(r"\bpass(?:ed)?\b", line, re.IGNORECASE)
        ),
        None,
    )
    total_match = re.search(r"(?:#\s*)?(\d+)\s+tests?\b", output, re.IGNORECASE)
    if total_match is None:
        total_match = re.search(r"#\s*tests\s+(\d+)", output, re.IGNORECASE)
    passed_match = re.search(r"(?:#\s*)?(\d+)\s+pass(?:ed)?\b", output, re.IGNORECASE)
    if passed_match is None:
        passed_match = re.search(r"#\s*pass\s+(\d+)", output, re.IGNORECASE)
    failed_match = re.search(r"(?:#\s*)?(\d+)\s+fail(?:ed)?\b", output, re.IGNORECASE)
    if failed_match is None:
        failed_match = re.search(r"#\s*fail\s+(\d+)", output, re.IGNORECASE)
    if total_match is not None:
        summary["total"] = int(total_match.group(1))
    if passed_match is not None:
        summary["passed"] = int(passed_match.group(1))
    if failed_match is not None:
        summary["failed"] = int(failed_match.group(1))
    if tests_line is not None:
        summary["countLine"] = tests_line

    failed_tests: list[str] = []
    for line in lines:
        match = re.search(r"[\u2716xX]\s+(.+?)(?:\s+\(|$)", line)
        if match is not None:
            name = match.group(1).strip()
            if not re.search(r"^failing tests:?$", name, re.IGNORECASE):
                failed_tests.append(name)
    unique_failed_tests = list(dict.fromkeys(failed_tests))
    if len(unique_failed_tests) > 0:
        summary["failedTests"] = unique_failed_tests[:8]
    if "failed" not in summary and len(unique_failed_tests) > 0:
        summary["failed"] = len(unique_failed_tests)
    if "passed" not in summary:
        pass_markers = len([line for line in lines if re.search(r"^[\u2714vV]\s+", line)])
        if pass_markers > 0:
            summary["passed"] = pass_markers
    if "total" not in summary and "passed" in summary and "failed" in summary:
        summary["total"] = int(summary["passed"]) + int(summary["failed"])

    assertion_lines = [
        line
        for line in lines
        if re.search(r"AssertionError|Expected values|strictly deep-equal|actual|expected", line, re.IGNORECASE)
    ]
    if len(assertion_lines) > 0:
        summary["assertionLines"] = assertion_lines[:8]

    command_failure = re.search(r"Command exited with code\s+(\d+)", output, re.IGNORECASE)
    if command_failure is not None:
        summary["exitCode"] = int(command_failure.group(1))
    return summary if len(summary) > 0 else None


def _parse_subtool_results(
    operation_class: ToolResultOperationClass,
    output: str,
) -> list[dict[str, object]] | None:
    import re

    if operation_class != "multi_tool":
        return None
    results: list[dict[str, object]] = []
    for line in [line.strip() for line in re.split(r"\r?\n", output) if line.strip()]:
        match = re.search(r"^([^:]+):\s*(succeeded|failed)(?:,\s*(.*))?$", line, re.IGNORECASE)
        if match is None:
            results.append({"text": line})
            continue
        results.append(
            _remove_nullish(
                {
                    "label": match.group(1),
                    "outcome": match.group(2).lower(),
                    "detail": match.group(3) if match.group(3) is not None else None,
                }
            )
        )
    return results


def _parse_exit_code(output: str) -> int | None:
    import re

    match = re.search(r"Command exited with code\s+(\d+)", output, re.IGNORECASE)
    return int(match.group(1)) if match is not None else None


def _parse_byte_count(output: str) -> int | None:
    import re

    match = re.search(r"Successfully wrote\s+(\d+)\s+bytes", output, re.IGNORECASE)
    return int(match.group(1)) if match is not None else None


def _parse_block_count(output: str) -> int | None:
    import re

    match = re.search(r"Successfully replaced\s+(\d+)\s+block\(s\)", output, re.IGNORECASE)
    return int(match.group(1)) if match is not None else None


def _parse_match_count(output: str) -> int | None:
    import re

    match = re.search(r"Found\s+(\d+)\s+occurrences", output, re.IGNORECASE)
    return int(match.group(1)) if match is not None else None


def _parse_mutation_details_available(tool_name: str, output: str) -> bool | None:
    import re

    if tool_name != "write" and tool_name != "edit":
        return None
    if re.search(r"^Successfully wrote\s+\d+\s+bytes to\s+.+\.?$", output.strip(), re.IGNORECASE):
        return False
    if re.search(
        r"^Successfully replaced\s+\d+\s+block\(s\) in\s+.+\.?$",
        output.strip(),
        re.IGNORECASE,
    ):
        return False
    return None


def _parse_failed_field(output: str) -> str | None:
    import re

    occurrence_match = re.search(
        r"Found\s+\d+\s+occurrences\s+of\s+([^\s]+)\s+in\s+([^.]*(?:\.[A-Za-z0-9_-]+)+)",
        output,
        re.IGNORECASE,
    )
    unique_field_match = re.search(r"Each\s+([^\s]+)\s+must be unique", output, re.IGNORECASE)
    if occurrence_match is None:
        return None
    if unique_field_match is not None:
        return f"{occurrence_match.group(1)}.{unique_field_match.group(1)}"
    return occurrence_match.group(1)


def _parse_required_condition(output: str) -> str | None:
    import re

    unique_field_match = re.search(r"Each\s+([^\s]+)\s+must be unique", output, re.IGNORECASE)
    if unique_field_match is not None:
        return f"{unique_field_match.group(1)} must match exactly one location"
    return None


def _parse_retry_guidance(output: str) -> str | None:
    import re

    if re.search(r"provide more context", output, re.IGNORECASE):
        return "retry with more surrounding context so the replacement target is unique"
    if re.search(r"command not found", output, re.IGNORECASE):
        return "install the command or invoke it through the project package runner"
    if re.search(r"No such file or directory|ENOENT", output, re.IGNORECASE):
        return "check the path or run from the expected working directory"
    return None


def _parse_missing_command(output: str) -> str | None:
    import re

    shell_match = re.search(r"(?:sh|bash|zsh):\s*([^:\s]+):\s*command not found", output, re.IGNORECASE)
    return shell_match.group(1) if shell_match is not None else None


def _parse_system_error(output: str) -> str | None:
    import re

    match = re.search(r"\b(ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR)\b", output)
    return match.group(1) if match is not None else None


def _parse_failure_type(output: str) -> str | None:
    import re

    if re.search(r"Found\s+\d+\s+occurrences", output, re.IGNORECASE):
        return "non_unique_old_text"
    if re.search(r"command not found", output, re.IGNORECASE):
        return "command_not_found"
    if re.search(r"No such file or directory|ENOENT", output, re.IGNORECASE):
        return "missing_path"
    if re.search(r"invalid option", output, re.IGNORECASE):
        return "invalid_option"
    if re.search(r"Cannot find package", output, re.IGNORECASE):
        return "missing_package"
    if re.search(r"Command exited with code\s+(?!0\b)\d+", output, re.IGNORECASE):
        return "nonzero_exit"
    return None


def _parse_primary_path(output: str) -> str | None:
    import re

    write_match = re.search(r"Successfully wrote\s+\d+\s+bytes to\s+(.+?)\.?$", output, re.IGNORECASE)
    if write_match is not None:
        return _trim_path(write_match.group(1))
    edit_match = re.search(
        r"Successfully replaced\s+\d+\s+block\(s\) in\s+(.+?)\.?$",
        output,
        re.IGNORECASE,
    )
    if edit_match is not None:
        return _trim_path(edit_match.group(1))
    occurrence_match = re.search(
        r"Found\s+\d+\s+occurrences\s+of\s+[^\s]+\s+in\s+(.+?)\.",
        output,
        re.IGNORECASE,
    )
    if occurrence_match is not None:
        return _trim_path(occurrence_match.group(1))
    access_match = re.search(r"""access ['"]([^'"]+)['"]""", output, re.IGNORECASE)
    if access_match is not None:
        return access_match.group(1)
    find_match = re.search(r"find:\s+([^:]+):\s+No such file or directory", output, re.IGNORECASE)
    if find_match is not None:
        return _trim_path(find_match.group(1))
    location_match = re.search(r"Location of .*?:\s*(.+)", output, re.IGNORECASE)
    if location_match is not None:
        return _trim_path(location_match.group(1))
    return None


def _parse_path_mentions(output: str) -> list[str]:
    import re

    matches = re.findall(r"(?:\.?\.?/|/Users/|[A-Za-z0-9_.-]+/)[A-Za-z0-9_./@-]+", output)
    return list(dict.fromkeys(_trim_path(match) for match in matches))


def _trim_path(value: str) -> str:
    import re

    return re.sub(r"[.,;:]+$", "", str(value).strip())


def _remove_nullish(value: dict[str, object]) -> dict[str, object]:
    return {
        key: item
        for key, item in value.items()
        if item is not None and not (isinstance(item, list) and len(item) == 0)
    }
