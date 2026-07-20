"""Ported from packages/lhc/src/shared-tech/inference-types.ts. Phase 1 skeleton.

Inference boundary vocabulary: the one function a host supplies, its
structured result shapes, and the config that arrives at init_lhc as the
alternative to direct inference callback injection. LHC treats provider/model
strings as host routing keys; the host's ModelCall implementation is the only
code that interprets them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, TypedDict

ModelCallFailureKind = Literal[
    "rate_limit",
    "timeout",
    "network",
    "empty_output",  # adapter-generated; hosts never return it. Thrown exceptions classify as `other`.
    "other",
    "auth",
    "invalid_request",
]


class ModelCallMessage(TypedDict):
    role: Literal["system", "user"]
    content: str


ThinkingLevel = Literal["none", "minimal", "medium", "high"]


@dataclass(frozen=True, slots=True)
class ModelCallInput:
    provider: str
    model: str
    messages: list[ModelCallMessage]
    thinking: ThinkingLevel | None = None


@dataclass(frozen=True, slots=True)
class ModelCallOk:
    text: str
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class ModelCallErr:
    kind: ModelCallFailureKind
    message: str
    ok: Literal[False] = False


ModelCallResult = ModelCallOk | ModelCallErr

# The one function a host supplies. Single-turn completion; provider/model
# are host routing keys the host's implementation interprets.
ModelCall = Callable[[ModelCallInput], Awaitable[ModelCallResult]]


@dataclass(frozen=True, slots=True)
class ModelAssignment:
    provider: str
    model: str
    prompt: str  # must name a PROMPT_REGISTRY entry
    target_min_ratio: float | None = None
    target_max_ratio: float | None = None
    target_aim_ratio: float | None = None
    thinking: ThinkingLevel | None = None


@dataclass(frozen=True, slots=True)
class SmoothedPromptGuards:
    max_inference_tokens: int | None = None  # default 700
    suspicious_output_ratio: float | None = None  # default 0.15


@dataclass(frozen=True, slots=True)
class ToolResultSummaryGuards:
    timeout_ms: int | None = None  # default 60_000


@dataclass(frozen=True, slots=True)
class DetailedTurnCompressionGuards:
    tiny_turn_tokens: int | None = None  # default 80


@dataclass(frozen=True, slots=True)
class DerivationGuards:
    smoothed_prompt: SmoothedPromptGuards | None = None
    tool_result_summary: ToolResultSummaryGuards | None = None
    detailed_turn_compression: DetailedTurnCompressionGuards | None = None


@dataclass(frozen=True, slots=True)
class ResolvedSmoothedPromptGuards:
    max_inference_tokens: int
    suspicious_output_ratio: float


@dataclass(frozen=True, slots=True)
class ResolvedToolResultSummaryGuards:
    timeout_ms: int


@dataclass(frozen=True, slots=True)
class ResolvedDetailedTurnCompressionGuards:
    tiny_turn_tokens: int


@dataclass(frozen=True, slots=True)
class ResolvedDerivationGuards:
    smoothed_prompt: ResolvedSmoothedPromptGuards
    tool_result_summary: ResolvedToolResultSummaryGuards
    detailed_turn_compression: ResolvedDetailedTurnCompressionGuards


@dataclass(frozen=True, slots=True)
class InferenceConfig:
    """SdkConfig.inference: the alternative to SdkConfig.inference_callbacks."""

    call: ModelCall
    # Partial by design: inference derivation types the host omits are filled
    # from DEFAULT_INFERENCE_ASSIGNMENTS; deterministic types are optional.
    # Unknown keys are rejected at construction.
    assignments: dict[str, ModelAssignment] | None = None
    timeout_ms: int | None = None  # default 60_000
    max_input_chars: int | None = None  # default 200_000


@dataclass(frozen=True, slots=True)
class ResolvedInferenceConfig:
    """InferenceConfig after init_lhc validation: every optional filled."""

    call: ModelCall
    assignments: dict[str, ModelAssignment]
    guards: ResolvedDerivationGuards
    timeout_ms: int
    max_input_chars: int


# Default guard values: documented operational limits applied when the host
# omits a guard. Centralized so construction and tests share one source of
# truth for the defaults.
DEFAULT_GUARDS = ResolvedDerivationGuards(
    smoothed_prompt=ResolvedSmoothedPromptGuards(
        max_inference_tokens=700,
        suspicious_output_ratio=0.15,
    ),
    tool_result_summary=ResolvedToolResultSummaryGuards(timeout_ms=60_000),
    detailed_turn_compression=ResolvedDetailedTurnCompressionGuards(tiny_turn_tokens=80),
)


def resolve_guards(guards: DerivationGuards | None = None) -> ResolvedDerivationGuards:
    raise NotImplementedError
