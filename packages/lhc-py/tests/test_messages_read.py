"""Ported from packages/lhc/test/messages-read.test.ts. Phase 1.

Story 1 (Epic 04), default suite: TC-3.1–3.3 — the message read surface.
Bounded listing in source-event-order coordinates (DD-3), show returning
the canonical record (full blocks, never view-shortened) composed with the
owner report's form entries (DD-2), and the deleted-audit contract
(excluded by default, listable flagged on request, show never not-found).
Plus the architecture-risk legs: every read leaves observable state
unchanged (read-only delta, DD-6) and calls no model.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest

from lhc import init_lhc, intake_stream, messages, thread_view
from lhc.messages import MessageListOptions, MessageReportOpts, RemoveInput
from lhc.sdk import Lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.work_queue import WorkOwner, list_items
from lhc.threads import NewThreadInput
from fixtures import (
    InferenceCallbacksDouble,
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    poison_message_block_json,
    poison_message_form_json,
    read_derived_forms,
    temp_store,
    valid_event,
)

# Long enough that any view-form shortening would be visible: show must
# return this verbatim (AC-3.2's record-not-view contract).
TOOL_RESULT_CONTENT = "\n".join(
    [
        "contents of notes.txt — full record content:",
        "line 1: the quick brown fox jumps over the lazy dog",
        "line 2: detailed tool output that a boundary-shortened form would drop",
        "line 3: trailing detail proving the record came back complete",
    ]
)


@dataclass(frozen=True, slots=True)
class ReadFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


# Two closed turns through real intake, fully drained against the
# deterministic double so m1's smoothing and m3/m4's tool summaries sit
# ready with mechanically stamped outcome metadata. Messages: m1 prompt,
# m2 text, m3 call, m4 result (turn 1; turn_end is event 5, no message);
# m6 prompt, m7 text (turn 2). Source event orders 1,2,3,4,6,7.
async def _read_fixture(store: TempStore) -> ReadFixture:
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    batches = [
        [
            valid_event("user_prompt", {"payload": {"text": "please read notes.txt"}}),
            valid_event("assistant_text", {"payload": {"text": "reading it now"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-read-1",
                        "toolName": "read_file",
                        "arguments": {"path": "notes.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-read-1",
                        "content": TOOL_RESULT_CONTENT,
                        "isError": False,
                    }
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
    if not drained.ok:
        raise RuntimeError(f"fixture drain failed: {drained.error.reason}")
    if drained.value.remaining != 0:
        raise RuntimeError(f"fixture drain left {drained.value.remaining} items behind")
    return ReadFixture(file_path=file_path, sdk=sdk, double=double)


def _ids_of(result: OpResult[Any]) -> list[str]:
    if not result.ok:
        raise RuntimeError("expected an ok list result")
    return [record.message_id for record in result.value]


def _queued_for(file_path: str, owner: WorkOwner):
    db = open_raw(file_path)
    try:
        return list_items(db, owner)
    finally:
        db.close()


# The DD-6 observable-state snapshot: queued work through both owners, view
# boundary/zone through status, derived-form rows, and the event log. A read
# that mutates any of these fails the before/after deep-equal.
async def _observable_state(file_path: str) -> dict[str, object]:
    return {
        "events": await intake_stream.list_events({"filePath": file_path}),
        "messageWork": _queued_for(file_path, "messages"),
        "turnWork": _queued_for(file_path, "turns"),
        "viewStatus": await thread_view.status({"filePath": file_path}),
        "derivations": read_derived_forms(file_path),
    }


# A thread with live, undrained work: one tool turn through a manual SDK
# (its no-op seam never drains), leaving three pending forms and their queue
# rows. The background read-only proof needs the pending state the manual
# read-only proof above cannot manufacture.
async def _pending_work_thread(store: TempStore) -> str:
    seeder = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual")
    )
    file_path = store.thread_path()
    created = await seeder.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"pending fixture thread creation failed: {created.error.reason}")
    sent = await seeder.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "background prompt"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-bg-1",
                        "toolName": "read_file",
                        "arguments": {"path": "bg.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-bg-1",
                        "content": "background output",
                        "isError": False,
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "background answer"}}),
            valid_event("turn_end"),
        ],
    )
    if not sent.ok:
        raise RuntimeError(f"pending fixture intake failed: {sent.error.reason}")
    return file_path


# Below-SDK raw snapshot of everything a wrongly-scheduled catch-up drain
# would move: work-item rows and derived-form states. Read through a raw
# handle (openRaw), never the SDK ops — those would fire their own touch and
# pollute the very state under test.
def _raw_work_and_forms(file_path: str) -> dict[str, object]:
    db = open_raw(file_path)
    try:
        return {
            "workItems": db.prepare(
                "SELECT work_item_id, status FROM work_item ORDER BY work_item_id"
            ).all(),
            "derivations": db.prepare(
                """SELECT subject_id, derivation_type, state, source_version FROM derivation
           ORDER BY subject_id, derivation_type"""
            ).all(),
        }
    finally:
        db.close()


async def test_returns_messages_in_record_order_with_kind_token_estimate_and_turn_membership(
    store: TempStore,
) -> None:
    """returns messages in record order with kind, token estimate, and turn membership"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    assert [m.message_id for m in listed.value] == ["m1", "m2", "m3", "m4", "m6", "m7"]
    assert [m.source_event_order for m in listed.value] == [1, 2, 3, 4, 6, 7]
    assert [m.kind for m in listed.value] == [
        "user_prompt",
        "assistant_text",
        "tool_call",
        "tool_result",
        "user_prompt",
        "assistant_text",
    ]
    assert [m.turn_id for m in listed.value] == ["t1", "t1", "t1", "t1", "t2", "t2"]
    for record in listed.value:
        assert record.token_estimate > 0
        assert record.deleted is None


async def test_honors_from_to_limit_windows_exactly_in_source_event_order_coordinates(
    store: TempStore,
) -> None:
    """honors from/to/limit windows exactly in source-event-order coordinates"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    windows: list[tuple[MessageListOptions, list[str]]] = [
        ({"from": 2, "to": 4}, ["m2", "m3", "m4"]),
        ({"from": 6}, ["m6", "m7"]),
        ({"to": 2}, ["m1", "m2"]),
        ({"limit": 3}, ["m1", "m2", "m3"]),
        ({"from": 2, "limit": 2}, ["m2", "m3"]),
        ({"from": 4, "to": 4}, ["m4"]),
        ({"from": 5, "to": 5}, []),  # the turn_end order: an event, never a message
    ]
    for opts, expected in windows:
        assert _ids_of(await messages.list({"filePath": file_path}, opts)) == expected


async def test_refuses_bad_bounds_as_caller_errors_and_returns_no_partial_window(
    store: TempStore,
) -> None:
    """refuses bad bounds as caller errors and returns no partial window"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    bad_bounds: list[MessageListOptions] = [
        {"from": 5, "to": 2},
        {"limit": 0},
        {"limit": -1},
        {"from": 1.5},  # type: ignore[typeddict-item]
    ]
    for opts in bad_bounds:
        refused = await messages.list({"filePath": file_path}, opts)
        assert refused.ok is False
        if refused.ok:
            continue
        assert refused.error.error_class == "caller_error"
        assert refused.error.code == "invalid_bounds"


async def test_a_drained_tool_result_message_comes_back_with_full_content_form_states_and_outcome_metadata(
    store: TempStore,
) -> None:
    """a drained tool-result message comes back with full content, form states, and outcome metadata"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    shown = await messages.show({"filePath": file_path}, "m4")
    assert shown.ok is True
    if not shown.ok:
        return
    detail = shown.value
    assert detail.message_id == "m4"
    assert detail.kind == "tool_result"
    assert detail.turn_id == "t1"
    assert detail.deleted is False
    assert detail.token_estimate > 0
    # The record, not the view: the complete original tool result verbatim.
    assert len(detail.blocks) == 1
    assert detail.blocks[0].block_type == "tool_result"
    assert detail.blocks[0].content["content"] == TOOL_RESULT_CONTENT
    assert detail.blocks[0].content["toolCallId"] == "call-read-1"
    # Forms with states and tool-outcome metadata, joined from the owner.
    assert len(detail.derivations) == 1
    summary = detail.derivations[0]
    assert summary.derivation_type == "tool_result_summary"
    assert summary.state == "ready"
    assert summary.content is not None
    assert summary.metadata is not None
    assert summary.metadata.outcome == "succeeded"
    # Anti-shim: the forms ARE the owner report's entries for this message,
    # never a synthesized join (DD-2).
    report = await messages.report({"filePath": file_path}, MessageReportOpts(message_id="m4"))
    assert report.ok is True
    if not report.ok:
        return
    assert detail.derivations == report.value


async def test_a_drained_prompt_shows_its_smoothing_form_alongside_the_full_record(
    store: TempStore,
) -> None:
    """a drained prompt shows its smoothing form alongside the full record"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    shown = await messages.show({"filePath": file_path}, "m1")
    assert shown.ok is True
    if not shown.ok:
        return
    assert shown.value.blocks[0].content["text"] == "please read notes.txt"
    assert [(form.derivation_type, form.state) for form in shown.value.derivations] == [
        ("smoothed_prompt", "ready")
    ]


async def test_default_list_excludes_a_deleted_message_include_deleted_lists_it_marked_show_returns_it_flagged(
    store: TempStore,
) -> None:
    """default list excludes a deleted message; include-deleted lists it marked; show returns it flagged"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    deleted = await messages.remove({"filePath": file_path}, RemoveInput(message_id="m2"))
    assert deleted.ok is True

    default_list = await messages.list({"filePath": file_path})
    assert _ids_of(default_list) == ["m1", "m3", "m4", "m6", "m7"]

    audited = await messages.list({"filePath": file_path}, {"includeDeleted": True})
    assert audited.ok is True
    if not audited.ok:
        return
    assert [m.message_id for m in audited.value] == ["m1", "m2", "m3", "m4", "m6", "m7"]
    for record in audited.value:
        if record.message_id == "m2":
            assert record.deleted is True
        else:
            assert record.deleted is None

    # Show on the deleted message is the audit read: the record, flagged —
    # never a not-found.
    shown = await messages.show({"filePath": file_path}, "m2")
    assert shown.ok is True
    if not shown.ok:
        return
    assert shown.value.deleted is True
    assert shown.value.blocks[0].content["text"] == "reading it now"


async def test_show_on_a_missing_id_is_message_not_found(store: TempStore) -> None:
    """show on a missing id is message_not_found"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    missing = await messages.show({"filePath": file_path}, "m99")
    assert missing.ok is False
    if missing.ok:
        return
    assert missing.error.error_class == "caller_error"
    assert missing.error.code == "message_not_found"


async def test_list_and_show_in_every_mode_leave_observable_state_unchanged_and_call_no_model(
    store: TempStore,
) -> None:
    """list and show in every mode leave observable state unchanged and call no model"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    double = fixture.double
    captured = double.capture_inputs()
    before = await _observable_state(file_path)

    await messages.list({"filePath": file_path})
    await messages.list({"filePath": file_path}, {"from": 2, "to": 4, "limit": 2})
    await messages.list({"filePath": file_path}, {"includeDeleted": True})
    await messages.list({"filePath": file_path}, {"from": 9, "to": 1})  # refused, must not write either
    await messages.show({"filePath": file_path}, "m4")
    await messages.show({"filePath": file_path}, "m99")  # not-found, must not write either

    after = await _observable_state(file_path)
    assert after == before
    assert len(captured) == 0


async def test_list_and_show_through_a_background_sdk_with_pending_work_call_no_model_and_advance_no_form(
    store: TempStore,
) -> None:
    """list and show through a background SDK with pending work call no model and advance no form"""
    file_path = await _pending_work_thread(store)

    # A fresh background SDK whose scheduler WOULD hang a first-touch catch-up
    # drain — and the model call that drain makes — off the open
    # announcement (openThreadDatabase → fireThreadTouch → scheduler.touch) if
    # list or show fired it. The touch-suppressed read scope is what stops it;
    # this is the production-path proof a manual-mode no-op seam cannot give.
    bg_double = create_inference_callbacks_double()
    bg = init_lhc(SdkConfig(inference_callbacks=bg_double, mode="background"))
    captured = bg_double.capture_inputs()
    before = _raw_work_and_forms(file_path)

    listed = await bg.messages.list({"filePath": file_path})
    await bg.messages.list({"filePath": file_path}, {"limit": 1})
    shown = await bg.messages.show({"filePath": file_path}, "m1")
    assert listed.ok and shown.ok
    if not listed.ok or not shown.ok:
        return

    # The reads ran against the live, undrained queue — the records carry
    # their pending forms — so this is no vacuous pass on an empty thread.
    listed_forms = [form for m in listed.value for form in (m.derivations or [])]
    assert len(listed_forms) > 0
    assert all(form.state == "pending" for form in listed_forms)
    assert [form.state for form in shown.value.derivations] == ["pending"]

    # Give any wrongly-scheduled catch-up drain room to surface, then wait the
    # scheduler out before asserting nothing moved underneath the reads.
    await asyncio.sleep(0.025)
    await bg.drain_settled({"filePath": file_path})

    # Reads only: every work-item and form row is exactly as before, and the
    # background inference callbacks observed zero calls — no first-touch drain fired.
    assert _raw_work_and_forms(file_path) == before
    assert len(captured) == 0


async def test_a_bounded_list_excluding_out_of_window_rows_never_loads_their_blocks_or_forms(
    store: TempStore,
) -> None:
    """a bounded list excluding out-of-window rows never loads their blocks or forms"""
    fixture = await _read_fixture(store)
    file_path = fixture.file_path
    # Corrupt content the bounds must exclude: m7's block (an out-of-window
    # message) and m4's tool-result-summary metadata (an out-of-window form).
    # Any read that loads either row throws on JSON.parse, so a bounded list
    # that still succeeds proves it never read outside its window.
    poison_message_block_json(file_path, "m7")
    poison_message_form_json(file_path, "m4")

    # In-window reads succeed and return exactly the window — the poisoned
    # rows are sourced neither as blocks nor as forms.
    for opts in ({"to": 1}, {"limit": 1}):
        bounded = await messages.list({"filePath": file_path}, opts)
        assert bounded.ok is True
        if not bounded.ok:
            return
        assert [m.message_id for m in bounded.value] == ["m1"]
        assert bounded.value[0].blocks[0].content["text"] == "please read notes.txt"

    # Positive controls: a window that *includes* a poisoned row does load it
    # and fails on parse — proof the pills are real, so the passes above are
    # genuine no-loads, not silently-dropped output.
    hits_block = await messages.list({"filePath": file_path}, {"from": 7})
    assert hits_block.ok is False
    hits_form = await messages.list({"filePath": file_path}, {"from": 4, "to": 4})
    assert hits_form.ok is False
