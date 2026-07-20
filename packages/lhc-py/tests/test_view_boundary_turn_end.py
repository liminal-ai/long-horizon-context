"""Ported from packages/lhc/test/view-boundary-turn-end.test.ts. Phase 1.

Visibility boundary: intake does not auto-advance the boundary at turn close.
"""

from __future__ import annotations

import pytest

from lhc import Lhc, init_lhc
from lhc.intake_stream import MessageEventInput
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    LlmRequestContextMessage,
    PartialVisibilityBudgets,
    SdkViewConfig,
)
from fixtures import (
    TempStore,
    TurnedToolResultsSpec,
    boundary_tool_run,
    create_inference_callbacks_double,
    open_raw,
    seed_turned_tool_results,
    temp_store,
    turned_tool_result_events,
    valid_event,
)

_BUDGETS = PartialVisibilityBudgets(max_tokens=100, target_tokens=60)

_stores: list[TempStore] = []


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


async def _boundary_of(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT position FROM view_boundary").get()
        assert row is not None
        return int(row["position"])  # type: ignore[arg-type]
    finally:
        db.close()


async def _zone_tokens_of(sdk: Lhc, file_path: str) -> int:
    status = await sdk.thread_view.status({"filePath": file_path})
    if not status.ok:
        raise RuntimeError(f"status failed: {status.error.reason}")
    return status.value.visibility.zone_tokens


def _message_text(message: LlmRequestContextMessage) -> str:
    return "".join(part.text for part in message.content)


def _abridged_count(messages: list[LlmRequestContextMessage]) -> int:
    return sum(
        1
        for m in messages
        if (text := _message_text(m)).startswith("[tool result · ") and " · abridged]" in text
    )


async def _intake_raw(sdk: Lhc, file_path: str, events: list[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, events)
    if not result.ok:
        raise RuntimeError(f"intake failed: {result.error.reason}")


async def test_keeps_the_boundary_at_zero_after_turn_close_even_when_the_zone_exceeds_max() -> None:
    """keeps the boundary at zero after turn close even when the zone exceeds max"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)

    await seed_turned_tool_results(sdk, file_path, [TurnedToolResultsSpec(results=(30, 30))])
    assert await _boundary_of(file_path) == 0

    await _intake_raw(
        sdk,
        file_path,
        turned_tool_result_events([TurnedToolResultsSpec(results=(40, 40), close=False)]),
    )
    await _intake_raw(sdk, file_path, boundary_tool_run(40))
    assert await _boundary_of(file_path) == 0
    assert await _zone_tokens_of(sdk, file_path) == 180

    context_read = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context_read.ok is True
    if not context_read.ok:
        return
    assert _abridged_count(context_read.value.messages) == 0

    await _intake_raw(sdk, file_path, [valid_event("turn_end")])
    assert await _boundary_of(file_path) == 0
    assert await _zone_tokens_of(sdk, file_path) == 180


async def test_does_not_advance_when_a_new_user_prompt_closes_the_previous_populated_turn() -> None:
    """does not advance when a new user prompt closes the previous populated turn"""
    sdk = _vis_sdk()
    file_path = await _new_thread(sdk)

    await seed_turned_tool_results(sdk, file_path, [TurnedToolResultsSpec(results=(30, 30))])
    await _intake_raw(
        sdk,
        file_path,
        turned_tool_result_events([TurnedToolResultsSpec(results=(40, 40), close=False)]),
    )

    closed_by_prompt = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [valid_event("user_prompt", {"payload": {"text": "next prompt closes the prior turn"}})],
    )
    assert closed_by_prompt.ok is True
    if not closed_by_prompt.ok:
        return
    assert [transition.action for transition in closed_by_prompt.value.turn_transitions] == [
        "closed",
        "opened",
    ]
    assert await _boundary_of(file_path) == 0
    assert await _zone_tokens_of(sdk, file_path) == 140
