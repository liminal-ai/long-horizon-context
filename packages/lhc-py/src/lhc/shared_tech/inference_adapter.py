"""Ported from packages/lhc/src/shared-tech/inference-adapter.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Wave 1 inference-prompts tests import create_inference_callbacks. Full adapter
lands in Wave 2; extend this module — do not reshape the exports below.
"""

from __future__ import annotations

from typing import TypedDict

from .derivation import InferenceCallbacks, InferenceRequestMessage, InferenceResult
from .inference_types import ModelAssignment, ModelCallFailureKind, ResolvedInferenceConfig


class TargetRatios(TypedDict, total=False):
    """Partial<Pick<ModelAssignment, targetMinRatio | targetMaxRatio | targetAimRatio>>.

    Keys are DATA (assignment field names mirrored into render input) — camelCase
    verbatim.
    """

    targetMinRatio: float
    targetMaxRatio: float
    targetAimRatio: float


# A pathological tool result must not blow a small-context model. Content over
# the bound keeps its head and tail around a marker, and the bounded whole
# stays within maxInputChars; bounding happens before prompt rendering, so the
# dropped middle never crosses the boundary.
def _bound_content(content: str, max_input_chars: int) -> str:
    raise NotImplementedError


# Failure reasons preserve the established code-before-first-colon contract.
# Provider and output failures lead with `provider_failure`; caller/config
# failures lead with their own kind.
def _inference_failure(
    kind: ModelCallFailureKind,
    message: str,
    request_messages: list[InferenceRequestMessage] | None = None,
) -> InferenceResult:
    raise NotImplementedError


# Target ratios carried on an assignment, extracted as a plain object so the
# adapter can merge them into a prompt's render input. Exported so tests pin
# the extraction directly; the adapter uses it at the call-build site below,
# making the ratios reachable by the rendering path. Token targets are computed
# by the owning handler.
def target_ratios_of(assignment: ModelAssignment | None = None) -> TargetRatios:
    raise NotImplementedError


# Merge an assignment's target ratios into a prompt's render input. The input
# is unknown at this registry boundary; ratios attach only when the input is an
# object, leaving non-object inputs untouched.
def _with_target_ratios(input: object, assignment: ModelAssignment) -> object:
    raise NotImplementedError


def create_inference_callbacks(config: ResolvedInferenceConfig) -> InferenceCallbacks:
    raise NotImplementedError
