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

from typing import Literal

from .derivation import InferenceCallbacks, ToolOutcome

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
    raise NotImplementedError


def deterministic_text(op: DeterministicOpName, input: object, text: str) -> str:
    raise NotImplementedError


def deterministic_outcomes_suffix(member_outcomes: list[list[ToolOutcome]] | None = None) -> str:
    raise NotImplementedError


def create_deterministic_inference_callbacks() -> InferenceCallbacks:
    raise NotImplementedError
