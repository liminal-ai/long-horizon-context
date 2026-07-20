"""Ported from packages/lhc/test/fixtures/inference-callbacks-double.ts. Phase 1 skeleton.

Deterministic InferenceCallbacks double (DD-7, test plan §Test Substrate).
Types/constants and operation-resolution aliases are real; method bodies are
skeletons in Phase 1.
"""

from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass
from typing import Literal, TypedDict

from lhc.shared_tech.derivation import (
    CompressDetailedTurnInput,
    InferenceCallbacks,
    InferenceErr,
    InferenceOk,
    InferenceResult,
    SmoothPromptInput,
    SummarizeChunkBriefInput,
    SummarizeToolResultInput,
)
from lhc.shared_tech.deterministic import deterministic_text

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
    op = KIND_ALIASES.get(kind)
    if op is None:
        raise RuntimeError(f'inference callbacks double: unknown operation/kind "{kind}"')
    return op


class InferenceCallbacksDouble:
    """Implements InferenceCallbacks; bodies raise NotImplementedError in Phase 1."""

    def __init__(self) -> None:
        # Instance scripting state (TS private fields) — underscore attrs, not
        # new public dataclass fields (Phase 1 class form preserved).
        self._fail_next_script: FailScript | None = None
        self._fail_by_op: dict[InferenceCallbackOpName, FailScript] = {}
        self._delay_by_op: dict[InferenceCallbackOpName, int] = {}
        self._capturing = False
        self._captured: list[CapturedInput] = []

    # Fail the next n calls to any operation, then succeed.
    def fail_next(self, n: int, failure: FailNextFailure | None = None) -> None:
        reason = (
            failure["reason"]
            if failure is not None and "reason" in failure
            else "scripted failure (failNext)"
        )
        self._fail_next_script = {"remaining": n, "reason": reason}

    # Fail the next n calls to one operation (kind names and op names both
    # accepted).
    def fail_kind(self, kind: str, n: int, failure: FailNextFailure | None = None) -> None:
        op = _resolve_op_name(kind)
        reason = (
            failure["reason"]
            if failure is not None and "reason" in failure
            else f"scripted failure ({op})"
        )
        self._fail_by_op[op] = {"remaining": n, "reason": reason}

    def delay_kind(self, kind: str, ms: int) -> None:
        self._delay_by_op[_resolve_op_name(kind)] = ms

    # Start capturing inputs; returns the live log (appended in call order).
    def capture_inputs(self) -> list[CapturedInput]:
        self._capturing = True
        return self._captured

    async def _run(
        self,
        op: InferenceCallbackOpName,
        input: object,
        text: str,
        suffix: str = "",
    ) -> InferenceResult:
        if self._capturing:
            self._captured.append(CapturedInput(op=op, input=copy.deepcopy(input)))
        delay = self._delay_by_op.get(op)
        if delay is not None and delay > 0:
            await asyncio.sleep(delay / 1000.0)
        scripts: list[FailScript | None] = [
            self._fail_next_script,
            self._fail_by_op.get(op),
        ]
        for script in scripts:
            if script is not None and script["remaining"] > 0:
                script["remaining"] -= 1
                return InferenceErr(reason=script["reason"])
        return InferenceOk(text=deterministic_text(op, input, text) + suffix)

    async def smooth_prompt(self, i: SmoothPromptInput) -> InferenceResult:
        return await self._run("smoothPrompt", i, i["text"])

    async def summarize_tool_result(self, i: SummarizeToolResultInput) -> InferenceResult:
        return await self._run("summarizeToolResult", i, i["content"])

    async def compress_detailed_turn(self, i: CompressDetailedTurnInput) -> InferenceResult:
        return await self._run("compressDetailedTurn", i, i["dialogueText"])

    async def summarize_chunk_brief(self, i: SummarizeChunkBriefInput) -> InferenceResult:
        return await self._run("summarizeChunkBrief", i, i["text"])


def create_inference_callbacks_double() -> InferenceCallbacksDouble:
    return InferenceCallbacksDouble()


# Structural satisfaction of InferenceCallbacks Protocol (documentation only).
_: type[InferenceCallbacks] | None = None
