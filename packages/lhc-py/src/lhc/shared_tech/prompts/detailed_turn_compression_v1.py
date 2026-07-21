"""Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v1.ts."""

from __future__ import annotations

from typing import TypedDict

from ..inference_types import ModelCallMessage

SYSTEM_PART_00 = "Below is one exchange from a coding conversation."
SYSTEM_PART_01 = ""
SYSTEM_TMPL_02 = "It is about ${i.inputTokens} tokens long."
SYSTEM_PART_03 = ""
SYSTEM_TMPL_04 = "Shorten it to about ${i.targetAimTokens} tokens. The final output must fall within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."
SYSTEM_PART_05 = ""
SYSTEM_PART_06 = "Write the shortened version as compact prose."
SYSTEM_PART_07 = ""
SYSTEM_PART_08 = "Preserve:"
SYSTEM_PART_09 = "- the user's request, correction, decision, or preference"
SYSTEM_PART_10 = "- the agent's answer, action, mistake, or commitment"
SYSTEM_PART_11 = "- the useful conclusion from thinking, if it affected the work"
SYSTEM_PART_12 = "- the useful outcome from tool calls/results, if it affected the work"
SYSTEM_PART_13 = "- concrete files, paths, commands, model names, numbers, errors, test results, and commit hashes"
SYSTEM_PART_14 = "- unresolved questions or blocked work"
SYSTEM_PART_15 = ""
SYSTEM_PART_16 = "Remove:"
SYSTEM_PART_17 = "- raw thinking text"
SYSTEM_PART_18 = "- raw tool output"
SYSTEM_PART_19 = "- repeated acknowledgements"
SYSTEM_PART_20 = "- apologies and status chatter"
SYSTEM_PART_21 = "- local filler"
SYSTEM_PART_22 = "- details that did not affect what happened next"
SYSTEM_PART_23 = ""
SYSTEM_PART_24 = "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do."
SYSTEM_PART_25 = ""
SYSTEM_TMPL_26 = "Before returning, estimate whether the output is within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."
SYSTEM_PART_27 = "If it is too short, expand it by restoring missing substance."
SYSTEM_PART_28 = "If it is too long, contract it by removing lower-value detail and repeated explanation."
SYSTEM_PART_29 = ""
SYSTEM_TMPL_30 = "The final answer must be within ${i.targetMinTokens}-${i.targetMaxTokens} tokens."
SYSTEM_PART_31 = ""
SYSTEM_PART_32 = "Rewrite only the text inside <turn_rendering_to_compress>."
SYSTEM_PART_33 = "Return only the shortened exchange, without XML tags."
USER_WRAPPER_PREFIX = "<turn_rendering_to_compress>\n"
USER_WRAPPER_SUFFIX = "\n</turn_rendering_to_compress>"


class DetailedTurnCompressionV1Input(TypedDict):
    dialogueText: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class _DetailedTurnCompressionV1:
    name = "detailed-turn-compression-v1"

    def render(self, i: DetailedTurnCompressionV1Input) -> list[ModelCallMessage]:
        system_content = "\n".join(
            [
                SYSTEM_PART_00,
                SYSTEM_PART_01,
                f"It is about {i['inputTokens']} tokens long.",
                SYSTEM_PART_03,
                f"Shorten it to about {i['targetAimTokens']} tokens. The final output must fall within {i['targetMinTokens']}-{i['targetMaxTokens']} tokens.",
                SYSTEM_PART_05,
                SYSTEM_PART_06,
                SYSTEM_PART_07,
                SYSTEM_PART_08,
                SYSTEM_PART_09,
                SYSTEM_PART_10,
                SYSTEM_PART_11,
                SYSTEM_PART_12,
                SYSTEM_PART_13,
                SYSTEM_PART_14,
                SYSTEM_PART_15,
                SYSTEM_PART_16,
                SYSTEM_PART_17,
                SYSTEM_PART_18,
                SYSTEM_PART_19,
                SYSTEM_PART_20,
                SYSTEM_PART_21,
                SYSTEM_PART_22,
                SYSTEM_PART_23,
                SYSTEM_PART_24,
                SYSTEM_PART_25,
                f"Before returning, estimate whether the output is within {i['targetMinTokens']}-{i['targetMaxTokens']} tokens.",
                SYSTEM_PART_27,
                SYSTEM_PART_28,
                SYSTEM_PART_29,
                f"The final answer must be within {i['targetMinTokens']}-{i['targetMaxTokens']} tokens.",
                SYSTEM_PART_31,
                SYSTEM_PART_32,
                SYSTEM_PART_33,
            ]
        )
        return [
            {"role": "system", "content": system_content},
            {
                "role": "user",
                "content": USER_WRAPPER_PREFIX + i["dialogueText"] + USER_WRAPPER_SUFFIX,
            },
        ]


detailed_turn_compression_v1 = _DetailedTurnCompressionV1()
