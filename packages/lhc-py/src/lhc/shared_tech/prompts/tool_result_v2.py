"""Ported from packages/lhc/src/shared-tech/prompts/tool-result-v2.ts.

MODE_GUIDANCE and static prompt fragments are real and byte-identical; functions are skeletons.
"""

from __future__ import annotations

import json
import re
from typing import TypedDict

from .._jsstr import js_len, js_slice
from ..derivation import ToolOutcome, ToolResultFacts, ToolResultPromptMode, ToolResultResponseShape
from ..inference_types import ModelCallMessage

MODE_GUIDANCE: dict[ToolResultPromptMode, str] = {
    "receipt": "Write a concise tool-result receipt. Preserve status, concrete paths, counts, identifiers, and retry guidance. For write/edit receipts, do not infer changed content. If mutationDetailsAvailable is false, say the content/edit details were not available in the response when that matters. Do not quote the raw response.",
    "failure": "Write a concise failure receipt. Preserve what failed, why, the target path or command, exit code, and actionable retry guidance. Do not generalize away the concrete error.",
    "search_summary": "Summarize the search/listing result. Preserve query/command if present, match or no-match status, relevant paths, counts, and key locations. Do not list every match unless the output is already small.",
    "test_summary": "Write a compact verification receipt. Preserve command, final status, exit code, pass/fail counts, failed test names, and the core assertion/error reason. Prefer parsed testSummary over raw log detail. Do not list stack frames or every path. Keep it short unless multiple distinct failures need naming.",
    "content_summary": "Summarize what the file/output contains that matters for future work. Preserve file path, major sections/exports/config, and important values. Do not restate full contents.",
    "diff_summary": "Summarize changed files and nature of changes. Preserve insertion/deletion scale if available. Do not reproduce full diff.",
    "large_log": "Extract the final status, key errors, paths, counts, and next actionable facts. Drop repeated boilerplate and long logs.",
    "no_output": "Write a concise receipt for a successful command that produced no output. Preserve the command and explain that no output means a clean/no-change result only if the parsed outcome says succeeded.",
    "multi_tool_summary": "Summarize each subtool result separately. Preserve which subcalls succeeded or failed, missing paths/errors, and no-output clean statuses. Do not collapse mixed success/failure into one vague result.",
    "generic_summary": "Summarize the tool result for future coding context. Preserve concrete facts and avoid inventing missing details.",
}

TOOL_RESULT_V2_INTRO = "Summarize this tool response for long-horizon coding context."
TOOL_RESULT_V2_FACTS_RULE = "Use the parsed fields as authoritative facts. Do not infer success or failure from prose. Do not mention details that are not in the parsed fields or raw response."
TOOL_RESULT_V2_FIELD_RULE = "Use parsed field values, but do not mention parsed field labels such as failureType, failedField, retryGuidance, matchCount, targetPath, responseShape, operationClass, mutationDetailsAvailable, searchNoMatches, noOutput, subtoolResults, or testSummary. Preserve paths, commands, identifiers, counts, and exit codes verbatim. Do not quote or label the raw response. Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what the parsed fields or raw response directly support."
TOOL_RESULT_V2_TARGET_LENGTH_PREFIX = "Target length: about "
TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX = " tokens."
TOOL_RESULT_V2_PROMPT_MODE_PREFIX = "Prompt mode: "
TOOL_RESULT_V2_MODE_GUIDANCE_HEADER = "Mode guidance:"
TOOL_RESULT_V2_PARSED_FIELDS_HEADER = "Parsed fields:"

TOOL_RESULT_V2_USER_TOOL_PREFIX = "Tool: "
TOOL_RESULT_V2_USER_OUTCOME_PREFIX = "\nOutcome: "
TOOL_RESULT_V2_USER_EXCERPT_OPEN = "\n\nRaw tool response excerpt:\n```text\n"
TOOL_RESULT_V2_USER_EXCERPT_CLOSE = "\n```\n\nReturn only the summary."

TOOL_RESULT_V2_SEARCH_OMIT_PREFIX = "\n\n[omitted "
TOOL_RESULT_V2_SEARCH_OMIT_SUFFIX = " additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]"
TOOL_RESULT_V2_MIDDLE_OMIT_PREFIX = "\n\n[omitted "
TOOL_RESULT_V2_MIDDLE_OMIT_SUFFIX = " middle characters]\n\n"


class ToolResultV2Input(TypedDict):
    toolName: str
    content: str
    outcome: ToolOutcome
    targetTokens: int
    promptMode: ToolResultPromptMode
    responseShape: ToolResultResponseShape
    facts: ToolResultFacts


class _ToolResultV2:
    name = "tool-result-v2"

    def render(self, i: ToolResultV2Input) -> list[ModelCallMessage]:
        facts = _facts_for_prompt(i["facts"])
        guidance = MODE_GUIDANCE.get(i["promptMode"], MODE_GUIDANCE["generic_summary"])
        system_content = "\n".join(
            [
                TOOL_RESULT_V2_INTRO,
                "",
                TOOL_RESULT_V2_FACTS_RULE,
                "",
                TOOL_RESULT_V2_FIELD_RULE,
                "",
                f"{TOOL_RESULT_V2_TARGET_LENGTH_PREFIX}{i['targetTokens']}{TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX}",
                f"{TOOL_RESULT_V2_PROMPT_MODE_PREFIX}{i['promptMode']}",
                "",
                TOOL_RESULT_V2_MODE_GUIDANCE_HEADER,
                guidance,
                "",
                TOOL_RESULT_V2_PARSED_FIELDS_HEADER,
                # JS JSON.stringify(facts, null, 2) — no ASCII escaping.
                json.dumps(facts, indent=2, ensure_ascii=False),
            ]
        )
        user_content = (
            f"{TOOL_RESULT_V2_USER_TOOL_PREFIX}{i['toolName']}"
            f"{TOOL_RESULT_V2_USER_OUTCOME_PREFIX}{i['outcome']}"
            f"{TOOL_RESULT_V2_USER_EXCERPT_OPEN}"
            f"{_raw_output_for_prompt(i['content'], i['responseShape'])}"
            f"{TOOL_RESULT_V2_USER_EXCERPT_CLOSE}"
        )
        return [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]


tool_result_v2 = _ToolResultV2()


def _facts_for_prompt(facts: ToolResultFacts) -> dict[str, object]:
    excluded = {"operationClass", "responseShape", "outputChars", "outputWords"}
    return {key: value for key, value in facts.items() if key not in excluded}


def _raw_output_for_prompt(raw_output: str, response_shape: ToolResultResponseShape) -> str:
    lines = re.split(r"\r?\n", raw_output)
    if response_shape == "search_result" and len(lines) > 60:
        return (
            "\n".join(lines[:60])
            + TOOL_RESULT_V2_SEARCH_OMIT_PREFIX
            + str(len(lines) - 60)
            + TOOL_RESULT_V2_SEARCH_OMIT_SUFFIX
        )
    # TS: rawOutput.length / slice — UTF-16 code units.
    if js_len(raw_output) > 20_000:
        head = js_slice(raw_output, 0, 12_000)
        tail = js_slice(raw_output, js_len(raw_output) - 4_000)
        return (
            head
            + TOOL_RESULT_V2_MIDDLE_OMIT_PREFIX
            + str(js_len(raw_output) - js_len(head) - js_len(tail))
            + TOOL_RESULT_V2_MIDDLE_OMIT_SUFFIX
            + tail
        )
    return raw_output
