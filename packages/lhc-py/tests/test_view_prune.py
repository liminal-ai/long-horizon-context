"""Ported from packages/lhc/test/view-prune.test.ts. Phase 1.

Item 29: manual tool-result prune via the visibility boundary.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from lhc import Lhc, MessageEventInput, init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    LlmRequestContextMessage,
    PartialVisibilityBudgets,
    SdkViewConfig,
)
from lhc.thread_view import PruneParams
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    temp_store,
    valid_event,
)


def _tokens(n: int) -> str:
    return " ".join(["tok"] * n)


_BUDGETS = PartialVisibilityBudgets(max_tokens=100, target_tokens=60)

_stores: list[TempStore] = []
_call_counter = 0


@pytest.fixture(autouse=True)
def _cleanup_stores():
    yield
    for store in _stores[:]:
        store.cleanup()
    _stores.clear()


def _vis_sdk(view: SdkViewConfig | None = None) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode="manual",
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
    tool_call_id = f"call-prune-{_call_counter}"
    return [
        valid_event(
            "tool_call",
            {
                "payload": {
                    "toolCallId": tool_call_id,
                    "toolName": "read_file",
                    "arguments": {"path": f"prune-{_call_counter}.txt"},
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
    events: list[MessageEventInput] = [valid_event("user_prompt", {"payload": {"text": "prune turn"}})]
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


def _abridged_count(messages: list[LlmRequestContextMessage]) -> int:
    return sum(
        1
        for m in messages
        if (text := _message_text(m)).startswith("[tool result · ") and " · abridged]" in text
    )


async def test_advances_boundary_from_zero_so_older_tool_results_render_short() -> None:
    """advances boundary from zero so older tool results render short"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([20, 20, 20, 20]))

    receipt = await sdk.thread_view.prune({"filePath": file_path})
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.no_op is False
    assert receipt.value.previous_boundary == 0
    assert receipt.value.zone_tokens_before == 80
    assert receipt.value.zone_tokens_after <= (_BUDGETS.target_tokens or 0)
    assert receipt.value.tool_results_pruned > 0
    assert receipt.value.zone_tokens_before - receipt.value.zone_tokens_after > 0

    results = await _tool_results(sdk, file_path)
    assert await _boundary_of(file_path) == receipt.value.new_boundary
    assert receipt.value.new_boundary == results[0].source_event_order

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return
    assert _abridged_count(context.value.messages) == receipt.value.tool_results_pruned


async def test_starts_from_the_compact_point_boundary_and_prunes_only_the_tail_zone() -> None:
    """starts from the compact point boundary and prunes only the tail zone"""
    from lhc.thread_view import CompactOpts
    from lhc.shared_tech.view import ViewCompactParams

    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    for _ in range(3):
        await _intake(sdk, file_path, _tool_turn([20, 20]))

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(params=ViewCompactParams(lower_bound=40)),
    )
    assert compacted.ok is True
    if not compacted.ok:
        return
    compact_point = compacted.value.compact_point
    assert await _boundary_of(file_path) == compact_point

    await _intake(sdk, file_path, _tool_turn([20, 20, 20, 20]))
    before = await sdk.thread_view.status({"filePath": file_path})
    assert before.ok is True
    if not before.ok:
        return
    assert before.value.visibility.zone_tokens > (_BUDGETS.target_tokens or 0)

    receipt = await sdk.thread_view.prune({"filePath": file_path})
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.no_op is False
    assert receipt.value.compact_point == compact_point
    assert receipt.value.previous_boundary == compact_point
    assert receipt.value.new_boundary > compact_point
    assert receipt.value.zone_tokens_after <= (_BUDGETS.target_tokens or 0)


async def test_honors_an_explicit_target() -> None:
    """honors an explicit target"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([30, 30, 30]))

    receipt = await sdk.thread_view.prune({"filePath": file_path}, PruneParams(target_tokens=30))
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.target_tokens == 30
    assert receipt.value.no_op is False
    assert receipt.value.zone_tokens_after <= 30


async def test_rejects_non_integer_or_negative_target_tokens() -> None:
    """rejects non-integer or negative targetTokens"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([20]))

    bad = await sdk.thread_view.prune({"filePath": file_path}, PruneParams(target_tokens=-1))
    assert bad.ok is False
    if bad.ok:
        return
    assert bad.error.code == "invalid_target_tokens"

    fractional = await sdk.thread_view.prune({"filePath": file_path}, PruneParams(target_tokens=10.5))
    assert fractional.ok is False
    if fractional.ok:
        return
    assert fractional.error.code == "invalid_target_tokens"


async def test_reports_no_op_when_the_zone_is_already_under_target() -> None:
    """reports no-op when the zone is already under target"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([20, 20]))

    receipt = await sdk.thread_view.prune({"filePath": file_path})
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.no_op is True
    assert receipt.value.zone_tokens_before == 40
    assert receipt.value.zone_tokens_after == 40
    assert receipt.value.tool_results_pruned == 0
    assert receipt.value.new_boundary == receipt.value.previous_boundary
    assert await _boundary_of(file_path) == 0


async def test_does_not_move_the_boundary_backward_when_a_second_prune_uses_a_larger_target() -> None:
    """does not move the boundary backward when a second prune uses a larger target"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    sizes = [20, 21, 22, 23]
    await _intake(sdk, file_path, _tool_turn(sizes))

    first = await sdk.thread_view.prune({"filePath": file_path}, PruneParams(target_tokens=20))
    assert first.ok is True
    if not first.ok:
        return
    assert first.value.no_op is False
    after_first = first.value.new_boundary

    second = await sdk.thread_view.prune({"filePath": file_path}, PruneParams(target_tokens=60))
    assert second.ok is True
    if not second.ok:
        return
    assert second.value.no_op is True
    assert second.value.new_boundary == after_first
    assert await _boundary_of(file_path) == after_first


async def test_places_the_boundary_at_the_newest_tool_result_when_it_alone_exceeds_target() -> None:
    """places the boundary at the newest tool result when it alone exceeds target"""
    sdk = _vis_sdk(
        SdkViewConfig(visibility=PartialVisibilityBudgets(max_tokens=100, target_tokens=30))
    )
    file_path = await _new_thread(sdk)
    await _intake(sdk, file_path, _tool_turn([50]))

    receipt = await sdk.thread_view.prune({"filePath": file_path})
    assert receipt.ok is True
    if not receipt.ok:
        return
    assert receipt.value.no_op is False
    assert receipt.value.zone_tokens_after == 0

    results = await _tool_results(sdk, file_path)
    assert receipt.value.new_boundary == results[0].source_event_order

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return
    assert _abridged_count(context.value.messages) == 1


async def test_renders_the_tool_result_at_exactly_the_boundary_position_as_short() -> None:
    """renders the tool result at exactly the boundary position as short"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)
    sizes = [20, 21, 22, 23]
    await _intake(sdk, file_path, _tool_turn(sizes))

    receipt = await sdk.thread_view.prune({"filePath": file_path})
    assert receipt.ok is True
    if not receipt.ok:
        return

    results = await _tool_results(sdk, file_path)
    boundary_result = next(
        (r for r in results if r.source_event_order == receipt.value.new_boundary),
        None,
    )
    assert boundary_result is not None
    if boundary_result is None:
        return

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return

    boundary_index = next(
        (i for i, result in enumerate(results) if result.message_id == boundary_result.message_id),
        -1,
    )
    boundary_text = next(
        (
            text
            for text in (_message_text(m) for m in context.value.messages)
            if _tokens(sizes[boundary_index] if boundary_index >= 0 else 0) in text
        ),
        None,
    )
    assert boundary_text is not None
    assert " · abridged]" in (boundary_text or "")
