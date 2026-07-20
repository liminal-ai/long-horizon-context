"""Ported from packages/lhc/src/shared-tech/derivation.ts. Phase 1 — PARTIAL.

PARTIAL PORT: only the type surface needed by the Wave 0 exemplars
(deterministic.py, classify_tool_result.py) is here. Wave 1 completes this
module from derivation.ts — extend it; the definitions below are already
faithful and must not be reshaped.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Literal, Protocol, TypedDict, Union

ToolOutcome = Literal["succeeded", "failed", "unknown"]


# Recorded by the inference adapter (it alone knows the assignment) and copied
# by handlers into derivation metadata. Never derived from model output.
@dataclass(frozen=True, slots=True)
class ProviderProvenance:
    provider: str
    model: str
    prompt: str


class InferenceRequestMessage(TypedDict):
    role: Literal["system", "user"]
    content: str


@dataclass(frozen=True, slots=True)
class InferenceOk:
    text: str
    provenance: ProviderProvenance | None = None
    request_messages: list[InferenceRequestMessage] | None = None
    raw_response: str | None = None
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class InferenceErr:
    reason: str
    request_messages: list[InferenceRequestMessage] | None = None
    ok: Literal[False] = False


InferenceResult = Union[InferenceOk, InferenceErr]

ToolResultOperationClass = Literal[
    "read",
    "mutation_write",
    "mutation_edit",
    "command",
    "search_or_listing",
    "verification",
    "vcs_inspection",
    "filesystem_mutation",
    "multi_tool",
    "unknown",
]

ToolResultResponseShape = Literal[
    "structured_receipt",
    "simple_failure",
    "no_output",
    "search_result",
    "test_result",
    "file_content",
    "large_file_content",
    "diff_output",
    "large_log",
    "multi_tool_result",
    "unknown_content",
]

ToolResultPromptMode = Literal[
    "receipt",
    "failure",
    "no_output",
    "search_summary",
    "test_summary",
    "content_summary",
    "diff_summary",
    "large_log",
    "multi_tool_summary",
    "generic_summary",
]

# Facts dict keys are DATA, not identifiers — they stay camelCase exactly as
# in the TS ("exitCode", "toolName", ...). See the port brief's conventions.
ToolResultFacts = dict[str, object]


@dataclass(frozen=True, slots=True)
class ToolResultClassification:
    operation_class: ToolResultOperationClass
    response_shape: ToolResultResponseShape
    prompt_mode: ToolResultPromptMode
    facts: ToolResultFacts


class SmoothPromptInput(TypedDict):
    text: str


class SummarizeToolResultInput(TypedDict, total=False):
    toolName: str
    content: str
    outcome: ToolOutcome
    targetTokens: int
    operationClass: ToolResultOperationClass
    responseShape: ToolResultResponseShape
    promptMode: ToolResultPromptMode
    facts: ToolResultFacts


class CompressDetailedTurnInput(TypedDict):
    dialogueText: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class SummarizeChunkBriefInput(TypedDict):
    text: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class InferenceCallbacks(Protocol):
    def smooth_prompt(self, i: SmoothPromptInput) -> Awaitable[InferenceResult]: ...

    def summarize_tool_result(self, i: SummarizeToolResultInput) -> Awaitable[InferenceResult]: ...

    def compress_detailed_turn(self, i: CompressDetailedTurnInput) -> Awaitable[InferenceResult]: ...

    def summarize_chunk_brief(self, i: SummarizeChunkBriefInput) -> Awaitable[InferenceResult]: ...
