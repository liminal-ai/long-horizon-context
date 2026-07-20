"""Ported from packages/lhc/src/shared-tech/deterministic.ts. Phase 1 skeleton.

EXEMPLAR MODULE — canonical pattern for a mixed constants-and-functions file.
Constants are ported verbatim as real values; every function body is a
NotImplementedError skeleton, even the one-liners.

Deterministic inference callbacks: marked, input-derived output for every seam
operation — `<marker>(<digest>:<prefix>)` where digest and prefix are pure
functions of the input. The test double reuses these helpers so in-process
and spawned runs produce byte-identical artifacts. It is selectable only by
explicit construction — never a production default.
"""

from __future__ import annotations

import json
from typing import Literal

from ._jsstr import js_char_codes, js_slice
from .derivation import (
    CompressDetailedTurnInput,
    InferenceCallbacks,
    InferenceOk,
    InferenceResult,
    SmoothPromptInput,
    SummarizeChunkBriefInput,
    SummarizeToolResultInput,
    ToolOutcome,
)

DeterministicOpName = Literal[
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
]

DETERMINISTIC_MARKERS: dict[DeterministicOpName, str] = {
    "smoothPrompt": "smoothed",
    "summarizeToolResult": "toolresult",
    "compressDetailedTurn": "projection",
    "summarizeChunkBrief": "brief",
}


# FNV-1a 32-bit over the canonical input JSON: stable, dependency-free, and
# input-sensitive enough that distinct inputs mark distinct outputs.
# NOTE (Phase 2): "canonical input JSON" must byte-match JS JSON.stringify —
# separators, key order (insertion order), and string escaping all matter.
def deterministic_digest(input: object) -> str:
    # JS JSON.stringify does not escape non-ASCII; then charCodeAt walks UTF-16.
    text = json.dumps(input, separators=(",", ":"), ensure_ascii=False)
    hash_ = 0x811C9DC5
    for code in js_char_codes(text):
        hash_ ^= code
        hash_ = (hash_ * 0x01000193) & 0xFFFFFFFF
    return f"{hash_:08x}"


def deterministic_text(op: DeterministicOpName, input: object, text: str) -> str:
    # TS: text.slice(0, 40) — 40 UTF-16 code units, not 40 code points.
    return f"{DETERMINISTIC_MARKERS[op]}({deterministic_digest(input)}:{js_slice(text, 0, 40)})"


def deterministic_outcomes_suffix(member_outcomes: list[list[ToolOutcome]] | None = None) -> str:
    outcomes = [o for group in (member_outcomes or []) for o in group]
    if len(outcomes) == 0:
        return ""
    return f"[outcomes {','.join(outcomes)}]"


async def _ok(op: DeterministicOpName, input: object, text: str) -> InferenceResult:
    return InferenceOk(text=deterministic_text(op, input, text))


class _DeterministicInferenceCallbacks:
    async def smooth_prompt(self, i: SmoothPromptInput) -> InferenceResult:
        return await _ok("smoothPrompt", i, i["text"])

    async def summarize_tool_result(self, i: SummarizeToolResultInput) -> InferenceResult:
        return await _ok("summarizeToolResult", i, i["content"])

    async def compress_detailed_turn(self, i: CompressDetailedTurnInput) -> InferenceResult:
        return await _ok("compressDetailedTurn", i, i["dialogueText"])

    async def summarize_chunk_brief(self, i: SummarizeChunkBriefInput) -> InferenceResult:
        return await _ok("summarizeChunkBrief", i, i["text"])


def create_deterministic_inference_callbacks() -> InferenceCallbacks:
    return _DeterministicInferenceCallbacks()
