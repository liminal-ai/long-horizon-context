"""Ported from packages/lhc/test/fixtures/model-call.ts. Phase 1.

Constants and pure assignment/response maps are REAL. Call builders that
return ModelCall functions are skeletons.
"""

from __future__ import annotations

import asyncio
import copy
from typing import Literal, NotRequired, TypedDict

from lhc.shared_tech.inference_types import (
    ModelAssignment,
    ModelCall,
    ModelCallInput,
    ModelCallOk,
    ModelCallResult,
    ThinkingLevel,
)
from lhc.shared_tech.prompts import DEFAULT_PROMPT_NAMES

DERIVATION_TYPES = (
    "smoothed_prompt",
    "tool_result_summary",
    "turn_rendering",
    "pre_detailed_assembly",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
)
DerivationType = Literal[
    "smoothed_prompt",
    "tool_result_summary",
    "turn_rendering",
    "pre_detailed_assembly",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
]

INFERENCE_DERIVATION_TYPES = (
    "smoothed_prompt",
    "tool_result_summary",
    "detailed_turn_compression",
    "chunk_summary_brief",
)
InferenceDerivationType = Literal[
    "smoothed_prompt",
    "tool_result_summary",
    "detailed_turn_compression",
    "chunk_summary_brief",
]

# The prompt template a fixture assignment selects for a kind: the inference
# default when one exists, else the deterministic type's own template.
def _fixture_prompt(kind: InferenceDerivationType) -> str:
    inference_default = DEFAULT_PROMPT_NAMES.get(kind)
    if inference_default is not None:
        return inference_default
    return "unknown-prompt"


# validAssignments gives every kind a distinct fake provider/model lane;
# recordingCall infers the kind back from the model string, so per-kind
# routing is observable from the log alone (TC-1.2).
FAKE_PROVIDER_PREFIX = "prov-"
FAKE_MODEL_PREFIX = "model-"


class ModelAssignmentOverride(TypedDict, total=False):
    """Partial<ModelAssignment> — TS camelCase data keys."""

    provider: str
    model: str
    prompt: str
    targetMinRatio: float
    targetMaxRatio: float
    targetAimRatio: float
    thinking: ThinkingLevel


def valid_assignments(
    overrides: dict[InferenceDerivationType, ModelAssignmentOverride] | None = None,
) -> dict[InferenceDerivationType, ModelAssignment]:
    """Every kind gets a distinct fake provider/model lane — pure data.

    Applies every override field (provider/model/prompt/ratios/thinking),
    matching TS object spread onto the base assignment.
    """
    overrides = overrides or {}
    result: dict[InferenceDerivationType, ModelAssignment] = {}
    for kind in INFERENCE_DERIVATION_TYPES:
        ov = overrides.get(kind, {})
        result[kind] = ModelAssignment(
            provider=ov["provider"] if "provider" in ov else f"{FAKE_PROVIDER_PREFIX}{kind}",
            model=ov["model"] if "model" in ov else f"{FAKE_MODEL_PREFIX}{kind}",
            prompt=ov["prompt"] if "prompt" in ov else _fixture_prompt(kind),
            target_min_ratio=ov.get("targetMinRatio"),
            target_max_ratio=ov.get("targetMaxRatio"),
            target_aim_ratio=ov.get("targetAimRatio"),
            thinking=ov.get("thinking"),
        )
    return result


# One distinct canned sentence per kind, so cross-kind bleed is visible in
# landed form content, never just in call counts.
def canned_responses() -> dict[DerivationType, str]:
    return {kind: f"canned {kind} text from the fake host" for kind in DERIVATION_TYPES}


class RecordingCallBundle(TypedDict):
    call: ModelCall
    log: list[ModelCallInput]


# Resolves each call with its kind's canned text — the kind inferred from
# the model routing key validAssignments made unique per kind. Every input
# is cloned into `log` in call order. An unknown model is a test bug and
# throws loudly.
def recording_call(responses: dict[DerivationType, str]) -> RecordingCallBundle:
    log: list[ModelCallInput] = []
    known = set(INFERENCE_DERIVATION_TYPES)

    async def call(input: ModelCallInput) -> ModelCallResult:
        log.append(copy.deepcopy(input))
        kind = (
            input.model[len(FAKE_MODEL_PREFIX) :]
            if input.model.startswith(FAKE_MODEL_PREFIX)
            else input.model
        )
        if kind not in known:
            raise RuntimeError(f'recordingCall: no canned response for model "{input.model}"')
        return ModelCallOk(text=responses[kind])  # type: ignore[index]

    return {"call": call, "log": log}


# Returns script entries in order; a call past the end of the script is a
# test bug and throws loudly.
def scripted_call(script: list[ModelCallResult]) -> ModelCall:
    next_index = 0

    async def call(input: ModelCallInput) -> ModelCallResult:
        nonlocal next_index
        if next_index >= len(script):
            raise RuntimeError(
                f'scriptedCall: script exhausted after {len(script)} calls (model "{input.model}")'
            )
        entry = script[next_index]
        next_index += 1
        return entry

    return call


# A host whose function throws — the AC-3.3 containment leg.
def throwing_call(error: Exception) -> ModelCall:
    async def call(_input: ModelCallInput) -> ModelCallResult:
        raise error

    return call


# A host that never settles — the DD-6 timeout leg (tests pass a small
# timeoutMs).
def hanging_call() -> ModelCall:
    async def call(_input: ModelCallInput) -> ModelCallResult:
        await asyncio.Future()  # never settles
        raise AssertionError("unreachable")

    return call
