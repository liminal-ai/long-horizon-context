"""Retrieval domain parity — ported from packages/lhc/test/retrieval.test.ts
(pin 81cd48c). R4: validation, impressions, serve/compose. R6: token/byte
budget walk, from_token continuation, sliver exemption, formatter wiring.
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
from lhc.retrieval import (
    DEFAULT_RETRIEVAL_TOKEN_BUDGET,
    MAX_RETRIEVAL_OUTPUT_TOKENS,
    RetrievalOptions,
)
from lhc.retrieval.format import format_get_turns_result, recall_close, recall_open
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


async def _seed_big_turn(file_path: str) -> None:
    """One closed turn large enough to force token slicing (TS seedBigTurn)."""
    big_body = "\n".join(
        f"line {i}: the quick brown fox jumps over the lazy dog" for i in range(400)
    )
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump the log please"}}),
            valid_event(
                "assistant_text",
                {"payload": {"text": f"full log follows\n{big_body}"}},
            ),
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


async def test_from_token_rejects_outside_finite_js_number_domain(
    sdk, file_path: str
) -> None:
    """Python ints beyond finite IEEE-754 are not TS Number.isInteger values.

    Verifier P1: ``from_token=10**2000`` was accepted, and 32 past-end slice
    footers printed the full decimal form past the analytic 22k bound.
    Reject at resolve time; keep ordinary in-domain integers valid.
    """
    await _seed_two_turns(file_path)

    outside = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1"],
        RetrievalOptions(from_token=10**2000),
    )
    assert outside.ok is False
    assert "fromToken" in outside.error.reason
    assert "non-negative integer" in outside.error.reason

    # In-domain finite Number integers (including large but finite floats)
    # remain accepted — match Number.isInteger, do not over-reject.
    for ok_from in (0, 1, 50_000, 2**53 - 1, int(1e200), 10**308):
        result = await retrieval.get_turns(
            {"filePath": file_path},
            ["t1"],
            RetrievalOptions(from_token=ok_from),
        )
        assert result.ok is True, f"from_token={ok_from!r} should be in-domain: {result}"

    # 32-id past-end request with an out-of-domain offset must fail closed
    # as storage validation — never format a bound-breaking envelope.
    many_ids = [f"t{i}" for i in range(1, 33)]
    multi = await retrieval.get_turns(
        {"filePath": file_path},
        many_ids,
        RetrievalOptions(from_token=10**2000),
    )
    assert multi.ok is False
    assert "fromToken" in multi.error.reason


async def test_token_and_byte_budget_huge_ints_are_storage_failures_not_overflow(
    sdk, file_path: str
) -> None:
    """Huge Python ints must not escape as OverflowError on float conversion.

    Verifier P1: ``token_budget`` / ``byte_budget`` of ``10**400`` raised
    during resolve outside the OpResult failure contract. Same validation
    messages as other non-positive / non-finite numeric rejects.
    """
    await _seed_two_turns(file_path)

    for opts, needle in (
        (RetrievalOptions(token_budget=10**400), "tokenBudget"),
        (RetrievalOptions(byte_budget=10**400), "byteBudget"),
        (RetrievalOptions(token_budget=10**309), "tokenBudget"),
        (RetrievalOptions(byte_budget=10**309), "byteBudget"),
    ):
        try:
            result = await retrieval.get_turns(
                {"filePath": file_path}, ["t1"], opts
            )
        except OverflowError as exc:  # pragma: no cover - the bug under test
            raise AssertionError(
                f"{opts} raised OverflowError instead of OpResult failure: {exc}"
            ) from exc
        assert result.ok is False, f"{opts} expected storage failure, got ok"
        assert needle in result.error.reason
        assert "positive number" in result.error.reason

    # Pinned TS 81cd48c semantics preserved for ordinary / edge numbers.
    for opts, expect_ok in (
        (RetrievalOptions(token_budget=0.5), True),  # fractional preserved
        (RetrievalOptions(token_budget=float("nan")), False),
        (RetrievalOptions(token_budget=float("inf")), False),
        (RetrievalOptions(token_budget=True), False),  # bool ≠ number
        (RetrievalOptions(byte_budget=float("inf")), True),  # +inf allowed
        (RetrievalOptions(byte_budget=float("nan")), False),
        (RetrievalOptions(byte_budget=0.5), True),
        (RetrievalOptions(byte_budget=True), False),
        (RetrievalOptions(from_token=float("nan")), False),
        (RetrievalOptions(from_token=float("inf")), False),
        (RetrievalOptions(from_token=True), False),
        (RetrievalOptions(from_token=1.5), False),
        (RetrievalOptions(from_token=0.0), True),
    ):
        result = await retrieval.get_turns(
            {"filePath": file_path}, ["t1"], opts
        )
        assert result.ok is expect_ok, (
            f"{opts}: expected ok={expect_ok}, got {result}"
        )


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


# ── R6: token slice / from_token / byte budget / formatter ────────────


async def test_get_turns_slices_oversized_turn_with_continuation_receipt(
    sdk, file_path: str
) -> None:
    await _seed_big_turn(file_path)
    await _drain(sdk, file_path)
    result = await retrieval.get_turns(
        {"filePath": file_path}, ["t1"], RetrievalOptions(token_budget=500)
    )
    assert result.ok is True
    if not result.ok:
        return
    turn = result.value.served[0]
    assert turn.slice is not None
    assert turn.slice.from_token == 0
    assert turn.slice.to_token == 500
    assert turn.slice.total_tokens > 500
    assert turn.tokens == 500
    assert result.value.total_tokens == 500


async def test_from_token_continuation_slices_reassemble_full_text(
    sdk, file_path: str
) -> None:
    await _seed_big_turn(file_path)
    await _drain(sdk, file_path)
    whole = await retrieval.get_turns({"filePath": file_path}, ["t1"])
    assert whole.ok is True
    if not whole.ok:
        return
    full_text = whole.value.served[0].text

    assembled = ""
    from_token = 0
    for _ in range(20):
        part = await retrieval.get_turns(
            {"filePath": file_path},
            ["t1"],
            RetrievalOptions(token_budget=400, from_token=from_token),
        )
        assert part.ok is True
        if not part.ok:
            return
        slice_item = part.value.served[0]
        assert slice_item.slice is not None
        assembled += slice_item.text
        from_token = slice_item.slice.to_token
        if from_token >= slice_item.slice.total_tokens:
            break
    assert assembled == full_text


async def test_crossing_item_sliced_later_items_get_budget_receipts(
    sdk, file_path: str
) -> None:
    await _seed_big_turn(file_path)
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "small follow-up"}}),
            valid_event("assistant_text", {"payload": {"text": "small answer"}}),
            valid_event("turn_end"),
        ],
    )
    await _drain(sdk, file_path)
    result = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1", "t2"],
        RetrievalOptions(token_budget=500),
    )
    assert result.ok is True
    if not result.ok:
        return
    assert [t.turn_id for t in result.value.served] == ["t1"]
    assert result.value.served[0].slice is not None
    assert len(result.value.unserved) == 1
    assert result.value.unserved[0].id == "t2"
    assert result.value.unserved[0].reason == "budget"
    assert result.value.unserved[0].tokens is not None


async def test_from_token_applies_per_item_on_multi_id_request(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    whole = await retrieval.get_turns({"filePath": file_path}, ["t1", "t2"])
    assert whole.ok is True
    if not whole.ok:
        return
    # Past-the-end offset on both: empty slices with receipts naming the ask.
    result = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1", "t2"],
        RetrievalOptions(from_token=50_000),
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 2
    for served in result.value.served:
        assert served.slice is not None
        assert served.slice.from_token == 50_000
        assert served.slice.to_token == 50_000
        assert served.text == ""
        assert served.tokens == 0


async def test_token_budget_defaults_and_caps_at_8000(sdk, file_path: str) -> None:
    await _seed_two_turns(file_path)
    await _drain(sdk, file_path)
    defaulted = await retrieval.get_turns({"filePath": file_path}, ["t1"])
    assert defaulted.ok is True
    if not defaulted.ok:
        return
    assert defaulted.value.token_budget == DEFAULT_RETRIEVAL_TOKEN_BUDGET
    assert DEFAULT_RETRIEVAL_TOKEN_BUDGET == 8000
    assert MAX_RETRIEVAL_OUTPUT_TOKENS == 22_000

    raised = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1"],
        RetrievalOptions(token_budget=50_000),
    )
    assert raised.ok is True
    if not raised.ok:
        return
    assert raised.value.token_budget == DEFAULT_RETRIEVAL_TOKEN_BUDGET


async def test_format_get_turns_result_on_live_oversized_pull(
    sdk, file_path: str
) -> None:
    await _seed_big_turn(file_path)
    await _drain(sdk, file_path)
    result = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1", "t99"],
        RetrievalOptions(token_budget=500),
    )
    assert result.ok is True
    if not result.ok:
        return
    text = format_get_turns_result(result.value)
    assert text.startswith(recall_open("get_turns"))
    close_idx = text.index("</recalled-history>")
    assert result.value.served[0].text in text[:close_idx]
    assert "Next slice:" in text[close_idx:]
    assert 'from":500' in text[close_idx:]
    assert "not served: t99 (not_found)" in text[close_idx:]
    assert recall_close("get_turns") in text


async def test_byte_budget_slices_token_cheap_byte_heavy_content(
    sdk, file_path: str
) -> None:
    dense = (("=" * 80) + "\n") * 1_500
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump"}}),
            valid_event("assistant_text", {"payload": {"text": dense}}),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    dense_id = next(r.message_id for r in listed.value if r.kind == "assistant_text")

    byte_budget = 12_000
    result = await retrieval.get_messages(
        {"filePath": file_path},
        [dense_id],
        RetrievalOptions(byte_budget=byte_budget),
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 1
    served = result.value.served[0]
    assert len(served.text.encode("utf-8")) <= byte_budget
    assert served.slice is not None
    assert served.slice.from_token == 0
    assert served.slice.to_token == served.tokens
    assert served.slice.to_token < served.slice.total_tokens

    nxt = await retrieval.get_messages(
        {"filePath": file_path},
        [dense_id],
        RetrievalOptions(byte_budget=byte_budget, from_token=served.slice.to_token),
    )
    assert nxt.ok is True
    if not nxt.ok:
        return
    next_served = nxt.value.served[0]
    assert next_served.slice is not None
    assert next_served.slice.from_token == served.slice.to_token
    assert len(next_served.text.encode("utf-8")) <= byte_budget


async def test_byte_budget_never_splits_multibyte_char_at_slice_tail(
    sdk, file_path: str
) -> None:
    crabs = (("\U0001F980" * 20) + "\n") * 200
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump"}}),
            valid_event("assistant_text", {"payload": {"text": crabs}}),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    crab_id = next(r.message_id for r in listed.value if r.kind == "assistant_text")

    from_token = 0
    reassembled = ""
    for _ in range(40):
        if len(reassembled) >= len(crabs):
            break
        page = await retrieval.get_messages(
            {"filePath": file_path},
            [crab_id],
            RetrievalOptions(byte_budget=1_001, from_token=from_token),
        )
        assert page.ok is True
        if not page.ok:
            return
        served = page.value.served[0]
        assert "\ufffd" not in served.text
        assert len(served.text.encode("utf-8")) <= 1_001
        if served.slice is None or served.slice.to_token == served.slice.total_tokens:
            reassembled += served.text
            break
        assert served.slice.to_token > from_token
        reassembled += served.text
        from_token = served.slice.to_token
    assert reassembled.startswith("\U0001F980")
    assert "\ufffd" not in reassembled


async def test_byte_bound_slice_exempt_from_sliver_floor(sdk, file_path: str) -> None:
    dense = (("=" * 80) + "\n") * 900
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump"}}),
            valid_event("assistant_text", {"payload": {"text": dense}}),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    dense_id = next(r.message_id for r in listed.value if r.kind == "assistant_text")

    result = await retrieval.get_messages(
        {"filePath": file_path},
        [dense_id],
        RetrievalOptions(byte_budget=8_000),
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 1
    served = result.value.served[0]
    assert len(served.text.encode("utf-8")) <= 8_000
    assert served.slice is not None
    assert served.slice.to_token > 0


async def test_byte_budget_whole_serve_and_rejects_non_positive(
    sdk, file_path: str
) -> None:
    await _seed_two_turns(file_path)
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    prompt_id = next(r.message_id for r in listed.value if r.kind == "user_prompt")

    whole = await retrieval.get_messages(
        {"filePath": file_path},
        [prompt_id],
        RetrievalOptions(byte_budget=1_000_000),
    )
    assert whole.ok is True
    if not whole.ok:
        return
    assert whole.value.served[0].slice is None

    bad = await retrieval.get_messages(
        {"filePath": file_path},
        [prompt_id],
        RetrievalOptions(byte_budget=0),
    )
    assert bad.ok is False


async def test_byte_spent_budget_serves_byte_bound_remainder_not_sliver_refuse(
    sdk, file_path: str
) -> None:
    dense = (("=" * 80) + "\n") * 900
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump"}}),
            valid_event("assistant_text", {"payload": {"text": dense}}),
            valid_event(
                "assistant_text",
                {"payload": {"text": (("=" * 80) + "\n") * 40}},
            ),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    ids = [r.message_id for r in listed.value if r.kind == "assistant_text"]

    result = await retrieval.get_messages(
        {"filePath": file_path}, ids, RetrievalOptions(byte_budget=8_000)
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 2
    assert result.value.served[1].slice is not None
    served_bytes = sum(len(item.text.encode("utf-8")) for item in result.value.served)
    assert served_bytes <= 8_000


async def test_special_token_text_survives_retrieval_slice(sdk, file_path: str) -> None:
    # Budget must be ≥ RETRIEVAL_SLICE_FLOOR (256) or the crossing item is
    # refused as a sliver, not sliced — pin budgetWalk contract.
    hostile = "before <|endoftext|> after " + ("pad word " * 400)
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "dump"}}),
            valid_event("assistant_text", {"payload": {"text": hostile}}),
            valid_event("turn_end"),
        ],
    )
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError("list failed")
    msg_id = next(r.message_id for r in listed.value if r.kind == "assistant_text")
    result = await retrieval.get_messages(
        {"filePath": file_path},
        [msg_id],
        RetrievalOptions(token_budget=300),
    )
    assert result.ok is True
    if not result.ok:
        return
    assert len(result.value.served) == 1
    served = result.value.served[0]
    assert served.slice is not None
    assert served.slice.to_token == 300
    # Continuation from the receipt still counts special-token text.
    nxt = await retrieval.get_messages(
        {"filePath": file_path},
        [msg_id],
        RetrievalOptions(token_budget=300, from_token=served.slice.to_token),
    )
    assert nxt.ok is True
    if not nxt.ok:
        return
    assert len(nxt.value.served) == 1
    reassembled = served.text + nxt.value.served[0].text
    assert "<|endoftext|>" in reassembled
