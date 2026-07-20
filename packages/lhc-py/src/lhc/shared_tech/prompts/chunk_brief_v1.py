"""Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v1.ts. Phase 1 skeleton.

Pre-dial-in template kept under its versioned name for provenance.
"""

from __future__ import annotations

from typing import NotRequired, TypedDict

from ..derivation import ToolOutcome
from ..inference_types import ModelCallMessage

SYSTEM_PROMPT = "You write a brief summary of a sequence of conversation turns. State what was worked on and what was accomplished, and reflect the tool outcomes given. No detail beyond outcomes, no speculation, three sentences maximum."
USER_TURNS_PREFIX = "Turns, in order:\n\n"
OUTCOMES_SECTION_TEMPLATE = "\n\nTool outcomes, in order: ${outcomes.join(\", \")}"


class ChunkBriefV1Input(TypedDict):
    memberProjections: list[str]
    memberOutcomes: NotRequired[list[list[ToolOutcome]]]


class _ChunkBriefV1:
    name = "chunk-brief-v1"

    def render(self, i: ChunkBriefV1Input) -> list[ModelCallMessage]:
        turns = "\n\n".join(
            f"{idx}. {member_text}"
            for idx, member_text in enumerate(i["memberProjections"], start=1)
        )
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": USER_TURNS_PREFIX
                + turns
                + _outcomes_section(i.get("memberOutcomes")),
            },
        ]


chunk_brief_v1 = _ChunkBriefV1()


# Build the trailing outcomes section for the user message.
def _outcomes_section(member_outcomes: list[list[ToolOutcome]] | None = None) -> str:
    outcomes = [
        outcome for member_outcome in (member_outcomes or []) for outcome in member_outcome
    ]
    if not outcomes:
        return ""
    return "\n\nTool outcomes, in order: " + ", ".join(outcomes)
