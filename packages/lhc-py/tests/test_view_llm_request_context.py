"""Ported from packages/lhc/test/view-llm-request-context.test.ts. Phase 1.

Epic 03 Story 1: model context and status on the record.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict, is_dataclass
from typing import Any

import pytest
import pytest_asyncio

from lhc import Lhc, MessageEventInput, init_lhc
from lhc.shared_tech.scheduler import DrainOpts
from lhc.shared_tech.derivation import SdkConfig, ToolResultConfig
from lhc.shared_tech.view import (
    LlmRequestContextMessage,
    LlmRequestContextPart,
    SdkViewConfig,
    ViewStatusDerivation,
    ViewStatusVisibility,
)
from fixtures import (
    DerivedThreadFixture,
    TempStore,
    blocked_sibling_thread,
    create_inference_callbacks_double,
    derived_thread_fixture,
    open_raw,
    seed_view_boundary,
    temp_store,
    valid_event,
)


def _manual_sdk(view: SdkViewConfig | None = None) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode="manual",
            view=view,
        )
    )


async def _new_thread(sdk: Lhc, store: TempStore) -> str:
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")
    return file_path


async def _intake(
    sdk: Lhc,
    file_path: str,
    batch: list[MessageEventInput],
) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"intake failed: {result.error.reason}")


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _json_stringify(value: object) -> str:
    return json.dumps(_to_jsonable(value), separators=(",", ":"))


def _sha256(value: object) -> str:
    return hashlib.sha256(_json_stringify(value).encode("utf-8")).hexdigest()


def _text_part(text: str) -> list[LlmRequestContextPart]:
    return [LlmRequestContextPart(type="text", text=text)]


def _message_text(message: LlmRequestContextMessage | None) -> str | None:
    if message is None:
        return None
    return "".join(part.text for part in message.content)


def _work_item_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT COUNT(*) AS n FROM work_item").get()
        assert row is not None
        return int(row["n"])  # type: ignore[arg-type]
    finally:
        db.close()


def _state_snapshot(file_path: str) -> dict[str, object]:
    db = open_raw(file_path)
    try:
        work_rows = db.prepare(
            "SELECT work_item_id, status FROM work_item ORDER BY work_item_id"
        ).all()
        derivations = db.prepare(
            "SELECT subject_id, derivation_type, state FROM derivation ORDER BY subject_id, derivation_type"
        ).all()
        view_row = db.prepare("SELECT COUNT(*) AS n FROM thread_view").get()
        boundary_row = db.prepare("SELECT position FROM view_boundary").get()
        assert view_row is not None and boundary_row is not None
        return {
            "workItems": [
                {"id": row["work_item_id"], "status": row["status"]} for row in work_rows
            ],
            "derivations": [dict(row) for row in derivations],
            "viewRows": int(view_row["n"]),  # type: ignore[arg-type]
            "boundary": int(boundary_row["position"]),  # type: ignore[arg-type]
        }
    finally:
        db.close()


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def fixture_pair() -> tuple[TempStore, DerivedThreadFixture]:
    store = temp_store()
    try:
        fixture = await derived_thread_fixture(store)
        yield store, fixture
    finally:
        store.cleanup()


@pytest.fixture(scope="module")
def store(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> TempStore:
    return fixture_pair[0]


@pytest.fixture(scope="module")
def fixture(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> DerivedThreadFixture:
    return fixture_pair[1]


async def test_carries_threadid_and_both_intake_rounds_in_record_order(store: TempStore) -> None:
    """carries threadId and both intake rounds in record order"""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _intake(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first question"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
        ],
    )

    first = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert first.ok is True
    if not first.ok:
        return
    info = await sdk.threads.info({"filePath": file_path})
    assert info.ok is True
    if not info.ok:
        return
    assert first.value.thread_id == info.value.thread_id
    assert first.value.messages == [
        LlmRequestContextMessage(role="user", content=_text_part("first question")),
        LlmRequestContextMessage(role="assistant", content=_text_part("first answer")),
    ]

    await _intake(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "second question"}}),
            valid_event("assistant_text", {"payload": {"text": "second answer"}}),
            valid_event("turn_end"),
        ],
    )
    second = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert second.ok is True
    if not second.ok:
        return
    assert second.value.messages == [
        LlmRequestContextMessage(role="user", content=_text_part("first question")),
        LlmRequestContextMessage(role="assistant", content=_text_part("first answer")),
        LlmRequestContextMessage(role="user", content=_text_part("second question")),
        LlmRequestContextMessage(role="assistant", content=_text_part("second answer")),
    ]


async def test_hashes_identical_zero_work_rows_created_inference_callbacks_double_observes_zero_calls(
    fixture: DerivedThreadFixture,
) -> None:
    """hashes identical, zero work rows created, inference callbacks double observes zero calls"""
    captured = fixture.double.capture_inputs()
    before = _state_snapshot(fixture.file_path)
    work_rows_before = _work_item_count(fixture.file_path)

    one = await fixture.sdk.thread_view.get_llm_request_context({"filePath": fixture.file_path})
    two = await fixture.sdk.thread_view.get_llm_request_context({"filePath": fixture.file_path})
    assert (one.ok and two.ok) is True
    if not one.ok or not two.ok:
        return

    assert _sha256(one.value) == _sha256(two.value)
    assert _json_stringify(one.value) == _json_stringify(two.value)

    assert _work_item_count(fixture.file_path) == work_rows_before
    assert _state_snapshot(fixture.file_path) == before
    assert len(captured) == 0


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def tail_mapping_context() -> tuple[Lhc, str, list[LlmRequestContextMessage], TempStore]:
    store = temp_store()
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _intake(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "mapping prompt"}}),
            valid_event("assistant_thinking", {"payload": {"text": "mapping thought"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-map-1",
                        "toolName": "read_file",
                        "arguments": {"path": "map.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-map-1",
                        "content": "mapping output",
                        "isError": False,
                    },
                },
            ),
            valid_event("runtime_note", {"payload": {"text": "mapping note"}}),
            valid_event("assistant_text", {"payload": {"text": "mapping answer"}}),
            valid_event("turn_end"),
        ],
    )
    result = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"model context failed: {result.error.reason}")
    yield sdk, file_path, result.value.messages, store
    store.cleanup()


def test_user_prompt_user_role_text_verbatim(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """user_prompt: user role, text verbatim"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[0] == LlmRequestContextMessage(
        role="user", content=_text_part("mapping prompt")
    )


def test_assistant_thinking_assistant_role_fenced_thinking_block(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """assistant_thinking: assistant role, fenced [thinking] block"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[1] == LlmRequestContextMessage(
        role="assistant",
        content=_text_part("[thinking]\nmapping thought\n[/thinking]"),
    )


def test_tool_call_assistant_role_name_marker_plus_deterministic_arg_rendering(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """tool_call: assistant role, name marker plus deterministic arg rendering"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[2] == LlmRequestContextMessage(
        role="assistant",
        content=_text_part('[tool call · read_file] {"path":"map.txt"}'),
    )


def test_tool_result_ahead_of_the_boundary_user_role_name_marker_plus_full_content(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """tool_result ahead of the boundary: user role, name marker plus full content"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[3] == LlmRequestContextMessage(
        role="user",
        content=_text_part("[tool result · read_file]\nmapping output"),
    )


def test_runtime_note_user_role_runtime_note_marker_plus_text(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """runtime_note: user role, [runtime note] marker plus text"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[4] == LlmRequestContextMessage(
        role="user", content=_text_part("[runtime note] mapping note")
    )


def test_assistant_text_assistant_role_text_verbatim(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """assistant_text: assistant role, text verbatim"""
    _, _, context_messages, _ = tail_mapping_context
    assert context_messages[5] == LlmRequestContextMessage(
        role="assistant", content=_text_part("mapping answer")
    )


async def test_tool_result_at_or_behind_the_boundary_abridged_marker_plus_short_form_boundary_seeded_below_sdk(
    tail_mapping_context: tuple[Lhc, str, list[LlmRequestContextMessage], TempStore],
) -> None:
    """tool_result at-or-behind the boundary: abridged marker plus short form (boundary seeded below-SDK)"""
    sdk, file_path, _, _ = tail_mapping_context
    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    result = next((m for m in listed.value if m.kind == "tool_result"), None)
    assert result is not None
    seed_view_boundary(file_path, result.source_event_order)

    refreshed_context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert refreshed_context.ok is True
    if not refreshed_context.ok:
        return
    short = refreshed_context.value.messages[3]
    assert short == LlmRequestContextMessage(
        role="user",
        content=_text_part("[tool result · read_file · abridged]\nmapping output"),
    )


@pytest.mark.skip(reason="skipped in TS source (it.skip)")
async def test_renders_deterministic_tool_result_floors_behind_the_boundary_and_full_content_ahead_of_it(
    store: TempStore,
) -> None:
    """renders deterministic tool-result floors behind the boundary and full content ahead of it"""
    sdk = init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode="manual",
            tool_result=ToolResultConfig(
                small_tier_tokens=1, small_target_ratio=0.15, mid_target_ratio=0.04
            ),
        )
    )
    file_path = await _new_thread(sdk, store)
    for turn in [1, 2]:
        await _intake(
            sdk,
            file_path,
            [
                valid_event("user_prompt", {"payload": {"text": f"boundary prompt {turn}"}}),
                valid_event("assistant_thinking", {"payload": {"text": f"boundary thought {turn}"}}),
                valid_event(
                    "tool_call",
                    {
                        "payload": {
                            "toolCallId": f"call-bd-{turn}",
                            "toolName": "read_file",
                            "arguments": {"path": f"bd-{turn}.txt"},
                        },
                    },
                ),
                valid_event(
                    "tool_result",
                    {
                        "payload": {
                            "toolCallId": f"call-bd-{turn}",
                            "content": f"boundary output {turn}",
                            "isError": False,
                        },
                    },
                ),
                valid_event("assistant_text", {"payload": {"text": f"boundary answer {turn}"}}),
                valid_event("turn_end"),
            ],
        )
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    results = [m for m in listed.value if m.kind == "tool_result"]
    assert len(results) == 2
    behind, ahead = results[0], results[1]
    behind_summary = next(
        (
            d
            for d in (behind.derivations or [])
            if d.derivation_type == "tool_result_summary" and d.state == "ready"
        ),
        None,
    )
    assert behind_summary is not None and behind_summary.content is not None

    seed_view_boundary(file_path, behind.source_event_order)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return
    contents = [_message_text(m) for m in context.value.messages]

    assert "[tool result · read_file · abridged]\nboundary output 1" in contents
    assert f"[tool result · read_file · abridged]\n{behind_summary.content}" not in contents
    assert "[tool result · read_file]\nboundary output 2" in contents
    for turn in [1, 2]:
        assert f"boundary prompt {turn}" in contents
        assert f"[thinking]\nboundary thought {turn}\n[/thinking]" in contents
        assert f"boundary answer {turn}" in contents


async def test_falls_to_deterministic_truncation_when_no_summary_is_ready_and_the_content_is_oversized(
    store: TempStore,
) -> None:
    """falls to deterministic truncation when no summary is ready and the content is oversized"""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    long_content = "x" * 560
    await _intake(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "truncation prompt"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-tr-1",
                        "toolName": "read_file",
                        "arguments": {"path": "tr.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-tr-1",
                        "content": long_content,
                        "isError": False,
                    },
                },
            ),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    result = next((m for m in listed.value if m.kind == "tool_result"), None)
    if result is None:
        return
    seed_view_boundary(file_path, result.source_event_order)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return
    short = next(
        (m for m in context.value.messages if (_message_text(m) or "").startswith("[tool result")),
        None,
    )
    assert _message_text(short) == (
        f"[tool result · read_file · abridged]\n{'x' * 500}… [truncated 60 chars]"
    )


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def heavy_fixture_pair() -> tuple[TempStore, DerivedThreadFixture, Lhc]:
    heavy_store = temp_store()
    try:
        heavy = await derived_thread_fixture(heavy_store)
        status_sdk = _manual_sdk(SdkViewConfig(compact_threshold=100))
        yield heavy_store, heavy, status_sdk
    finally:
        heavy_store.cleanup()


async def test_reports_tail_tokens_vs_threshold_recommendation_derivation_counts_null_view_health_and_the_zone_sum_reads_only(
    heavy_fixture_pair: tuple[TempStore, DerivedThreadFixture, Lhc],
) -> None:
    """reports tail tokens vs threshold, recommendation, derivation counts, null view health, and the zone sum — reads only"""
    _, heavy, status_sdk = heavy_fixture_pair
    captured = heavy.double.capture_inputs()
    before = _state_snapshot(heavy.file_path)

    status = await status_sdk.thread_view.status({"filePath": heavy.file_path})
    assert status.ok is True
    if not status.ok:
        return

    assert status.value.threshold == 100
    assert status.value.tail_tokens > 100
    assert status.value.compact_recommended is True
    assert status.value.derivation == ViewStatusDerivation(pending=0, failed=2, blocked=0)
    assert status.value.view is None

    listed = await status_sdk.messages.list({"filePath": heavy.file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    expected_zone = sum(
        m.token_estimate for m in listed.value if m.kind == "tool_result"
    )
    assert status.value.visibility == ViewStatusVisibility(
        boundary_position=0, zone_tokens=expected_zone, max_tokens=64000
    )

    assert _state_snapshot(heavy.file_path) == before
    assert len(captured) == 0


async def test_counts_blocked_derivations_through_the_owners_report_sacrificial_sibling(
    heavy_fixture_pair: tuple[TempStore, DerivedThreadFixture, Lhc],
) -> None:
    """counts blocked derivations through the owner's report (sacrificial sibling)"""
    heavy_store, _, _ = heavy_fixture_pair
    sibling = await blocked_sibling_thread(heavy_store)
    status = await sibling.sdk.thread_view.status({"filePath": sibling.file_path})
    assert status.ok is True
    if not status.ok:
        return
    assert status.value.derivation.blocked == 2
    assert status.value.view is None


async def test_after_more_intake_the_tail_grew_still_no_compact_without_invocation(
    heavy_fixture_pair: tuple[TempStore, DerivedThreadFixture, Lhc],
) -> None:
    """after more intake the tail grew; still no compact without invocation"""
    _, heavy, status_sdk = heavy_fixture_pair
    first = await status_sdk.thread_view.status({"filePath": heavy.file_path})
    assert first.ok is True
    if not first.ok:
        return

    await _intake(
        heavy.sdk,
        heavy.file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "one more question for the heavy thread"}}),
            valid_event("assistant_text", {"payload": {"text": "one more answer for the heavy thread"}}),
            valid_event("turn_end"),
        ],
    )

    second = await status_sdk.thread_view.status({"filePath": heavy.file_path})
    assert second.ok is True
    if not second.ok:
        return
    assert second.value.tail_tokens > first.value.tail_tokens
    assert second.value.view is None
    assert _state_snapshot(heavy.file_path)["viewRows"] == 0


async def test_schedules_no_catch_up_drain_work_rows_derivation_states_inference_callback_count_and_status_all_unchanged_repeated_model_context_reads_byte_identical(
    store: TempStore,
) -> None:
    """schedules no catch-up drain: work rows, derivation states, inference callback count, and status all unchanged; repeated model-context reads byte-identical"""
    seeder = _manual_sdk()
    file_path = await _new_thread(seeder, store)
    await _intake(
        seeder,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "background prompt"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-bg-1",
                        "toolName": "read_file",
                        "arguments": {"path": "bg.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-bg-1",
                        "content": "background output",
                        "isError": False,
                    },
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "background answer"}}),
            valid_event("turn_end"),
        ],
    )
    assert _work_item_count(file_path) > 0

    bg_double = create_inference_callbacks_double()
    bg = init_lhc(
        SdkConfig(
            inference_callbacks=bg_double,
            mode="background",
            view=SdkViewConfig(compact_threshold=100),
        )
    )
    captured = bg_double.capture_inputs()
    before = _state_snapshot(file_path)

    one = await bg.thread_view.get_llm_request_context({"filePath": file_path})
    first_status = await bg.thread_view.status({"filePath": file_path})
    two = await bg.thread_view.get_llm_request_context({"filePath": file_path})
    assert (one.ok and two.ok and first_status.ok) is True
    if not one.ok or not two.ok or not first_status.ok:
        return

    assert first_status.value.derivation.pending > 0

    await asyncio.sleep(0.025)
    await bg.drain_settled({"filePath": file_path})

    assert _sha256(one.value) == _sha256(two.value)
    assert _json_stringify(one.value) == _json_stringify(two.value)

    assert _state_snapshot(file_path) == before
    assert len(captured) == 0

    second_status = await bg.thread_view.status({"filePath": file_path})
    assert second_status.ok is True
    if not second_status.ok:
        return
    assert _json_stringify(second_status.value) == _json_stringify(first_status.value)
