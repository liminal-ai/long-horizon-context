"""Ported from packages/lhc/test/assignment-config.test.ts. Phase 1.

Epic 07 Story 0 — assignment config and defaults (Flow 6 + AC-0.3). Covers
the construction contract changes Story 0 installs: the typed derivation
enumeration is gone (AC-0.3), partial assignments are accepted (deterministic
types optional), per-derivation target ranges are accepted (AC-6.1), guard
defaults fill (AC-6.2), and every inference derivation type resolves to a
documented default provider lane and model when the host supplies no
overrides (AC-6.4).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import pytest

from lhc import Lhc, ModelAssignment, init_lhc
from lhc.shared_tech.derivation import CompressionTargets
from lhc.shared_tech.inference_types import DEFAULT_GUARDS, ModelCall, ModelCallInput, resolve_guards


def _recording_call() -> tuple[ModelCall, list[ModelCallInput]]:
    """A ModelCall that records every input and resolves to a minimal success.

    Pure data/logic construction — real, so the default provider/model
    routing keys are observable from the log alone (TC-6.4a) without
    depending on the per-kind canned-text fixture.
    """
    log: list[ModelCallInput] = []

    async def call(input: ModelCallInput) -> dict[str, object]:
        log.append(input)
        return {"ok": True, "text": "ok"}

    return call, log


# The four inference derivation types and the minimal input each callback
# operation accepts, so TC-6.4a can drive every default-routed lane.
_INFERENCE_OPS: list[tuple[str, Callable[[Lhc], Awaitable[object]]]] = [
    ("smoothed_prompt", lambda p: p.config.inference_callbacks.smooth_prompt({"text": "x"})),
    (
        "tool_result_summary",
        lambda p: p.config.inference_callbacks.summarize_tool_result(
            {"toolName": "read", "content": "c", "outcome": "succeeded"}
        ),
    ),
    (
        "detailed_turn_compression",
        lambda p: p.config.inference_callbacks.compress_detailed_turn(
            {
                "dialogueText": "r",
                "inputTokens": 10,
                "targetMinTokens": 4,
                "targetAimTokens": 5,
                "targetMaxTokens": 7,
            }
        ),
    ),
    (
        "chunk_summary_brief",
        lambda p: p.config.inference_callbacks.summarize_chunk_brief(
            {
                "text": "m",
                "inputTokens": 10,
                "targetMinTokens": 1,
                "targetAimTokens": 2,
                "targetMaxTokens": 3,
            }
        ),
    ),
]


def test_constructs_with_only_inference_assignments_no_deterministic_entries_required() -> None:
    """constructs with only inference assignments — no deterministic entries required"""
    assignments: dict[str, ModelAssignment] = {
        "smoothed_prompt": ModelAssignment(provider="p", model="m", prompt="smoothing-v1"),
        "tool_result_summary": ModelAssignment(provider="p", model="m", prompt="tool-result-v1"),
        "detailed_turn_compression": ModelAssignment(
            provider="p", model="m", prompt="detailed-turn-compression-v1"
        ),
        "chunk_summary_brief": ModelAssignment(provider="p", model="m", prompt="chunk-brief-v2"),
    }
    call, _log = _recording_call()
    init_lhc({"mode": "manual", "inference": {"call": call, "assignments": assignments}})


def test_constructs_when_deterministic_types_turn_rendering_chunk_summary_detailed_are_absent() -> None:
    """constructs when deterministic types (turn_rendering, chunk_summary_detailed) are absent"""
    call, _log = _recording_call()
    sdk = init_lhc(
        {
            "mode": "manual",
            "inference": {
                "call": call,
                "assignments": {
                    "smoothed_prompt": ModelAssignment(provider="p", model="m", prompt="smoothing-v1"),
                },
            },
        }
    )
    assert sdk is not None


def test_detailed_turn_compression_and_chunk_summary_brief_accept_target_ratios_without_error() -> None:
    """detailed_turn_compression and chunk_summary_brief accept target ratios without error"""
    assignments: dict[str, ModelAssignment] = {
        "smoothed_prompt": ModelAssignment(provider="p", model="m", prompt="smoothing-v1"),
        "tool_result_summary": ModelAssignment(provider="p", model="m", prompt="tool-result-v1"),
        "detailed_turn_compression": ModelAssignment(
            provider="p",
            model="m",
            prompt="detailed-turn-compression-v1",
            target_min_ratio=0.35,
            target_aim_ratio=0.5,
            target_max_ratio=0.65,
        ),
        "chunk_summary_brief": ModelAssignment(
            provider="p",
            model="m",
            prompt="chunk-brief-v2",
            target_min_ratio=0.08,
            target_aim_ratio=0.12,
            target_max_ratio=0.2,
        ),
    }
    call, _log = _recording_call()
    init_lhc({"mode": "manual", "inference": {"call": call, "assignments": assignments}})


def test_rejects_detailed_turn_compression_target_aim_outside_min_max() -> None:
    """rejects detailed_turn_compression target aim outside min/max"""
    assignments: dict[str, ModelAssignment] = {
        "detailed_turn_compression": ModelAssignment(
            provider="p",
            model="m",
            prompt="detailed-turn-compression-v1",
            target_min_ratio=0.35,
            target_aim_ratio=0.8,
            target_max_ratio=0.65,
        ),
    }
    call, _log = _recording_call()
    with pytest.raises(TypeError, match=r"compressionTargets\.aimRatio must be between minRatio and maxRatio"):
        init_lhc({"mode": "manual", "inference": {"call": call, "assignments": assignments}})


def test_rejects_chunk_summary_brief_target_aim_outside_min_max() -> None:
    """rejects chunk_summary_brief target aim outside min/max"""
    assignments: dict[str, ModelAssignment] = {
        "chunk_summary_brief": ModelAssignment(
            provider="p",
            model="m",
            prompt="chunk-brief-v2",
            target_min_ratio=0.08,
            target_aim_ratio=0.3,
            target_max_ratio=0.2,
        ),
    }
    call, _log = _recording_call()
    with pytest.raises(TypeError, match=r"briefTargets\.aimRatio must be between minRatio and maxRatio"):
        init_lhc({"mode": "manual", "inference": {"call": call, "assignments": assignments}})


def test_resolve_guards_with_no_input_returns_the_documented_defaults() -> None:
    """resolveGuards with no input returns the documented defaults"""
    guards = resolve_guards()
    assert guards == DEFAULT_GUARDS
    assert guards.smoothed_prompt.max_inference_tokens == 700
    assert guards.smoothed_prompt.suspicious_output_ratio == 0.15
    assert guards.detailed_turn_compression.tiny_turn_tokens == 80
    assert guards.tool_result_summary.timeout_ms == 60_000


def test_explicit_guards_override_per_field_while_unset_fields_keep_defaults() -> None:
    """explicit guards override per-field while unset fields keep defaults"""
    from lhc.shared_tech.inference_types import DerivationGuards, SmoothedPromptGuards

    guards = resolve_guards(DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=500)))
    assert guards.smoothed_prompt.max_inference_tokens == 500
    assert guards.smoothed_prompt.suspicious_output_ratio == 0.15
    assert guards.detailed_turn_compression.tiny_turn_tokens == 80


def test_construction_with_no_guards_succeeds_defaults_applied_at_construction() -> None:
    """construction with no guards succeeds (defaults applied at construction)"""
    call, _log = _recording_call()
    init_lhc(
        {
            "mode": "manual",
            "inference": {
                "call": call,
                "assignments": {
                    "smoothed_prompt": ModelAssignment(provider="p", model="m", prompt="smoothing-v1"),
                },
            },
        }
    )


async def test_with_no_explicit_overrides_every_inference_op_routes_to_the_default_codex_gpt_5_4_mini_lane_with_thinking_none() -> None:
    """with no explicit overrides, every inference op routes to the default codex / gpt-5.4-mini lane with thinking none"""
    call, log = _recording_call()
    sdk = init_lhc({"mode": "manual", "inference": {"call": call}})
    for _kind, run in _INFERENCE_OPS:
        await run(sdk)
    assert len(log) == len(_INFERENCE_OPS)
    for entry in log:
        assert entry.provider == "codex"
        assert entry.model == "gpt-5.4-mini"
        assert entry.thinking == "none"


async def test_preserves_thinking_none_when_override_omits_thinking() -> None:
    """preserves thinking none when override omits thinking"""
    call, log = _recording_call()
    sdk = init_lhc(
        {
            "mode": "manual",
            "inference": {
                "call": call,
                "assignments": {
                    "smoothed_prompt": ModelAssignment(provider="custom", model="custom-model", prompt="smoothing-v1"),
                },
            },
        }
    )
    await sdk.config.inference_callbacks.smooth_prompt({"text": "x"})
    assert log[0].thinking == "none"


def test_preserves_detailed_turn_compression_target_ratios_when_override_omits_them() -> None:
    """preserves detailed_turn_compression target ratios when override omits them"""
    call, _log = _recording_call()
    sdk = init_lhc(
        {
            "mode": "manual",
            "inference": {
                "call": call,
                "assignments": {
                    "detailed_turn_compression": ModelAssignment(
                        provider="p", model="m", prompt="detailed-turn-compression-v1"
                    ),
                },
            },
        }
    )
    assert sdk.config.compression_targets == CompressionTargets(min_ratio=0.35, aim_ratio=0.5, max_ratio=0.65)


async def test_allows_explicit_thinking_override() -> None:
    """allows explicit thinking override"""
    call, log = _recording_call()
    sdk = init_lhc(
        {
            "mode": "manual",
            "inference": {
                "call": call,
                "assignments": {
                    "smoothed_prompt": ModelAssignment(
                        provider="custom",
                        model="custom-model",
                        prompt="smoothing-v1",
                        thinking="high",
                    ),
                },
            },
        }
    )
    await sdk.config.inference_callbacks.smooth_prompt({"text": "x"})
    assert log[0].thinking == "high"
