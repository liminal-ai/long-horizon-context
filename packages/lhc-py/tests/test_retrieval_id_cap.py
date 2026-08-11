"""R4 retrieval id cap + UTF-16 clamp parity.

Ported from packages/lhc/test/retrieval-id-cap.test.ts (pin 81cd48c).
"""

from __future__ import annotations

import pytest

from lhc import (
    create_deterministic_inference_callbacks,
    init_lhc,
    intake_stream,
    retrieval,
)
from lhc.retrieval import (
    DEFAULT_RETRIEVAL_TOKEN_BUDGET,
    MAX_RETRIEVAL_IDS_PER_CALL,
    RetrievalOptions,
    clamp_id_echo,
)
from lhc.shared_tech._jsstr import js_len, js_slice
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
    sent = await intake_stream.message_events(
        {"filePath": path},
        [
            valid_event("user_prompt", {"payload": {"text": "only question"}}),
            valid_event("assistant_text", {"payload": {"text": "only answer"}}),
            valid_event("turn_end"),
        ],
    )
    if not sent.ok:
        raise RuntimeError(sent.error.reason)
    drained = await sdk.work.drain({"filePath": path})
    if not drained.ok:
        raise RuntimeError(drained.error.reason)
    return path


async def test_refuses_over_cap_calls_whole_naming_the_cap(sdk, file_path: str) -> None:
    ids = [f"t{i + 1}" for i in range(MAX_RETRIEVAL_IDS_PER_CALL + 1)]
    result = await retrieval.get_turns({"filePath": file_path}, ids)
    assert result.ok is False
    if result.ok:
        return
    reason = result.error.reason
    assert "too many ids" in reason
    assert str(MAX_RETRIEVAL_IDS_PER_CALL) in reason
    assert "split the request" in reason
    expected = (
        f"get_turns: too many ids — {MAX_RETRIEVAL_IDS_PER_CALL + 1} requested, "
        f"cap is {MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request"
    )
    assert reason == expected


async def test_accepts_exactly_the_cap_of_unique_ids(sdk, file_path: str) -> None:
    ids = [f"t{i + 1}" for i in range(MAX_RETRIEVAL_IDS_PER_CALL)]
    result = await retrieval.get_turns({"filePath": file_path}, ids)
    assert result.ok is True


async def test_counts_deduped_ids_not_raw_ids(sdk, file_path: str) -> None:
    ids = ["t1"] * (MAX_RETRIEVAL_IDS_PER_CALL + 10)
    result = await retrieval.get_turns({"filePath": file_path}, ids)
    assert result.ok is True


async def test_refuses_oversized_ids_per_id_as_invalid_with_echo_clamped(
    sdk, file_path: str
) -> None:
    monster = "t" + ("9" * 40_000)
    expected_echo = clamp_id_echo(monster)
    # Exact 32 UTF-16 code units + ellipsis.
    assert js_len(expected_echo[: -len("…")]) == 32
    assert expected_echo.endswith("…")
    assert expected_echo[:32] == monster[:32]
    assert expected_echo == f"{js_slice(monster, 0, 32)}…"

    result = await retrieval.get_turns({"filePath": file_path}, [monster, "t1"])
    assert result.ok is True
    if not result.ok:
        return
    invalid = next(u for u in result.value.unserved if u.reason == "invalid")
    assert invalid.id == expected_echo
    assert js_len(invalid.id) <= 33  # 32 units + … (ellipsis is one unit / BMP)
    assert len(result.value.served) == 1

    # Impression row also stores the clamped echo.
    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    invalid_imp = next(r for r in impressions.value if r.reason == "invalid")
    assert invalid_imp.entity_id == expected_echo
    assert invalid_imp.served is False


async def test_utf16_clamp_parity_on_astral_characters() -> None:
    # Astral emoji is two UTF-16 units; clamp follows js_slice unit count, then
    # replaces a mid-pair lone surrogate with U+FFFD (Node/SQLite stored form).
    crab = "\U0001f980"  # 🦀 — two UTF-16 units
    long_id = "t" + (crab * 40)
    echo = clamp_id_echo(long_id)
    assert js_len(echo) == 33  # 32 units + …
    assert echo.endswith("…")
    raw_slice = js_slice(long_id, 0, 32)
    # Mid-pair cut leaves a lone high surrogate; clamp must not keep it.
    assert any(0xD800 <= ord(ch) <= 0xDFFF for ch in raw_slice)
    assert not any(0xD800 <= ord(ch) <= 0xDFFF for ch in echo)
    assert "\uFFFD" in echo
    safe_prefix = "".join(
        "\uFFFD" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in raw_slice
    )
    assert echo == f"{safe_prefix}…"
    # Pure Python slicing by code points would disagree:
    assert echo != (long_id[:32] + "…" if len(long_id) > 32 else long_id)


async def test_astral_invalid_id_completes_call_and_writes_impression(
    sdk, file_path: str
) -> None:
    """Lone-surrogate clamp must not abort the write transaction (R4 round-2 P1)."""
    crab = "\U0001f980"
    monster = "t" + (crab * 40)
    expected = clamp_id_echo(monster)
    assert "\uFFFD" in expected

    result = await retrieval.get_turns({"filePath": file_path}, [monster, "t1"])
    assert result.ok is True, (
        f"astral invalid id must complete (Node stores U+FFFD); got {result}"
    )
    if not result.ok:
        return
    invalid = next(u for u in result.value.unserved if u.reason == "invalid")
    assert invalid.id == expected
    assert len(result.value.served) == 1
    assert result.value.served[0].turn_id == "t1"

    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    invalid_imp = next(r for r in impressions.value if r.reason == "invalid")
    assert invalid_imp.entity_id == expected
    assert invalid_imp.served is False
    # Durable form is UTF-8-safe (no lone surrogates).
    expected.encode("utf-8")
    invalid_imp.entity_id.encode("utf-8")


async def test_unicode_digits_are_invalid_not_not_found(sdk, file_path: str) -> None:
    """Python ``\\d`` is Unicode-aware; JS ``\\d`` is ASCII — Arabic-Indic digits invalid."""
    # ARABIC-INDIC DIGIT ONE (U+0661) — matches Python \\d, not JS \\d.
    unicode_digit_id = "t\u0661"
    assert retrieval.RETRIEVAL_ID_PATTERN.fullmatch(unicode_digit_id) is None
    # Sanity: ASCII digit form remains valid shape.
    assert retrieval.RETRIEVAL_ID_PATTERN.fullmatch("t1") is not None

    result = await retrieval.get_turns(
        {"filePath": file_path}, [unicode_digit_id, "t1"]
    )
    assert result.ok is True
    if not result.ok:
        return
    unserved = {u.id: u.reason for u in result.value.unserved}
    assert unicode_digit_id in unserved
    assert unserved[unicode_digit_id] == "invalid"
    assert unserved[unicode_digit_id] != "not_found"
    assert any(s.turn_id == "t1" for s in result.value.served)

    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    row = next(r for r in impressions.value if r.entity_id == unicode_digit_id)
    assert row.reason == "invalid"
    assert row.served is False


async def test_fractional_token_budget_preserved_like_ts_math_min(
    sdk, file_path: str
) -> None:
    """TS Math.min keeps fractions; int() truncation is a contract break (R4 round-2)."""
    cases = [
        (0.5, 0.5),
        (1.5, 1.5),
        (7999.9, 7999.9),
        (8000.5, float(DEFAULT_RETRIEVAL_TOKEN_BUDGET)),  # ceiling
        (10_000, float(DEFAULT_RETRIEVAL_TOKEN_BUDGET)),
    ]
    for raw, expected in cases:
        result = await retrieval.get_turns(
            {"filePath": file_path},
            ["t1"],
            RetrievalOptions(token_budget=raw),
        )
        assert result.ok is True, f"token_budget={raw}: {result}"
        if not result.ok:
            continue
        assert result.value.token_budget == expected, (
            f"token_budget={raw}: expected receipt {expected}, "
            f"got {result.value.token_budget}"
        )


async def test_clamps_caller_token_budget_to_contract_ceiling(
    sdk, file_path: str
) -> None:
    result = await retrieval.get_turns(
        {"filePath": file_path},
        ["t1"],
        RetrievalOptions(token_budget=10_000_000),
    )
    assert result.ok is True
    if result.ok:
        assert result.value.token_budget <= DEFAULT_RETRIEVAL_TOKEN_BUDGET
        assert result.value.token_budget == DEFAULT_RETRIEVAL_TOKEN_BUDGET


async def test_invalid_id_writes_one_impression(sdk, file_path: str) -> None:
    result = await retrieval.get_turns(
        {"filePath": file_path}, ["not-an-id", "also!!bad", "t1"]
    )
    assert result.ok is True
    if not result.ok:
        return
    impressions = await retrieval.list_impressions({"filePath": file_path})
    assert impressions.ok is True
    if not impressions.ok:
        return
    # Three requested (no dups) → three impressions; two invalid + one served.
    assert len(impressions.value) == 3
    invalid_rows = [r for r in impressions.value if r.reason == "invalid"]
    assert len(invalid_rows) == 2
    served_rows = [r for r in impressions.value if r.served]
    assert len(served_rows) == 1
    assert served_rows[0].entity_id == "t1"
