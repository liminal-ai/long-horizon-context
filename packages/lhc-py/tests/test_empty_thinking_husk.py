"""Empty thinking husks (R1 / bu9).

Ported from packages/lhc/test/empty-thinking-husk.test.ts at pin 81cd48c.
Rust trap-map: packages/lhc-rs/tests/empty_thinking_husk.rs (same pin) —
signed variants use post-capture DB block patches because R2 owns intake
signature fields; serve filters only read stored block content.

Invariants:
- Capture remains immutable and keeps every thinking row.
- Empty/whitespace unsigned thinking is omitted from LLM context, session
  export, and smooth-band rendering.
- Empty signed thinking remains in session export; signature-only thinking
  is omitted only from the text-only LLM path.
- Non-empty thinking remains visible through both exits.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from lhc import Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech._jsstr import js_json_dumps, js_trim
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    PartialViewProfilePercentages,
    SessionAssistantMessage,
    SessionAssistantPart,
    ViewCompactParams,
)
from lhc.thread_view import CompactOpts
from lhc.thread_view.internal.render import has_thinking_text, is_empty_thinking_husk
from lhc.thread_view.internal.snapshot import TailMessageBlock, TailMessageRow
from fixtures import TempStore, open_raw, temp_store, valid_event

# ECMAScript String.prototype.trim divergence from Python str.strip():
# U+FEFF (BOM) trims to empty in JS; U+0085 (NEL) does not.
_JS_TRIM_EMPTY_BOM = "\ufeff"
_JS_TRIM_NONEMPTY_NEL = "\u0085"


def _manual_sdk() -> Lhc:
    return init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=create_deterministic_inference_callbacks(),
        )
    )


async def _new_thread(sdk: Lhc, store: TempStore) -> str:
    path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return path


def _thinking_row(content: dict[str, object]) -> TailMessageRow:
    return TailMessageRow(
        message_id="m1",
        source_event_order=1,
        idempotency_key="k1",
        kind="assistant_thinking",
        recorded_at="2026-08-06T00:00:00.000Z",
        blocks=[
            TailMessageBlock(block_type="assistant_thinking", content=content),
        ],
    )


async def _seed_turn_with_husk(sdk: Lhc, file_path: str, thinking_text: str) -> None:
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "what is in the file?"}}),
            valid_event("assistant_thinking", {"payload": {"text": thinking_text}}),
            valid_event(
                "assistant_text",
                {"payload": {"text": "The file holds three entries."}},
            ),
            valid_event("turn_end"),
        ],
    )
    if not captured.ok:
        raise RuntimeError(captured.error.reason)


def _llm_texts(context) -> list[str]:
    return [
        "\n".join(part.text for part in message.content) for message in context.messages
    ]


def _assistant_parts(entries) -> list[SessionAssistantPart]:
    parts: list[SessionAssistantPart] = []
    for entry in entries:
        if isinstance(entry, SessionAssistantMessage):
            parts.extend(entry.content)
        elif getattr(entry, "role", None) == "assistant" and isinstance(
            getattr(entry, "content", None), list
        ):
            parts.extend(entry.content)
    return parts


# ── is_empty_thinking_husk / has_thinking_text ───────────────────────


class TestIsEmptyThinkingHuskPredicate:
    def test_skips_empty_text_unsigned_thinking(self) -> None:
        assert is_empty_thinking_husk(_thinking_row({"text": ""})) is True

    def test_skips_whitespace_only_unsigned_thinking(self) -> None:
        assert is_empty_thinking_husk(_thinking_row({"text": "  \n\t"})) is True

    def test_serves_thinking_with_real_text(self) -> None:
        assert is_empty_thinking_husk(_thinking_row({"text": "reasoning here"})) is False

    def test_serves_empty_text_thinking_with_signature(self) -> None:
        # R1 boundary: signature is read from stored block content only.
        # Intake schema for signature is R2; unit surface is TailMessageRow.
        assert (
            is_empty_thinking_husk(
                _thinking_row({"text": "", "signature": "enc-abc123"})
            )
            is False
        )
        assert (
            is_empty_thinking_husk(
                _thinking_row({"text": "", "thinkingSignature": "enc-abc123"})
            )
            is False
        )

    def test_never_matches_non_thinking_kinds(self) -> None:
        row = replace(_thinking_row({"text": ""}), kind="assistant_text")
        assert is_empty_thinking_husk(row) is False

    def test_has_thinking_text_true_only_for_nonempty_thinking_text(self) -> None:
        assert has_thinking_text(_thinking_row({"text": "visible"})) is True
        assert (
            has_thinking_text(
                _thinking_row({"text": "", "signature": "enc-only"})
            )
            is False
        )
        assert has_thinking_text(_thinking_row({"text": "  "})) is False
        non_thinking = replace(
            _thinking_row({"text": "x"}), kind="assistant_text"
        )
        assert has_thinking_text(non_thinking) is False

    def test_js_trim_empty_bom_is_husk_nel_is_not(self) -> None:
        # Guard the oracle itself so a Python strip regression is obvious.
        assert js_trim(_JS_TRIM_EMPTY_BOM) == ""
        assert js_trim(_JS_TRIM_NONEMPTY_NEL) == _JS_TRIM_NONEMPTY_NEL
        assert _JS_TRIM_EMPTY_BOM.strip() != ""  # Python would misclassify FEFF
        assert _JS_TRIM_NONEMPTY_NEL.strip() == ""  # Python would misclassify NEL

        assert is_empty_thinking_husk(_thinking_row({"text": _JS_TRIM_EMPTY_BOM})) is True
        assert has_thinking_text(_thinking_row({"text": _JS_TRIM_EMPTY_BOM})) is False
        assert (
            is_empty_thinking_husk(_thinking_row({"text": _JS_TRIM_NONEMPTY_NEL}))
            is False
        )
        assert has_thinking_text(_thinking_row({"text": _JS_TRIM_NONEMPTY_NEL})) is True


# ── serving exits ────────────────────────────────────────────────────


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


@pytest.mark.asyncio
async def test_get_llm_request_context_serves_no_thinking_husk(store: TempStore) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, "")

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    if not context.ok:
        raise RuntimeError(context.error.reason)
    texts = _llm_texts(context.value)
    assert not any("[thinking]" in text for text in texts)
    assert any("The file holds three entries." in text for text in texts)


@pytest.mark.asyncio
async def test_get_session_thread_view_serves_no_empty_thinking_part(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, "")

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not view.ok:
        raise RuntimeError(view.error.reason)
    parts = _assistant_parts(view.value.entries)
    assert not any(part.type == "thinking" for part in parts)
    assert any(part.type == "text" for part in parts)


@pytest.mark.asyncio
async def test_whitespace_husk_omitted_from_both_exits(store: TempStore) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, "  \n\t")

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")
    texts = _llm_texts(context.value)
    assert not any("[thinking]" in text for text in texts)
    parts = _assistant_parts(view.value.entries)
    assert not any(part.type == "thinking" for part in parts)


@pytest.mark.asyncio
async def test_non_empty_thinking_still_serves_through_both_exits(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, "real reasoning text")

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")
    texts = _llm_texts(context.value)
    assert any("[thinking]\nreal reasoning text" in text for text in texts)
    parts = _assistant_parts(view.value.entries)
    assert any(
        part.type == "thinking" and part.thinking == "real reasoning text"
        for part in parts
    )


@pytest.mark.asyncio
async def test_record_keeps_the_husk_row_capture_untouched(store: TempStore) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, "")

    detail = await sdk.messages.list({"filePath": file_path})
    if not detail.ok:
        raise RuntimeError(detail.error.reason)
    kinds = [message.kind for message in detail.value]
    assert "assistant_thinking" in kinds


def _patch_thinking_blocks(
    file_path: str, patches: list[dict[str, object]]
) -> None:
    """Post-capture block content patches (R1 trap-map: signature not on intake)."""
    db = open_raw(file_path)
    try:
        rows = db.prepare(
            """SELECT m.message_id FROM message m
               WHERE m.kind = 'assistant_thinking' AND m.deleted_at IS NULL
               ORDER BY m.source_event_order"""
        ).all()
        assert len(rows) == len(patches)
        for row, content in zip(rows, patches, strict=True):
            message_id = str(row["message_id"])
            content_json = js_json_dumps(content)
            db.prepare(
                """UPDATE message_block SET content = ?
                   WHERE message_id = ? AND block_index = 0"""
            ).run(content_json, message_id)
    finally:
        db.close()


@pytest.mark.asyncio
async def test_export_keeps_signature_only_assembly_skips_it_both_keep_signed_text(
    store: TempStore,
) -> None:
    """Conformance: true husk / signature-only / signed-with-text.

    R1 boundary: intake does not yet accept `signature` (R2). After capture,
    patch message_block content so serve filters see the three stored shapes.
    Session export keeps (ii)+(iii); text LLM path keeps (iii) only; record
    retains all three.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "tri-variant fixture"}}),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {"text": ""},
                    "idempotencyKey": "think-husk",
                },
            ),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {"text": ""},
                    "idempotencyKey": "think-sig-only",
                },
            ),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {"text": "visible signed reasoning"},
                    "idempotencyKey": "think-signed-text",
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "final answer"}}),
            valid_event("turn_end"),
        ],
    )
    if not captured.ok:
        raise RuntimeError(captured.error.reason)

    _patch_thinking_blocks(
        file_path,
        [
            {"text": ""},
            {"text": "", "signature": "enc-sig-only"},
            {"text": "visible signed reasoning", "signature": "enc-sig-text"},
        ],
    )

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not view.ok:
        raise RuntimeError(view.error.reason)
    thinking_parts = [
        part for part in _assistant_parts(view.value.entries) if part.type == "thinking"
    ]
    assert len(thinking_parts) == 2, (
        "export must show signature-only + signed-with-text, not the true husk"
    )
    assert any(part.thinking == "" for part in thinking_parts)
    assert any(part.thinking == "visible signed reasoning" for part in thinking_parts)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    if not context.ok:
        raise RuntimeError(context.error.reason)
    texts = _llm_texts(context.value)
    thinking_msgs = [text for text in texts if "[thinking]" in text]
    assert len(thinking_msgs) == 1, "assembly must emit only signed-with-text thinking"
    assert "visible signed reasoning" in thinking_msgs[0]
    assert not any(
        text in ("[thinking]\n\n[/thinking]", "[thinking]\n[/thinking]")
        or ("[thinking]" in text and "visible signed reasoning" not in text)
        for text in texts
    )

    detail = await sdk.messages.list({"filePath": file_path})
    if not detail.ok:
        raise RuntimeError(detail.error.reason)
    thinking_count = sum(1 for m in detail.value if m.kind == "assistant_thinking")
    assert thinking_count == 3

    # Record purity: patched signature bytes remain on stored blocks.
    db = open_raw(file_path)
    try:
        blocks = db.prepare(
            """SELECT mb.content FROM message_block mb
               JOIN message m ON m.message_id = mb.message_id
               WHERE m.kind = 'assistant_thinking' AND m.deleted_at IS NULL
               ORDER BY m.source_event_order, mb.block_index"""
        ).all()
        contents = [json.loads(str(row["content"])) for row in blocks]
        assert contents[0] == {"text": ""}
        assert contents[1]["signature"] == "enc-sig-only"
        assert contents[2]["signature"] == "enc-sig-text"
    finally:
        db.close()


@pytest.mark.asyncio
async def test_bom_only_thinking_omitted_from_both_tail_exits(store: TempStore) -> None:
    """U+FEFF is JS-whitespace: unsigned BOM-only thinking is a true husk."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, _JS_TRIM_EMPTY_BOM)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")
    texts = _llm_texts(context.value)
    assert not any("[thinking]" in text for text in texts)
    parts = _assistant_parts(view.value.entries)
    assert not any(part.type == "thinking" for part in parts)
    assert any(part.type == "text" for part in parts)

    # Capture still keeps the row (serve-only filter).
    detail = await sdk.messages.list({"filePath": file_path})
    if not detail.ok:
        raise RuntimeError(detail.error.reason)
    assert any(m.kind == "assistant_thinking" for m in detail.value)


@pytest.mark.asyncio
async def test_nel_only_thinking_retained_through_both_tail_exits(
    store: TempStore,
) -> None:
    """U+0085 is not JS-whitespace: NEL-only thinking is non-empty text."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_turn_with_husk(sdk, file_path, _JS_TRIM_NONEMPTY_NEL)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")
    texts = _llm_texts(context.value)
    assert any(
        f"[thinking]\n{_JS_TRIM_NONEMPTY_NEL}" in text for text in texts
    ), texts
    parts = _assistant_parts(view.value.entries)
    assert any(
        part.type == "thinking" and part.thinking == _JS_TRIM_NONEMPTY_NEL
        for part in parts
    )


@pytest.mark.asyncio
async def test_bom_only_thinking_omitted_from_compacted_smooth_band(
    store: TempStore,
) -> None:
    """Smooth-band producer uses the same JS trim: BOM husks must not reappear."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for _ in range(3):
        await _seed_turn_with_husk(sdk, file_path, _JS_TRIM_EMPTY_BOM)

    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(drained.error.reason)

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    if not compacted.ok:
        raise RuntimeError(compacted.error.reason)
    assert compacted.value.bands["smooth"].entries > 0

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")
    context_text = "\n".join(
        part.text for message in context.value.messages for part in message.content
    )
    session_text = "\n".join(
        entry.content
        for entry in view.value.entries
        if getattr(entry, "role", None) == "user"
        and isinstance(getattr(entry, "content", None), str)
    )
    assert "Assistant thinking" not in context_text
    assert "Assistant thinking" not in session_text
    assert "[thinking]" not in context_text
    assert _JS_TRIM_EMPTY_BOM not in context_text


def _ready_turn_renderings(file_path: str) -> list[str]:
    """Stored smooth producer output only — not assembled LLM context (no tail)."""
    db = open_raw(file_path)
    try:
        rows = db.prepare(
            """SELECT content FROM derivation
               WHERE subject_kind = 'turn'
                 AND derivation_type = 'turn_rendering'
                 AND state = 'ready'
                 AND content IS NOT NULL
               ORDER BY subject_id"""
        ).all()
        return [str(row["content"]) for row in rows]
    finally:
        db.close()


def _smooth_band_rendered_text(file_path: str) -> str:
    """Persisted smooth-band snapshot bytes only — independent of live tail."""
    db = open_raw(file_path)
    try:
        row = db.prepare(
            """SELECT rendered_text FROM thread_view_band WHERE band = 'smooth'"""
        ).get()
        assert row is not None, "expected a stored smooth band after compact"
        return str(row["rendered_text"])
    finally:
        db.close()


@pytest.mark.asyncio
async def test_nel_only_thinking_retained_in_compacted_smooth_band(
    store: TempStore,
) -> None:
    """NEL-only thinking survives smooth-band composition (JS trim keeps it).

    Isolation: assert stored turn_rendering + smooth-band rendered_text only.
    Assembled getLlmRequestContext concatenates smooth band with live tail, so
    a tail-retaining U+0085 would mask a producer that wrongly strips NEL.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for _ in range(3):
        await _seed_turn_with_husk(sdk, file_path, _JS_TRIM_NONEMPTY_NEL)

    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(drained.error.reason)

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    if not compacted.ok:
        raise RuntimeError(compacted.error.reason)
    assert compacted.value.bands["smooth"].entries > 0

    # Direct producer surface: turn_rendering is what _compose_structured_turn_text wrote.
    renderings = _ready_turn_renderings(file_path)
    assert len(renderings) > 0
    assert any(
        "Assistant thinking" in text and _JS_TRIM_NONEMPTY_NEL in text
        for text in renderings
    ), renderings

    # Band snapshot surface: assembled smooth bytes must carry NEL without tail help.
    smooth_text = _smooth_band_rendered_text(file_path)
    assert "Assistant thinking" in smooth_text
    assert _JS_TRIM_NONEMPTY_NEL in smooth_text

    # Receipt mirror of the same band (no getLlmRequestContext tail blend).
    receipt_smooth = next(
        (band.text for band in compacted.value.rendered_bands if band.band == "smooth"),
        None,
    )
    assert receipt_smooth is not None
    assert _JS_TRIM_NONEMPTY_NEL in receipt_smooth


@pytest.mark.asyncio
async def test_does_not_reintroduce_husks_through_compacted_smooth_band_rendering(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for _ in range(3):
        await _seed_turn_with_husk(sdk, file_path, "")

    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(drained.error.reason)

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    if not compacted.ok:
        raise RuntimeError(compacted.error.reason)
    assert compacted.value.bands["smooth"].entries > 0

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    if not context.ok or not view.ok:
        raise RuntimeError("serve failed")

    context_text = "\n".join(
        part.text for message in context.value.messages for part in message.content
    )
    session_text = "\n".join(
        entry.content
        for entry in view.value.entries
        if getattr(entry, "role", None) == "user" and isinstance(getattr(entry, "content", None), str)
    )
    assert "Assistant thinking" not in context_text
    assert "Assistant thinking" not in session_text
