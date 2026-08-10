"""R4 retrieval domain parity — ported from packages/lhc/test/retrieval.test.ts
(pin 81cd48c) with R4 scope: validation, impressions, serve/compose, budget
scaffolding needed for impression classes. Full byte-budget goldens are R6.
"""

from __future__ import annotations

import sqlite3

import pytest

from lhc import (
    create_deterministic_inference_callbacks,
    estimate_tokens,
    init_lhc,
    intake_stream,
    retrieval,
)
from lhc.retrieval import RetrievalOptions
from lhc.shared_tech.thread_migrate import THREAD_SCHEMA_VERSION_6
from fixtures import TempStore, temp_store, valid_event


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


@pytest.fixture
def sdk():
    return init_lhc(
        {"mode": "manual", "inferenceCallbacks": create_deterministic_inference_callbacks()}
    )


@pytest.fixture
async def file_path(store: TempStore, sdk) -> str:
    path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return path


async def _send(file_path: str, events) -> None:
    result = await intake_stream.message_events({"filePath": file_path}, events)
    if not result.ok:
        raise RuntimeError(f"intake failed: {result.error.reason}")


async def _drain(sdk, file_path: str) -> None:
    result = await sdk.work.drain({"filePath": file_path})
    if not result.ok:
        raise RuntimeError(f"drain failed: {result.error.reason}")


async def _seed_two_turns(file_path: str) -> None:
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first question"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "read the file please"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-1",
                        "toolName": "read",
                        "arguments": {"path": "notes.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-1",
                        "content": "the file says hello",
                        "isError": False,
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "done reading"}}),
            valid_event("turn_end"),
        ],
    )


# ── get_turns ─────────────────────────────────────────────────────────


async def test_get_turns_serves_stored_tagged_renderings_in_request_order(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)

    result = await retrieval.get_turns({"filePath": file_path}, ["t2", "t1"])
    assert result.ok is True
    if not result.ok:
        return
    receipt = result.value
    assert [t.turn_id for t in receipt.served] == ["t2", "t1"]
    assert receipt.unserved == []
    t2 = receipt.served[0]
    assert t2.source == "stored"
    assert "<t2>" in t2.text
    assert "</t2>" in t2.text
    assert "read the file please" in t2.text
    assert any(f"<m{i}>" in t2.text for i in range(1, 20))
    assert receipt.total_tokens == sum(t.tokens for t in receipt.served)


async def test_get_turns_composes_live_fallback_when_rendering_not_ready(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    # No drain: turn_rendering rows are pending.
    result = await retrieval.get_turns({"filePath": file_path}, ["t1"])
    assert result.ok is True
    if not result.ok:
        return
    turn = result.value.served[0]
    assert turn.source == "composed"
    assert "<t1>" in turn.text
    assert "first question" in turn.text


async def test_get_turns_recomposes_legacy_unlabeled_ready_via_r3_helper(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    conn = sqlite3.connect(file_path)
    try:
        conn.execute(
            """UPDATE derivation SET content = 'legacy untagged rendering'
               WHERE subject_kind = 'turn' AND subject_id = 't1'
                 AND derivation_type = 'turn_rendering'"""
        )
        conn.commit()
    finally:
        conn.close()

    result = await retrieval.get_turns({"filePath": file_path}, ["t1"])
    assert result.ok is True
    if not result.ok:
        return
    turn = result.value.served[0]
    assert turn.source == "composed"
    assert "<t1>" in turn.text
    assert "<m1>" in turn.text
    assert "legacy untagged rendering" not in turn.text


async def test_get_turns_reports_not_found_without_charging_budget(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    result = await retrieval.get_turns({"filePath": file_path}, ["t99", "t1"])
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.unserved) == 1
    assert result.value.unserved[0].id == "t99"
    assert result.value.unserved[0].reason == "not_found"
    assert [t.turn_id for t in result.value.served] == ["t1"]


async def test_get_turns_reports_budget_when_too_little_remains(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    full = await retrieval.get_turns({"filePath": file_path}, ["t1", "t2"])
    assert full.ok is True
    if not full.ok:
        return
    t2_tokens = full.value.served[1].tokens

    partial = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1", "t2"],
        RetrievalOptions(token_budget=t2_tokens),
    )
    assert partial.ok is True
    if not partial.ok:
        return
    assert [t.turn_id for t in partial.value.served] == ["t1"]
    assert partial.value.served[0].slice is None
    assert len(partial.value.unserved) == 1
    blocked = partial.value.unserved[0]
    assert blocked.id == "t2"
    assert blocked.reason == "budget"
    assert blocked.tokens is not None and blocked.tokens > 0


async def test_get_turns_collapses_duplicate_ids_first_occurrence_wins(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    result = await retrieval.get_turns({"filePath": file_path}, ["t1", "t1"])
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 1
    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    assert len(impressions.value) == 1
    assert impressions.value[0].entity_id == "t1"
    assert impressions.value[0].request_idx == 0
    assert impressions.value[0].served is True
    assert impressions.value[0].call_id == result.value.call_id


async def test_get_turns_rejects_empty_id_list_and_non_positive_budget(
    sdk, file_path: str
) -> None:
    empty = await retrieval.get_turns({"filePath": file_path}, [])
    assert empty.ok is False
    bad = await retrieval.get_turns(
        {"filePath": file_path}, ["t1"], RetrievalOptions(token_budget=0)
    )
    assert bad.ok is False


async def test_get_turns_rejects_negative_or_fractional_from_token(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    negative = await retrieval.get_turns(
        {"filePath": file_path}, ["t1"], RetrievalOptions(from_token=-1)
    )
    assert negative.ok is False
    fractional = await retrieval.get_turns(
        {"filePath": file_path}, ["t1"], RetrievalOptions(from_token=1.5)
    )
    assert fractional.ok is False


# ── get_messages ──────────────────────────────────────────────────────


async def test_get_messages_serves_verbatim_text_tool_calls_and_results(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return

    def first_of(kind: str):
        return next(r for r in listed.value if r.kind == kind)

    prompt_id = first_of("user_prompt").message_id
    call_id = first_of("tool_call").message_id
    result_id = first_of("tool_result").message_id

    result = await retrieval.get_messages(
        {"filePath": file_path}, [prompt_id, call_id, result_id]
    )
    assert result.ok is True
    if not result.ok:
        return
    prompt, call, tool_result = result.value.served
    assert prompt.text == "first question"
    assert prompt.kind == "user_prompt"
    assert prompt.turn_id == "t1"
    assert "[tool_call read call-1]" in call.text
    assert '"path": "notes.txt"' in call.text
    assert "[tool_result call-1]" in tool_result.text
    assert "the file says hello" in tool_result.text


async def test_get_messages_reports_unknown_as_not_found(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    result = await retrieval.get_messages({"filePath": file_path}, ["m999"])
    assert result.ok is True
    if not result.ok:
        return
    assert result.value.served == []
    assert len(result.value.unserved) == 1
    assert result.value.unserved[0].id == "m999"
    assert result.value.unserved[0].reason == "not_found"


async def test_get_messages_enforces_token_budget_in_order(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    prompts = [r.message_id for r in listed.value if r.kind == "user_prompt"]
    budget = estimate_tokens("read the file please")

    result = await retrieval.get_messages(
        {"filePath": file_path}, prompts, RetrievalOptions(token_budget=budget)
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 1
    assert result.value.unserved[0].reason == "budget"


async def test_get_messages_reports_deleted(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    prompt_id = next(r.message_id for r in listed.value if r.kind == "user_prompt")
    conn = sqlite3.connect(file_path)
    try:
        conn.execute(
            "UPDATE message SET deleted_at = ? WHERE message_id = ?",
            ("2026-08-08T00:00:00.000Z", prompt_id),
        )
        conn.commit()
    finally:
        conn.close()

    result = await retrieval.get_messages({"filePath": file_path}, [prompt_id])
    assert result.ok is True
    if not result.ok:
        return
    assert result.value.served == []
    assert len(result.value.unserved) == 1
    assert result.value.unserved[0].reason == "deleted"
    assert result.value.unserved[0].id == prompt_id


# ── impression log ────────────────────────────────────────────────────


async def test_impression_log_one_row_per_requested_id_with_call_correlation(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    first = await retrieval.get_turns({"filePath": file_path}, ["t1", "t99"])
    assert first.ok is True
    if not first.ok:
        return

    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    prompt_id = next(r.message_id for r in listed.value if r.kind == "user_prompt")
    second = await retrieval.get_messages(
        {"filePath": file_path},
        [prompt_id],
        RetrievalOptions(surface="board"),
    )
    assert second.ok is True
    if not second.ok:
        return

    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    assert len(impressions.value) == 3

    served_turn, missing_turn, served_message = impressions.value
    assert served_turn.call_id == first.value.call_id
    assert served_turn.surface == "get_turns"
    assert served_turn.entity_kind == "turn"
    assert served_turn.entity_id == "t1"
    assert served_turn.request_idx == 0
    assert served_turn.served is True
    assert served_turn.tokens is not None and served_turn.tokens > 0

    assert missing_turn.entity_id == "t99"
    assert missing_turn.served is False
    assert missing_turn.reason == "not_found"

    assert served_message.call_id == second.value.call_id
    assert served_message.surface == "board"
    assert served_message.entity_kind == "message"
    assert served_message.entity_id == prompt_id
    assert served_message.served is True


async def test_impression_log_persists_deleted_and_budget_outcomes(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)

    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    prompt_id = next(r.message_id for r in listed.value if r.kind == "user_prompt")
    conn = sqlite3.connect(file_path)
    try:
        conn.execute(
            "UPDATE message SET deleted_at = ? WHERE message_id = ?",
            ("2026-08-08T00:00:00.000Z", prompt_id),
        )
        conn.commit()
    finally:
        conn.close()

    deleted_call = await retrieval.get_messages({"filePath": file_path}, [prompt_id])
    assert deleted_call.ok is True
    if not deleted_call.ok:
        return
    assert deleted_call.value.served == []
    assert deleted_call.value.unserved[0].reason == "deleted"

    full = await retrieval.get_turns({"filePath": file_path}, ["t1", "t2"])
    assert full.ok is True
    if not full.ok:
        return
    t2_tokens = full.value.served[1].tokens
    budget_call = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1", "t2"],
        RetrievalOptions(token_budget=t2_tokens),
    )
    assert budget_call.ok is True
    if not budget_call.ok:
        return
    assert len(budget_call.value.unserved) == 1
    assert budget_call.value.unserved[0].reason == "budget"

    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return

    deleted_row = next(
        r
        for r in impressions.value
        if r.call_id == deleted_call.value.call_id and r.entity_id == prompt_id
    )
    assert deleted_row.served is False
    assert deleted_row.reason == "deleted"
    assert deleted_row.entity_kind == "message"

    budget_row = next(
        r
        for r in impressions.value
        if r.call_id == budget_call.value.call_id and r.entity_id == "t2"
    )
    assert budget_row.served is False
    assert budget_row.reason == "budget"
    assert budget_row.entity_kind == "turn"
    assert budget_row.tokens is not None and budget_row.tokens > 0


async def test_retrieval_writes_nothing_to_record_tables(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    before = await sdk.messages.list({"filePath": file_path})
    if not before.ok:
        raise RuntimeError("list failed")

    await retrieval.get_turns({"filePath": file_path}, ["t1", "t2"])
    await retrieval.get_messages({"filePath": file_path}, [before.value[0].message_id])

    after = await sdk.messages.list({"filePath": file_path})
    if not after.ok:
        raise RuntimeError("list failed")
    assert after.value == before.value


async def test_fresh_thread_schema_v6_via_retrieval_surface(sdk, file_path: str) -> None:
    # Open path used by retrieval must see schema v6.
    conn = sqlite3.connect(file_path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        assert version == THREAD_SCHEMA_VERSION_6
        present = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'"
        ).fetchone()
        assert present is not None
    finally:
        conn.close()
    # list_impressions works on empty log
    empty = await retrieval.list_impressions({"filePath": file_path})
    assert empty.ok is True
    if empty.ok:
        assert empty.value == []


async def test_composed_turn_preserves_canonical_member_order(sdk, file_path: str) -> None:
    """get_turns recompose follows persisted message order (history ordering)."""
    await _seed_two_turns(file_path)
    # No drain — force composed path.
    result = await retrieval.get_turns({"filePath": file_path}, ["t2"])
    assert result.ok is True
    if not result.ok:
        return
    text = result.value.served[0].text
    # Member tags in record order: prompt then tool run members then answer.
    m_user = text.find("<m")
    assert m_user >= 0
    # Tool-run lines and assistant answer appear after the user prompt body.
    assert text.index("read the file please") < text.index("done reading")
    assert result.value.served[0].source == "composed"


async def test_id_shape_12_digits_pass_13_digits_invalid(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    ok_id = "t" + ("1" * 12)
    bad_id = "t" + ("1" * 13)
    result = await retrieval.get_turns({"filePath": file_path}, [ok_id, bad_id, "t1"])
    assert result.ok is True
    if not result.ok:
        return
    reasons = {u.id: u.reason for u in result.value.unserved}
    assert reasons[bad_id] == "invalid"
    # 12-digit id is shape-valid; may be not_found.
    assert ok_id not in reasons or reasons[ok_id] == "not_found"
    assert any(t.turn_id == "t1" for t in result.value.served)
