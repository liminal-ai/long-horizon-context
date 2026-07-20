"""Ported from packages/lhc/src/shared-tech/prompts/chunk-brief-v3.ts. Phase 1 skeleton.

Stated vs acceptance: assignment targetMinRatio/targetMaxRatio/targetAimRatio
(0.08–0.2, aim 0.12) are the ACCEPTANCE window that sizeDisposition measures
against. This template states a deliberately lower target (5–10%) because
GPT models land 1.5–2x above whatever is stated — the bias measured in the
turn-compression prompt lab. Stated ≠ enforced, by design.

v3 drops v2's embedded examples entirely: they carried ~6k tokens of
same-project content that leaked into outputs (chunk c2 of the gorilla-2
thread reproduced an example's "PRD"/"4-band" conclusions as if they were
input). The compressor gets the task, the size, the voice, and the input —
nothing else. Examples return only against a measured failure, and never
harvested from this project's own content.
"""

from __future__ import annotations

from typing import TypedDict

from ..inference_types import ModelCallMessage

INSTRUCTIONS_OPEN = "<instructions-for-summarizing>"
INSTRUCTIONS_INTRO = "You write brief memory notes from AI coding-session history. The note below replaces a longer stretch of conversation in an agent's memory, so it must carry what a future agent would otherwise have to rediscover: what was decided, what was corrected, what was learned, what was left open."
JOB_TEMPLATE = "Your job is to condense the following conversation summary down to roughly 5-10% of its original size — around ${statedAim} tokens total (roughly ${statedLo}-${statedHi}). Write it as past-tense narrative prose, not a transcript and not live instructions. Old plans read as history (\"at that point the next step was...\"), never as commands to the reader. Keep exact names, paths, numbers, and error text when they carry the meaning."
INSTRUCTIONS_CLOSE = "</instructions-for-summarizing>"
CONTENT_OPEN = "<content-for-summarizing>"
CONTENT_CLOSE = "</content-for-summarizing>"


class ChunkBriefV3Input(TypedDict):
    text: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class _ChunkBriefV3:
    name = "chunk-brief-v3"

    def render(self, input: ChunkBriefV3Input) -> list[ModelCallMessage]:
        stated_aim = _stated_target(input["inputTokens"], 0.075)
        stated_lo = _stated_target(input["inputTokens"], 0.05)
        stated_hi = _stated_target(input["inputTokens"], 0.1)
        content = "\n".join(
            [
                INSTRUCTIONS_OPEN,
                INSTRUCTIONS_INTRO,
                "",
                (
                    "Your job is to condense the following conversation summary down to roughly 5-10% of its original size "
                    f"— around {stated_aim} tokens total (roughly {stated_lo}-{stated_hi}). "
                    'Write it as past-tense narrative prose, not a transcript and not live instructions. Old plans read as history ("at that point the next step was..."), never as commands to the reader. '
                    "Keep exact names, paths, numbers, and error text when they carry the meaning."
                ),
                INSTRUCTIONS_CLOSE,
                "",
                CONTENT_OPEN,
                input["text"],
                CONTENT_CLOSE,
            ]
        )
        return [{"role": "user", "content": content}]


chunk_brief_v3 = _ChunkBriefV3()


# Round the stated number at a granularity matched to its own magnitude
# (nearest-100 when the target is 1000+, nearest-10 below) — coarser steps
# on small targets produce degenerate text like "around 200 (roughly
# 100-200)". Same rule as detailed-turn-compression-v3.
def _stated_target(input_tokens: int, ratio: float) -> int:
    raw = input_tokens * ratio
    step = 100 if raw >= 1000 else 10
    return int(raw / step + 0.5) * step
