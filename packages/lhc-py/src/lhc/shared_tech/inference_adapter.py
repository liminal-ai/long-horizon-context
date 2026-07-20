"""Ported from packages/lhc/src/shared-tech/inference-adapter.ts. Phase 1 skeleton.

create_inference_callbacks returns the same InferenceCallbacks interface direct
injection implements, so init_lhc and everything below it sees callback
operations.
"""

from __future__ import annotations

import math
from typing import TypedDict

from .classify import safe_call
from .derivation import (
    InferenceCallbacks,
    InferenceErr,
    InferenceOk,
    InferenceRequestMessage,
    InferenceResult,
    ProviderProvenance,
)
from ._jsstr import js_len, js_slice
from .inference_types import ModelAssignment, ModelCallFailureKind, ModelCallInput, ResolvedInferenceConfig
from .prompts import PROMPT_REGISTRY, PromptTemplate

# Tool-result bounding marker template; content length is inserted at runtime.
# TS-private (not exported from inference-adapter.ts).
_TRUNCATION_MARKER_TEMPLATE = (
    "\n\n[... truncated: tool result was {length} chars; head and tail retained ...]\n\n"
)


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
    # TS: content.length / slice — UTF-16 code-unit semantics.
    if js_len(content) <= max_input_chars:
        return content
    marker = _TRUNCATION_MARKER_TEMPLATE.format(length=js_len(content))
    # The marker only earns its place when head + marker + tail still fits the
    # bound. When maxInputChars is smaller than the marker itself, there is no
    # budget for the marker — emitting it would be the one path that crosses the
    # configured boundary exists to hold, so degrade to a plain head truncation
    # that honors the cap exactly.
    if js_len(marker) > max_input_chars:
        return js_slice(content, 0, max_input_chars)
    keep = max_input_chars - js_len(marker)
    head = math.ceil(keep / 2)
    tail = keep - head
    return (
        js_slice(content, 0, head)
        + marker
        + (js_slice(content, js_len(content) - tail) if tail > 0 else "")
    )


# Failure reasons preserve the established code-before-first-colon contract.
# Provider and output failures lead with `provider_failure`; caller/config
# failures lead with their own kind.
def _inference_failure(
    kind: ModelCallFailureKind,
    message: str,
    request_messages: list[InferenceRequestMessage] | None = None,
) -> InferenceResult:
    detail = kind if message == "" else f"{kind}: {message}"
    reason = detail if kind in ("auth", "invalid_request") else f"provider_failure: {detail}"
    return InferenceErr(reason=reason, request_messages=request_messages)


# Target ratios carried on an assignment, extracted as a plain object so the
# adapter can merge them into a prompt's render input. Exported so tests pin
# the extraction directly; the adapter uses it at the call-build site below,
# making the ratios reachable by the rendering path. Token targets are computed
# by the owning handler.
def target_ratios_of(assignment: ModelAssignment | None) -> TargetRatios:
    if assignment is None:
        return {}
    out: TargetRatios = {}
    if assignment.target_min_ratio is not None:
        out["targetMinRatio"] = assignment.target_min_ratio
    if assignment.target_max_ratio is not None:
        out["targetMaxRatio"] = assignment.target_max_ratio
    if assignment.target_aim_ratio is not None:
        out["targetAimRatio"] = assignment.target_aim_ratio
    return out


# Merge an assignment's target ratios into a prompt's render input. The input
# is unknown at this registry boundary; ratios attach only when the input is an
# object, leaving non-object inputs untouched.
def _with_target_ratios(input: object, assignment: ModelAssignment) -> object:
    ratios = target_ratios_of(assignment)
    if not isinstance(input, dict):
        return input
    return {**input, **ratios}


# TS nests callKind inside createInferenceCallbacks; Phase 2 wires the four
# InferenceCallbacks methods through this helper.
async def _call_kind(
    config: ResolvedInferenceConfig,
    kind: str,
    input: object,
) -> InferenceResult:
    assignment = config.assignments.get(kind)
    if assignment is None:
        return _inference_failure("invalid_request", f'no assignment for derivation type "{kind}"')
    template: PromptTemplate[object] | None = PROMPT_REGISTRY.get(assignment.prompt)  # type: ignore[assignment]
    if template is None:
        return _inference_failure(
            "invalid_request", f'prompt template "{assignment.prompt}" not in registry'
        )
    messages = template.render(_with_target_ratios(input, assignment))  # type: ignore[arg-type]
    call_input = ModelCallInput(
        provider=assignment.provider,
        model=assignment.model,
        messages=messages,
        thinking=assignment.thinking,
    )
    result = await safe_call(config.call, call_input, config.timeout_ms)
    ok = result["ok"] if isinstance(result, dict) else result.ok
    if not ok:
        kind = result["kind"] if isinstance(result, dict) else result.kind
        message = result["message"] if isinstance(result, dict) else result.message
        return _inference_failure(kind, message, messages)  # type: ignore[arg-type]
    raw_text = result["text"] if isinstance(result, dict) else result.text
    text = raw_text.strip()
    if text == "":
        return _inference_failure(
            "empty_output", "model returned empty or whitespace-only text", messages
        )
    return InferenceOk(
        text=text,
        provenance=ProviderProvenance(
            provider=assignment.provider,
            model=assignment.model,
            prompt=assignment.prompt,
        ),
        request_messages=messages,
        raw_response=raw_text,
    )


def create_inference_callbacks(config: ResolvedInferenceConfig) -> InferenceCallbacks:
    class _AdapterCallbacks:
        async def smooth_prompt(self, i: object) -> InferenceResult:
            return await _call_kind(config, "smoothed_prompt", i)

        async def summarize_tool_result(self, i: object) -> InferenceResult:
            assert isinstance(i, dict)
            return await _call_kind(
                config,
                "tool_result_summary",
                {
                    "toolName": i["toolName"],
                    "content": _bound_content(i["content"], config.max_input_chars),
                    "outcome": i["outcome"] if "outcome" in i and i["outcome"] is not None else "unknown",
                    "targetTokens": (
                        i["targetTokens"]
                        if "targetTokens" in i and i["targetTokens"] is not None
                        else 150
                    ),
                    "operationClass": (
                        i["operationClass"]
                        if "operationClass" in i and i["operationClass"] is not None
                        else "unknown"
                    ),
                    "responseShape": (
                        i["responseShape"]
                        if "responseShape" in i and i["responseShape"] is not None
                        else "unknown_content"
                    ),
                    "promptMode": (
                        i["promptMode"]
                        if "promptMode" in i and i["promptMode"] is not None
                        else "generic_summary"
                    ),
                    "facts": i["facts"] if "facts" in i and i["facts"] is not None else {},
                },
            )

        async def compress_detailed_turn(self, i: object) -> InferenceResult:
            return await _call_kind(config, "detailed_turn_compression", i)

        async def summarize_chunk_brief(self, i: object) -> InferenceResult:
            return await _call_kind(config, "chunk_summary_brief", i)

    return _AdapterCallbacks()  # type: ignore[return-value]
