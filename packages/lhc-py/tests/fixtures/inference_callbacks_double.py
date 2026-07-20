"""Ported from packages/lhc/test/fixtures/inference-callbacks-double.ts. Phase 1 skeleton.

Deterministic InferenceCallbacks double (DD-7, test plan §Test Substrate).
Types/constants and operation-resolution aliases are real; method bodies are
skeletons in Phase 1.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

from lhc.shared_tech.derivation import (
    CompressDetailedTurnInput,
    InferenceCallbacks,
    InferenceResult,
    SmoothPromptInput,
    SummarizeChunkBriefInput,
    SummarizeToolResultInput,
)

InferenceCallbackOpName = Literal[
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
]

# Tests script by work-kind / form-kind vocabulary (the test plan writes
# `failKind(prompt_smoothing, …)`); the double accepts those aliases as well
# as the operation names themselves.
KIND_ALIASES: dict[str, InferenceCallbackOpName] = {
    "smoothPrompt": "smoothPrompt",
    "summarizeToolResult": "summarizeToolResult",
    "compressDetailedTurn": "compressDetailedTurn",
    "summarizeChunkBrief": "summarizeChunkBrief",
    "prompt_smoothing": "smoothPrompt",
    "smoothed_prompt": "smoothPrompt",
    "tool_result_summary": "summarizeToolResult",
    "detailed_turn_compression": "compressDetailedTurn",
    "chunk_summary_brief": "summarizeChunkBrief",
}


class FailScript(TypedDict):
    remaining: int
    reason: str


@dataclass(frozen=True, slots=True)
class CapturedInput:
    op: InferenceCallbackOpName
    input: object


class FailNextFailure(TypedDict, total=False):
    reason: str


def _resolve_op_name(kind: str) -> InferenceCallbackOpName:
    raise NotImplementedError


class InferenceCallbacksDouble:
    """Implements InferenceCallbacks; bodies raise NotImplementedError in Phase 1."""

    # Fail the next n calls to any operation, then succeed.
    def fail_next(self, n: int, failure: FailNextFailure | None = None) -> None:
        raise NotImplementedError

    # Fail the next n calls to one operation (kind names and op names both
    # accepted).
    def fail_kind(self, kind: str, n: int, failure: FailNextFailure | None = None) -> None:
        raise NotImplementedError

    def delay_kind(self, kind: str, ms: int) -> None:
        raise NotImplementedError

    # Start capturing inputs; returns the live log (appended in call order).
    def capture_inputs(self) -> list[CapturedInput]:
        raise NotImplementedError

    async def _run(
        self,
        op: InferenceCallbackOpName,
        input: object,
        text: str,
        suffix: str = "",
    ) -> InferenceResult:
        raise NotImplementedError

    async def smooth_prompt(self, i: SmoothPromptInput) -> InferenceResult:
        raise NotImplementedError

    async def summarize_tool_result(self, i: SummarizeToolResultInput) -> InferenceResult:
        raise NotImplementedError

    async def compress_detailed_turn(self, i: CompressDetailedTurnInput) -> InferenceResult:
        raise NotImplementedError

    async def summarize_chunk_brief(self, i: SummarizeChunkBriefInput) -> InferenceResult:
        raise NotImplementedError


def create_inference_callbacks_double() -> InferenceCallbacksDouble:
    raise NotImplementedError


# Structural satisfaction of InferenceCallbacks Protocol (documentation only).
_: type[InferenceCallbacks] | None = None
