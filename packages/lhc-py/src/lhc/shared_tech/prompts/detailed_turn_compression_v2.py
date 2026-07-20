"""Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v2.ts. Phase 1 skeleton."""

from __future__ import annotations

from typing import TypedDict

from ..inference_types import ModelCallMessage

SYSTEM_PART_00 = "Below is a user↔assistant dialogue from a coding conversation."
SYSTEM_PART_01 = ""
SYSTEM_TMPL_02 = "It is about ${dialogue.inputTokens} tokens long."
SYSTEM_PART_03 = ""
SYSTEM_TMPL_04 = "Compress it to about ${dialogue.targetAimTokens} tokens (roughly 30-50% of the input). The final output must fall within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."
SYSTEM_PART_05 = ""
SYSTEM_PART_06 = "Write the compressed version as compact prose in the same dialogue register."
SYSTEM_PART_07 = ""
SYSTEM_PART_08 = "Preserve:"
SYSTEM_PART_09 = "- user constraints, corrections, decisions, and preferences"
SYSTEM_PART_10 = "- exact identifiers: file paths, commands, model names, numbers, errors, test results, commit hashes"
SYSTEM_PART_11 = "- decisions made during the exchange"
SYSTEM_PART_12 = "- outcomes and conclusions the assistant stated"
SYSTEM_PART_13 = ""
SYSTEM_PART_14 = "Remove:"
SYSTEM_PART_15 = "- pleasantries and repeated acknowledgements"
SYSTEM_PART_16 = "- repetition and meta-commentary"
SYSTEM_PART_17 = "- filler that does not change what happened"
SYSTEM_PART_18 = ""
SYSTEM_TMPL_19 = "Before returning, estimate whether the output is within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."
SYSTEM_PART_20 = "If it is too short, expand it by restoring missing substance."
SYSTEM_PART_21 = "If it is too long, contract it by removing lower-value detail and repeated explanation."
SYSTEM_PART_22 = ""
SYSTEM_TMPL_23 = "The final answer must be within ${dialogue.targetMinTokens}-${dialogue.targetMaxTokens} tokens."
SYSTEM_PART_24 = ""
SYSTEM_PART_25 = "Rewrite only the text inside <dialogue_to_compress>."
SYSTEM_PART_26 = "Return only the compressed dialogue, without XML tags."
USER_WRAPPER_PREFIX = "<dialogue_to_compress>\n"
USER_WRAPPER_SUFFIX = "\n</dialogue_to_compress>"


class DetailedTurnCompressionV2Input(TypedDict):
    dialogueText: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class _DetailedTurnCompressionV2:
    name = "detailed-turn-compression-v2"

    def render(self, dialogue: DetailedTurnCompressionV2Input) -> list[ModelCallMessage]:
        raise NotImplementedError


detailed_turn_compression_v2 = _DetailedTurnCompressionV2()
