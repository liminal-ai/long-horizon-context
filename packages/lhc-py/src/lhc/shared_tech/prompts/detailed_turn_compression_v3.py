"""Ported from packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts. Phase 1 skeleton.

Stated vs acceptance: assignment targetMinRatio/targetMaxRatio/targetAimRatio
(0.35–0.65, aim 0.5) are the ACCEPTANCE window that sizeDisposition measures
against. This template states a deliberately lower target (20–30%) because
GPT models land 1.5–2x above whatever is stated — measured in the prompt lab,
5/5 in-window with this bias. Stated ≠ enforced, by design.
"""

from __future__ import annotations

from typing import TypedDict

from ..inference_types import ModelCallMessage

INSTRUCTIONS_OPEN = "<instructions-for-summarizing>"
INSTRUCTIONS_INTRO = "You condense dialogues from AI coding sessions so they can stand in for the original in a long-running conversation history. The condensed version is what the assistant will \"remember\" about this exchange later, so it must carry everything a future reader needs and nothing they don't."
JOB_TEMPLATE = "Your job is to summarize the following dialogue between a user and an llm assistant to 20% to 30% of its original size and turn the back and forth dialog into a narrative generally 3rd person voicing of the events unfolding across the back and forth. keep it in narrative past tense voicing targetting approximately 20%-30% of original size. That comes out to around ${statedAim} tokens total (roughly ${statedLo}-${statedHi}). Retain maximal meaning despite compression. > represents the user and ⏺ represents the agent."
INSTRUCTIONS_PROSE = "Write it as prose occasionally using bullets or headings as appropriate to what's being discussed or when techincal information needs to be retained. use best judgement on code blocks or fenced content as to whether to try and retain verbatim or simply create a fense and describe in parenthesis what was in the code block without reproducing based on best judgement as to how important that content or code block is"
INSTRUCTIONS_CLOSE = "</instructions-for-summarizing>"
CONTENT_OPEN = "<content-for-summarizing>"
CONTENT_CLOSE = "</content-for-summarizing>"


class DetailedTurnCompressionV3Input(TypedDict):
    dialogueText: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class _DetailedTurnCompressionV3:
    name = "detailed-turn-compression-v3"

    def render(self, dialogue: DetailedTurnCompressionV3Input) -> list[ModelCallMessage]:
        raise NotImplementedError


detailed_turn_compression_v3 = _DetailedTurnCompressionV3()


# Round the stated number at a granularity matched to its own magnitude
# (nearest-100 when the target is 1000+, nearest-10 below) — small turns
# otherwise round to degenerate text ("around 0 tokens total (roughly 0-0)")
# near the 80-token tiny-turn floor. Reproduces the lab-validated numbers
# (5618 input → 1400/1100/1700). Same rule as chunk-brief-v3.
def _stated_target(input_tokens: int, ratio: float) -> int:
    raise NotImplementedError
