"""Ported from packages/lhc/test/inspect-overview.test.ts. Phase 1.

Story 2 (Epic 04), default suite: TC-1.1–1.3 — the inspect overview.
One read-only call composing thread identity, event/message/turn/chunk
counts, derivation states, view summary, and visibility from the other
domains' surfaces. Every thread shape returns the FULL shape with absent
pieces as zeros/nulls (AC-1.3); counts honor the deleted contract
(AC-1.2); the read is pure (AC-1.4) — asserted as absence of delta and
zero model calls, including under a throwing inference callback.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any, Never

import pytest

from lhc import Lhc, MessageEventInput, init_lhc
from lhc.messages import RemoveInput
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inspect import (
    InspectOverview,
    InspectOverviewChunks,
    InspectOverviewDerivation,
    InspectOverviewEvents,
    InspectOverviewEventsSpan,
    InspectOverviewMessages,
    InspectOverviewTurns,
    InspectOverviewVisibility,
)
from lhc.thread_view import CompactOpts
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    derived_thread_fixture,
    expect_read_only,
    mutation_in_flight_variant,
    open_raw,
    temp_store,
    valid_event,
)
from fixtures.inference_callbacks_double import InferenceCallbacksDouble


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


class _RefuseCallbacks:
    async def smooth_prompt(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_tool_result(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def compress_detailed_turn(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_chunk_brief(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")


def _throwing_provider() -> _RefuseCallbacks:
    return _RefuseCallbacks()


@dataclass(frozen=True, slots=True)
class _SmallThread:
    file_path: str
    thread_id: str
    sdk: Lhc
    double: InferenceCallbacksDouble


async def _two_turn_thread(store: TempStore) -> _SmallThread:
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(
            file_path=file_path,
            registry_path=store.registry_path,
            title="overview fixture",
        )
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    batches: list[list[MessageEventInput]] = [
        [
            valid_event("user_prompt", {"payload": {"text": "please read notes.txt"}}),
            valid_event("assistant_text", {"payload": {"text": "reading it now"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-ov-1",
                        "toolName": "read_file",
                        "arguments": {"path": "notes.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-ov-1",
                        "content": "contents of notes.txt",
                        "isError": False,
                    },
                },
            ),
            valid_event("turn_end"),
        ],
        [
            valid_event("user_prompt", {"payload": {"text": "summarize what you read"}}),
            valid_event("assistant_text", {"payload": {"text": "here is the summary"}}),
            valid_event("turn_end"),
        ],
    ]
    for batch in batches:
        sent = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
        if not sent.ok:
            raise RuntimeError(f"fixture batch failed: {sent.error.reason}")
    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok or drained.value.remaining != 0:
        raise RuntimeError("fixture drain left work behind")
    return _SmallThread(
        file_path=file_path,
        thread_id=created.value.thread_id,
        sdk=sdk,
        double=double,
    )


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _overview_value(result: OpResult[InspectOverview]) -> InspectOverview:
    if not result.ok:
        raise RuntimeError(
            f"expected ok overview: {json.dumps(_to_jsonable(result), separators=(',', ':'))}"
        )
    return result.value


_ZERO_DERIVATION = InspectOverviewDerivation(ready=0, pending=0, failed=0, blocked=0)


async def test_fresh_empty_full_shape_with_zeros_and_nulls_never_omitted_fields(
    store: TempStore,
) -> None:
    """fresh-empty: full shape with zeros and nulls, never omitted fields"""
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    assert created.ok is True
    if not created.ok:
        return

    overview = _overview_value(await sdk.inspect.overview({"filePath": file_path}))
    assert overview.thread.id == created.value.thread_id
    assert isinstance(overview.thread.created_at, str)
    assert overview.events == InspectOverviewEvents(count=0, span=None)
    assert overview.messages == InspectOverviewMessages(
        visible=0, by_kind={}, deleted=0, visible_tokens=0
    )
    assert overview.turns == InspectOverviewTurns(open=1, closed=0)
    assert overview.chunks == InspectOverviewChunks(count=0, unchunked_turns=0)
    assert overview.derivation == _ZERO_DERIVATION
    assert overview.view is None
    assert overview.visibility == InspectOverviewVisibility(boundary_position=0, zone_tokens=0)


async def test_mid_first_turn_open_turn_queued_derivation_no_view_full_shape(
    store: TempStore,
) -> None:
    """mid-first-turn: open turn, queued derivation, no view — full shape"""
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    assert created.ok is True
    sent = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "first prompt, turn still open"}}),
            valid_event("assistant_thinking", {"payload": {"text": "thinking about it"}}),
        ],
    )
    assert sent.ok is True

    overview = _overview_value(await sdk.inspect.overview({"filePath": file_path}))
    assert overview.events == InspectOverviewEvents(
        count=2, span=InspectOverviewEventsSpan(first=1, last=2)
    )
    assert overview.messages.visible == 2
    assert overview.messages.by_kind == {"user_prompt": 1, "assistant_thinking": 1}
    assert overview.messages.deleted == 0
    assert overview.messages.visible_tokens > 0
    assert overview.turns == InspectOverviewTurns(open=1, closed=0)
    assert overview.chunks == InspectOverviewChunks(count=0, unchunked_turns=0)
    assert overview.derivation == InspectOverviewDerivation(
        ready=0, pending=1, failed=0, blocked=0
    )
    assert overview.view is None
    assert overview.visibility.boundary_position == 0


async def test_never_compacted_with_record_real_counts_view_null(store: TempStore) -> None:
    """never-compacted-with-record: real counts, view null"""
    small = await _two_turn_thread(store)
    overview = _overview_value(await small.sdk.inspect.overview({"filePath": small.file_path}))
    assert overview.thread.id == small.thread_id
    assert overview.events == InspectOverviewEvents(
        count=8, span=InspectOverviewEventsSpan(first=1, last=8)
    )
    assert overview.messages.visible == 6
    assert overview.messages.by_kind == {
        "user_prompt": 2,
        "assistant_text": 2,
        "tool_call": 1,
        "tool_result": 1,
    }
    assert overview.messages.deleted == 0
    assert overview.turns == InspectOverviewTurns(open=1, closed=2)
    assert overview.chunks == InspectOverviewChunks(count=1, unchunked_turns=0)
    assert overview.derivation == InspectOverviewDerivation(
        ready=9, pending=0, failed=0, blocked=0
    )
    assert overview.view is None


async def test_compacted_tool_heavy_fixture_exact_counts_in_every_section(
    store: TempStore,
) -> None:
    """compacted tool-heavy fixture: exact counts in every section"""
    fixture = await derived_thread_fixture(store)
    file_path = fixture.file_path
    sdk = fixture.sdk
    compacted = await sdk.thread_view.compact({"filePath": file_path}, CompactOpts())
    assert compacted.ok is True
    if not compacted.ok:
        return

    overview = _overview_value(await sdk.inspect.overview({"filePath": file_path}))
    assert overview.events == InspectOverviewEvents(
        count=64, span=InspectOverviewEventsSpan(first=1, last=64)
    )
    assert overview.messages.visible == 52
    assert overview.messages.by_kind == {
        "user_prompt": 12,
        "assistant_thinking": 12,
        "assistant_text": 12,
        "tool_call": 8,
        "tool_result": 8,
    }
    assert overview.messages.deleted == 0
    assert overview.messages.visible_tokens > 0
    assert overview.turns == InspectOverviewTurns(open=1, closed=12)
    assert overview.chunks == InspectOverviewChunks(count=4, unchunked_turns=0)
    assert overview.derivation == InspectOverviewDerivation(
        ready=60, pending=0, failed=2, blocked=0
    )
    assert overview.view is not None
    assert overview.view.view_id == compacted.value.view_id
    assert isinstance(overview.view.created_at, str)
    assert overview.view.compact_point == compacted.value.compact_point
    assert overview.view.covered_from == compacted.value.covered_from

    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT position FROM view_boundary").get()
        assert row is not None
        boundary = int(row["position"])  # type: ignore[index]
    finally:
        db.close()
    status = await sdk.thread_view.status({"filePath": file_path})
    assert status.ok is True
    if not status.ok:
        return
    assert overview.visibility == InspectOverviewVisibility(
        boundary_position=boundary,
        zone_tokens=status.value.visibility.zone_tokens,
    )


async def test_mid_rebuild_cleared_cascade_pending_view_summary_intact_full_shape(
    store: TempStore,
) -> None:
    """mid-rebuild: cleared cascade pending, view summary intact — full shape"""
    fixture = await mutation_in_flight_variant(store)
    overview = _overview_value(
        await fixture.sdk.inspect.overview({"filePath": fixture.file_path})
    )
    assert len(fixture.mutation.cleared) == 6
    assert overview.derivation == InspectOverviewDerivation(
        ready=56, pending=6, failed=0, blocked=0
    )
    assert overview.turns == InspectOverviewTurns(open=1, closed=12)
    assert overview.chunks == InspectOverviewChunks(count=4, unchunked_turns=0)
    assert overview.view is not None
    assert overview.view.view_id == fixture.compact_receipt.view_id
    assert isinstance(overview.view.created_at, str)
    assert overview.view.compact_point == fixture.compact_receipt.compact_point
    assert overview.view.covered_from == fixture.compact_receipt.covered_from
    assert overview.events.count == 64
    assert overview.messages.visible == 52


async def test_deleting_one_message_drops_visible_kind_token_counts_raises_deleted_leaves_events_alone(
    store: TempStore,
) -> None:
    """deleting one message drops visible/kind/token counts, raises deleted, leaves events alone"""
    small = await _two_turn_thread(store)
    file_path = small.file_path
    sdk = small.sdk
    before = _overview_value(await sdk.inspect.overview({"filePath": file_path}))

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    target = next((record for record in listed.value if record.message_id == "m2"), None)
    assert target is not None
    assert target.kind == "assistant_text"

    deleted = await sdk.messages.remove({"filePath": file_path}, RemoveInput(message_id="m2"))
    assert deleted.ok is True

    after = _overview_value(await sdk.inspect.overview({"filePath": file_path}))
    assert after.messages.visible == before.messages.visible - 1
    assert after.messages.deleted == 1
    expected_by_kind = {**before.messages.by_kind}
    expected_by_kind["assistant_text"] = (
        0 if before.messages.by_kind.get("assistant_text") is None else before.messages.by_kind["assistant_text"]
    ) - 1
    assert after.messages.by_kind == expected_by_kind
    assert after.messages.visible_tokens == before.messages.visible_tokens - target.token_estimate
    assert after.events == before.events


async def test_repeated_calls_are_deep_equal_leave_no_delta_create_no_work_call_no_model(
    store: TempStore,
) -> None:
    """repeated calls are deep-equal, leave no delta, create no work, call no model"""
    fixture = await mutation_in_flight_variant(store)
    file_path = fixture.file_path
    sdk = fixture.sdk
    captured = fixture.double.capture_inputs()

    first = await expect_read_only(file_path, lambda: sdk.inspect.overview({"filePath": file_path}))
    second = await expect_read_only(file_path, lambda: sdk.inspect.overview({"filePath": file_path}))
    assert first.ok and second.ok
    assert second == first
    assert len(captured) == 0


async def test_overview_succeeds_under_a_throwing_inference_callback_and_wraps_story_1s_reads_in_the_delta_assert(
    store: TempStore,
) -> None:
    """overview succeeds under a throwing inference callback, and wraps Story 1's reads in the delta assert"""
    small = await _two_turn_thread(store)
    file_path = small.file_path
    reader = init_lhc(
        SdkConfig(inference_callbacks=_throwing_provider(), mode="manual")  # type: ignore[arg-type]
    )

    overview = await expect_read_only(
        file_path, lambda: reader.inspect.overview({"filePath": file_path})
    )
    assert overview.ok is True
    listed = await expect_read_only(
        file_path,
        lambda: reader.messages.list({"filePath": file_path}, {"includeDeleted": True}),
    )
    shown = await expect_read_only(
        file_path, lambda: reader.messages.show({"filePath": file_path}, "m1")
    )
    assert listed.ok and shown.ok


async def test_overview_on_a_missing_thread_is_thread_not_found_not_a_shape_error(
    store: TempStore,
) -> None:
    """overview on a missing thread is thread_not_found, not a shape error"""
    sdk = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual")
    )
    missing = await sdk.inspect.overview({"filePath": store.thread_path("missing")})
    assert missing.ok is False
    if missing.ok:
        return
    assert missing.error.error_class == "caller_error"
    assert missing.error.code == "thread_not_found"
