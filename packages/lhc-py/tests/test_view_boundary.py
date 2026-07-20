"""Ported from packages/lhc/test/view-boundary.test.ts. Phase 1.

Epic 03 Story 4: visibility boundary rendering and the no-auto-advance
intake contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pytest

from lhc import Lhc, MessageEventInput, init_lhc, set_scheduler_poke
from lhc.messages import RemoveInput
from lhc.shared_tech.derivation import SdkConfig, ToolResultConfig
from lhc.shared_tech.view import (
    LlmRequestContextMessage,
    PartialVisibilityBudgets,
    SdkViewConfig,
    ViewCompactParams,
)
from lhc.thread_view import CompactOpts
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    seed_view_boundary,
    temp_store,
    valid_event,
)


def _tokens(n: int) -> str:
    return " ".join(["tok"] * n)


_BUDGETS = PartialVisibilityBudgets(max_tokens=100, target_tokens=60)

_stores: list[TempStore] = []
_call_counter = 0


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    set_scheduler_poke(None)
    for store in _stores[:]:
        store.cleanup()
    _stores.clear()


def _vis_sdk(
    view: SdkViewConfig | None = None,
    mode: Literal["manual", "background"] = "manual",
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode=mode,
            view=view if view is not None else SdkViewConfig(visibility=_BUDGETS),
        )
    )


async def _new_thread(sdk: Lhc) -> str:
    store = temp_store()
    _stores.append(store)
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return file_path


def _tool_run(result_tokens: int) -> list[MessageEventInput]:
    global _call_counter
    _call_counter += 1
    tool_call_id = f"call-vb-{_call_counter}"
    return [
        valid_event(
            "tool_call",
            {
                "payload": {
                    "toolCallId": tool_call_id,
                    "toolName": "read_file",
                    "arguments": {"path": f"vb-{_call_counter}.txt"},
                },
            },
        ),
        valid_event(
            "tool_result",
            {
                "payload": {
                    "toolCallId": tool_call_id,
                    "content": _tokens(result_tokens),
                    "isError": False,
                },
            },
        ),
    ]


@dataclass(frozen=True, slots=True)
class _ToolTurnOpts:
    turn_end: bool = True


def _tool_turn(result_tokens: list[int], opts: _ToolTurnOpts | None = None) -> list[MessageEventInput]:
    opts = opts if opts is not None else _ToolTurnOpts()
    events: list[MessageEventInput] = [
        valid_event("user_prompt", {"payload": {"text": "scripted boundary turn"}})
    ]
    for n in result_tokens:
        events.extend(_tool_run(n))
    if opts.turn_end is not False:
        events.append(valid_event("turn_end"))
    return events


async def _intake(sdk: Lhc, file_path: str, batch: list[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"intake failed: {result.error.reason}")


async def _boundary_of(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT position FROM view_boundary").get()
        assert row is not None
        return int(row["position"])  # type: ignore[arg-type]
    finally:
        db.close()


@dataclass(frozen=True, slots=True)
class _ToolResultRow:
    message_id: str
    source_event_order: int
    token_estimate: int


async def _tool_results(sdk: Lhc, file_path: str) -> list[_ToolResultRow]:
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError(f"list failed: {listed.error.reason}")
    return [
        _ToolResultRow(
            message_id=m.message_id,
            source_event_order=m.source_event_order,
            token_estimate=m.token_estimate,
        )
        for m in listed.value
        if m.kind == "tool_result"
    ]


def _message_text(message: LlmRequestContextMessage) -> str:
    return "".join(part.text for part in message.content)


def _message_texts(messages: list[LlmRequestContextMessage]) -> list[str]:
    return [_message_text(message) for message in messages]


def _abridged_count(messages: list[LlmRequestContextMessage]) -> int:
    return sum(
        1
        for m in messages
        if (text := _message_text(m)).startswith("[tool result · ") and " · abridged]" in text
    )


async def test_holds_position_below_max_then_respects_a_seeded_boundary_that_flips_the_oldest_whole_turn() -> None:
    """holds position below max, then respects a seeded boundary that flips the oldest whole turn"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)

    await _intake(sdk, file_path, _tool_turn([20, 20]))
    after_first = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert after_first.ok is True
    if not after_first.ok:
        return
    assert await _boundary_of(file_path) == 0

    await _intake(sdk, file_path, _tool_turn([20, 20]))
    after_second = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert after_second.ok is True
    if not after_second.ok:
        return
    assert await _boundary_of(file_path) == 0
    assert after_second.value.messages[: len(after_first.value.messages)] == after_first.value.messages
    assert _abridged_count(after_second.value.messages) == 0

    await _intake(sdk, file_path, _tool_turn([20, 20]))
    results = await _tool_results(sdk, file_path)
    assert len(results) == 6
    assert await _boundary_of(file_path) == 0

    expected_position = results[1].source_event_order if len(results) > 1 else 0
    seed_view_boundary(file_path, expected_position)
    crossed = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert crossed.ok is True
    if not crossed.ok:
        return
    assert await _boundary_of(file_path) == expected_position
    assert _abridged_count(crossed.value.messages) == 2

    abridged_ids = [r.message_id for r in results if r.source_event_order <= expected_position]
    assert abridged_ids == [r.message_id for r in results[:2]]

    status = await sdk.thread_view.status({"filePath": file_path})
    assert status.ok is True
    if not status.ok:
        return
    expected_zone = sum(
        r.token_estimate for r in results if r.source_event_order > expected_position
    )
    assert status.value.visibility.zone_tokens == expected_zone
    assert status.value.visibility.zone_tokens == 80

    await _intake(sdk, file_path, _tool_turn([10]))
    assert await _boundary_of(file_path) == expected_position


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_renders_deterministic_tool_result_floors_even_when_a_ready_summary_exists() -> None:
    """renders deterministic tool-result floors even when a ready summary exists"""
    double = create_inference_callbacks_double()
    sdk = init_lhc(
        SdkConfig(
            inference_callbacks=double,
            mode="manual",
            view=SdkViewConfig(visibility=_BUDGETS),
            tool_result=ToolResultConfig(
                small_tier_tokens=1, small_target_ratio=0.15, mid_target_ratio=0.04
            ),
        )
    )
    file_path = await _new_thread(sdk)

    await _intake(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "flip rendering prompt"}}),
            *_tool_run(60),
            valid_event("assistant_text", {"payload": {"text": "interleaved assistant text"}}),
            *_tool_run(20),
            valid_event("turn_end"),
        ],
    )
    double.fail_kind(
        "tool_result_summary",
        1,
        {"reason": "content_refusal: scripted permanent failure (boundary test)"},
    )
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    results = [m for m in listed.value if m.kind == "tool_result"]
    assert len(results) >= 2
    r1, r2 = results[0], results[1]
    assert next(
        (f for f in (r1.derivations or []) if f.derivation_type == "tool_result_summary"),
        None,
    ) is not None and next(
        (f for f in (r1.derivations or []) if f.derivation_type == "tool_result_summary"),
        None,
    ).state == "ready"
    r2_summary = next(
        (
            f.content
            for f in (r2.derivations or [])
            if f.derivation_type == "tool_result_summary" and f.state == "ready"
        ),
        None,
    )
    assert r2_summary is not None

    await _intake(sdk, file_path, _tool_turn([80]))
    seed_view_boundary(file_path, r2.source_event_order)

    context_read = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context_read.ok is True
    if not context_read.ok:
        return
    contents = _message_texts(context_read.value.messages)

    assert f"[tool result · read_file · abridged]\n{_tokens(60)}" in contents
    assert f"[tool result · read_file · abridged]\n{_tokens(20)}" in contents
    assert f"[tool result · read_file · abridged]\n{r2_summary}" not in contents
    assert "interleaved assistant text" in contents
    assert f"[tool result · read_file]\n{_tokens(80)}" in contents


async def test_resets_a_seeded_boundary_to_the_compact_point_with_a_full_fresh_tail() -> None:
    """resets a seeded boundary to the compact point with a full fresh tail"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    for _ in range(3):
        await _intake(sdk, file_path, _tool_turn([20, 20]))
    results = await _tool_results(sdk, file_path)
    seeded_position = results[1].source_event_order if len(results) > 1 else 0
    seed_view_boundary(file_path, seeded_position)
    assert await _boundary_of(file_path) == seeded_position

    receipt = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(params=ViewCompactParams(lower_bound=40)),
    )
    assert receipt.ok is True
    if not receipt.ok:
        return
    after_compact = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert after_compact.ok is True
    if not after_compact.ok:
        return
    assert await _boundary_of(file_path) == receipt.value.compact_point

    await _intake(sdk, file_path, _tool_turn([20]))
    fresh = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert fresh.ok is True
    if not fresh.ok:
        return
    assert _abridged_count(fresh.value.messages) == 0
    assert f"[tool result · read_file]\n{_tokens(20)}" in _message_texts(fresh.value.messages)


def test_rejects_max_le_target_at_construction_naming_the_constraint() -> None:
    """rejects max ≤ target at construction, naming the constraint"""
    with pytest.raises(
        Exception,
        match=r"maxTokens \(100\) must be greater than targetTokens \(200\)",
    ):
        _vis_sdk(SdkViewConfig(visibility=PartialVisibilityBudgets(max_tokens=100, target_tokens=200)))


async def test_background_mode_intake_commits_over_max_tool_results_with_boundary_unchanged() -> None:
    """background mode: intake commits over-max tool results with boundary unchanged and drain still runs"""
    sdk = _vis_sdk(SdkViewConfig(visibility=_BUDGETS), "background")
    file_path = await _new_thread(sdk)

    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [*_tool_turn([40]), *_tool_turn([40]), *_tool_turn([40])],
    )
    assert result.ok is True
    if not result.ok:
        return
    assert all(e.outcome == "recorded" for e in result.value.events)

    results = await _tool_results(sdk, file_path)
    assert len(results) == 3
    assert await _boundary_of(file_path) == 0
    status = await sdk.thread_view.status({"filePath": file_path})
    assert status.ok is True
    if not status.ok:
        return
    assert status.value.visibility.zone_tokens == 120
    assert status.value.visibility.zone_tokens > status.value.visibility.max_tokens

    await sdk.drain_settled({"filePath": file_path})
    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    tool_results = [msg for msg in listed.value if msg.kind == "tool_result"]
    # Anti-vacuous guard: an implementation that drops tool_result messages
    # must not pass this block by emptying the loop.
    assert len(tool_results) > 0
    for m in tool_results:
        assert next(
            (f for f in (m.derivations or []) if f.derivation_type == "tool_result_summary"),
            None,
        ) is not None and next(
            (f for f in (m.derivations or []) if f.derivation_type == "tool_result_summary"),
            None,
        ).state == "ready"


async def test_drops_a_deleted_zone_result_from_the_live_sum() -> None:
    """drops a deleted zone result from the live sum"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([40, 40]))
    assert await _boundary_of(file_path) == 0

    results = await _tool_results(sdk, file_path)
    deleted = await sdk.messages.remove(
        {"filePath": file_path},
        RemoveInput(message_id=results[0].message_id if results else ""),
    )
    assert deleted.ok is True
    status = await sdk.thread_view.status({"filePath": file_path})
    assert status.ok is True
    if not status.ok:
        return
    assert status.value.visibility.zone_tokens == 40


@pytest.mark.parametrize("mode", ["manual", "background"])
async def test_mode_sdk_intake_does_not_auto_advance_the_boundary(
    mode: Literal["manual", "background"],
) -> None:
    """%s-mode SDK intake does not auto-advance the boundary"""
    sdk = _vis_sdk(SdkViewConfig(visibility=_BUDGETS), mode)
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, [*_tool_turn([40]), *_tool_turn([40]), *_tool_turn([40])])
    assert await _boundary_of(file_path) == 0
    if mode == "background":
        await sdk.drain_settled({"filePath": file_path})
