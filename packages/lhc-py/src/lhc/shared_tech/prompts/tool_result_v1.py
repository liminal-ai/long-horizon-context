"""Ported from packages/lhc/src/shared-tech/prompts/tool-result-v1.ts.

Pre-dial-in template kept under its versioned name. Input bounding is applied
by the adapter before this template renders.
"""

from __future__ import annotations

from typing import TypedDict

from ..derivation import ToolOutcome
from ..inference_types import ModelCallMessage

SYSTEM_TEMPLATE = "You summarize tool output for an engineering record. Preserve the outcome/status exactly as \"${i.outcome}\". Target about ${i.targetTokens} tokens. ${i.guidance} No commentary, no speculation."
USER_TEMPLATE = "Tool: ${i.toolName}\nOutcome: ${i.outcome}\n\nOutput:\n${i.content}"


class ToolResultV1Input(TypedDict):
    toolName: str
    content: str
    outcome: ToolOutcome
    targetTokens: int
    guidance: str


class _ToolResultV1:
    name = "tool-result-v1"

    def render(self, i: ToolResultV1Input) -> list[ModelCallMessage]:
        return [
            {
                "role": "system",
                "content": (
                    f'You summarize tool output for an engineering record. Preserve the outcome/status exactly as "{i["outcome"]}". '
                    f'Target about {i["targetTokens"]} tokens. {i["guidance"]} No commentary, no speculation.'
                ),
            },
            {
                "role": "user",
                "content": (
                    f'Tool: {i["toolName"]}\nOutcome: {i["outcome"]}\n\nOutput:\n{i["content"]}'
                ),
            },
        ]


tool_result_v1 = _ToolResultV1()
