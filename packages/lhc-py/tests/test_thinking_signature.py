"""Thinking-signature capture (R2 / resume fidelity on fable-class models).

Ported from packages/lhc/test/thinking-signature.test.ts at pin 81cd48c, plus
post-wave identity-boundary / history-ordering cases at the same pin
(view-session-thread-view.test.ts; Rust trap-map thinking_signature.rs).

Invariants:
- assistant_thinking.signature is optional, opaque, stored verbatim; closed
  schema remains strict.
- Optional provider/model/api on assistant_thinking and assistant_text are
  projected verbatim and exported on the grouped assistant message.
- Omitted optional fields stay omitted (no empty keys on the block).
- Session-view grouping flushes before identity changes and before
  model/thinking-level change entries; history order follows persisted order.
- SDK exports signatures and provenance without deciding whether a host may
  replay them (replay-policy-neutral; Hermes leg 2 owns exact-match
  suppression / issuer contradiction / MoA unconditional suppression).
"""

from __future__ import annotations

import json

import pytest

from lhc import Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.view import (
    SessionAssistantMessage,
    SessionAssistantPart,
    SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry,
    SessionThreadViewEntry,
    SessionToolResultMessage,
    SessionUserMessage,
)
from fixtures import TempStore, open_raw, temp_store, valid_event


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


def _llm_texts(context) -> list[str]:
    return [
        "\n".join(part.text for part in message.content) for message in context.messages
    ]


def _assistant_entries(
    entries: list[SessionThreadViewEntry],
) -> list[SessionAssistantMessage]:
    return [e for e in entries if isinstance(e, SessionAssistantMessage)]


def _assistant_parts(entries: list[SessionThreadViewEntry]) -> list[SessionAssistantPart]:
    parts: list[SessionAssistantPart] = []
    for entry in _assistant_entries(entries):
        parts.extend(entry.content)
    return parts


def _entry_shape(entry: SessionThreadViewEntry) -> str:
    if isinstance(entry, SessionUserMessage):
        return "user"
    if isinstance(entry, SessionAssistantMessage):
        return "assistant"
    if isinstance(entry, SessionToolResultMessage):
        return "toolResult"
    if isinstance(entry, SessionModelChangeEntry):
        return "model_change"
    if isinstance(entry, SessionThinkingLevelChangeEntry):
        return "thinking_level_change"
    raise TypeError(f"unknown entry type: {type(entry)!r}")


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


# ── intake ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_accepts_optional_signature_and_materializes_it_on_the_message_block(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "hi"}}),
            valid_event(
                "assistant_thinking",
                {"payload": {"text": "", "signature": "enc-sig-abc"}},
            ),
            valid_event("assistant_text", {"payload": {"text": "hello"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    assert thinking.blocks[0].content == {"text": "", "signature": "enc-sig-abc"}


@pytest.mark.asyncio
async def test_rejects_unknown_payload_fields_on_assistant_thinking(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            {
                **valid_event("assistant_thinking"),
                "payload": {"text": "x", "signature": "s", "extra": True},
            },
        ],
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "invalid_event"
    reason = result.error.reason.lower()
    assert "extra" in reason or "unexpected" in reason


@pytest.mark.asyncio
async def test_omitted_signature_stays_omitted_on_the_block(store: TempStore) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event(
                "assistant_thinking",
                {"payload": {"text": "plain thought"}},
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    assert thinking.blocks[0].content == {"text": "plain thought"}
    assert "signature" not in thinking.blocks[0].content


@pytest.mark.asyncio
async def test_rejects_unknown_payload_fields_on_assistant_text(
    store: TempStore,
) -> None:
    """Closed schema for assistant_text identity fields (no silent drop)."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            {
                **valid_event("assistant_text"),
                "payload": {
                    "text": "x",
                    "provider": "p",
                    "model": "m",
                    "api": "a",
                    "extra": True,
                },
            },
        ],
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "invalid_event"
    reason = result.error.reason.lower()
    assert "extra" in reason or "unexpected" in reason


# Non-string optional fields: one row per (kind, field). Mutant that coerces
# to str or drops the field silently still fails when event_index / reason
# name the field. Batch is a single invalid event so event_index must be 0.
_NON_STRING_OPTIONAL_CASES: list[tuple[str, str, object]] = [
    ("assistant_thinking", "signature", 1),
    ("assistant_thinking", "signature", True),
    ("assistant_thinking", "signature", {"x": 1}),
    ("assistant_thinking", "provider", 42),
    ("assistant_thinking", "model", False),
    ("assistant_thinking", "api", ["responses"]),
    ("assistant_text", "provider", 0),
    ("assistant_text", "model", {"id": "m"}),
    ("assistant_text", "api", True),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "field", "bad_value"),
    _NON_STRING_OPTIONAL_CASES,
    ids=[f"{k}.{f}:{type(v).__name__}" for k, f, v in _NON_STRING_OPTIONAL_CASES],
)
async def test_non_string_optional_fields_reject_at_event_index_0(
    store: TempStore,
    kind: str,
    field: str,
    bad_value: object,
) -> None:
    """Each optional signature/provider/model/api must be a string when present.

    Applies to both assistant_thinking and assistant_text (signature only on
    thinking). Rejects at the first (only) event — event_index 0.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    payload: dict[str, object] = {"text": "x", field: bad_value}
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [{**valid_event(kind), "payload": payload}],  # type: ignore[arg-type]
    )
    assert result.ok is False, f"expected reject for {kind}.{field}={bad_value!r}"
    if result.ok:
        return
    assert result.error.code == "invalid_event"
    assert result.error.event_index == 0
    reason = result.error.reason
    assert field in reason
    assert "string" in reason.lower() or "Expected string" in reason


# ── serving round-trip ───────────────────────────────────────────────


async def _seed_signed_empty(sdk: Lhc, file_path: str) -> None:
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event(
                "user_prompt",
                {"payload": {"text": "what changed?"}},
            ),
            valid_event(
                "assistant_thinking",
                {"payload": {"text": "", "signature": "enc-fable-sig-001"}},
            ),
            valid_event(
                "assistant_text",
                {"payload": {"text": "Three files changed."}},
            ),
            valid_event("turn_end"),
        ],
    )
    if not captured.ok:
        raise RuntimeError(captured.error.reason)


@pytest.mark.asyncio
async def test_get_session_thread_view_emits_thinking_signature_on_the_thinking_part(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_signed_empty(sdk, file_path)

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    parts = _assistant_parts(view.value.entries)
    thinking = next(part for part in parts if part.type == "thinking")
    assert thinking.thinking == ""
    assert thinking.thinking_signature == "enc-fable-sig-001"


@pytest.mark.asyncio
async def test_get_llm_request_context_skips_signature_only_thinking(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    await _seed_signed_empty(sdk, file_path)

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context.ok is True
    if not context.ok:
        return
    texts = _llm_texts(context.value)
    assert not any("[thinking]" in text for text in texts)
    assert any("Three files changed." in text for text in texts)


@pytest.mark.asyncio
async def test_non_empty_thinking_text_with_signature_still_serves_on_both_exits(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "q"}}),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "visible reasoning",
                        "signature": "enc-sig-2",
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    context = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert context.ok and view.ok
    if not context.ok or not view.ok:
        return

    texts = _llm_texts(context.value)
    assert any("[thinking]\nvisible reasoning" in text for text in texts)
    parts = _assistant_parts(view.value.entries)
    assert any(
        part.type == "thinking" and part.thinking_signature == "enc-sig-2"
        for part in parts
    )


# ── model identity ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stores_provider_model_api_on_thinking_blocks_and_surfaces_on_session_view(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "q"}}),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "",
                        "signature": "enc-prov",
                        "provider": "anthropic",
                        "model": "claude-fable-5",
                        "api": "anthropic-messages",
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {
                    "payload": {
                        "text": "a",
                        "provider": "anthropic",
                        "model": "claude-fable-5",
                        "api": "anthropic-messages",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    assert thinking.blocks[0].content == {
        "text": "",
        "signature": "enc-prov",
        "provider": "anthropic",
        "model": "claude-fable-5",
        "api": "anthropic-messages",
    }
    text_row = next(row for row in listed.value if row.kind == "assistant_text")
    assert text_row.blocks[0].content == {
        "text": "a",
        "provider": "anthropic",
        "model": "claude-fable-5",
        "api": "anthropic-messages",
    }

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 1
    assert assistants[0].provider == "anthropic"
    assert assistants[0].model == "claude-fable-5"
    assert assistants[0].api == "anthropic-messages"


@pytest.mark.asyncio
async def test_synthetic_or_mismatched_identity_still_exports_verbatim(
    store: TempStore,
) -> None:
    """R2 validate: mismatched / synthetic identity still EXPORTS verbatim
    (suppression is host work, not SDK)."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "q"}}),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "",
                        "signature": "enc-synthetic",
                        "provider": "lhc",
                        "model": "thread-view",
                        "api": "synthetic",
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {
                    "payload": {
                        "text": "answer",
                        "provider": "lhc",
                        "model": "thread-view",
                        "api": "synthetic",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 1
    assert assistants[0].provider == "lhc"
    assert assistants[0].model == "thread-view"
    assert assistants[0].api == "synthetic"
    thinking = next(
        part for part in assistants[0].content if part.type == "thinking"
    )
    assert thinking.thinking_signature == "enc-synthetic"

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    text_row = next(row for row in listed.value if row.kind == "assistant_text")
    assert text_row.blocks[0].content.get("provider") == "lhc"
    assert text_row.blocks[0].content.get("model") == "thread-view"
    assert text_row.blocks[0].content.get("api") == "synthetic"


@pytest.mark.asyncio
async def test_omitted_identity_fields_stay_omitted_on_export(
    store: TempStore,
) -> None:
    """Omission semantics: no empty-valued provider/model/api on export."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "q"}}),
            valid_event(
                "assistant_thinking",
                {"payload": {"text": "t", "signature": "sig"}},
            ),
            valid_event("assistant_text", {"payload": {"text": "a"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    for key in ("provider", "model", "api"):
        assert key not in thinking.blocks[0].content

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 1
    assert assistants[0].provider is None
    assert assistants[0].model is None
    assert assistants[0].api is None


# ── identity-boundary split + history ordering ───────────────────────


@pytest.mark.asyncio
async def test_orders_thinking_level_change_between_flushed_assistant_groups(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event(
                "thinking_level_change",
                {"payload": {"previousLevel": "low", "newLevel": "high"}},
            ),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    shapes = [_entry_shape(e) for e in view.value.entries]
    assert shapes == ["user", "assistant", "thinking_level_change", "assistant"]


@pytest.mark.asyncio
async def test_splits_assistant_group_at_identity_boundary(store: TempStore) -> None:
    """Two thinking rows with different capture identities inside one
    assistant run must serve as two assistant entries, each with its own
    provenance."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan a",
                        "signature": "SIG_A",
                        "provider": "openai",
                        "model": "gpt-a",
                        "api": "responses",
                    }
                },
            ),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan b",
                        "signature": "SIG_B",
                        "provider": "openai",
                        "model": "gpt-b",
                        "api": "responses",
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "done"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 2, "identity change must split the group"
    assert assistants[0].model == "gpt-a"
    assert assistants[1].model == "gpt-b"
    assert assistants[0].content[0].thinking_signature == "SIG_A"
    assert assistants[1].content[0].thinking_signature == "SIG_B"
    # Trailing no-provenance text inherits the open (second) group.
    assert any(part.type == "text" for part in assistants[1].content)


@pytest.mark.asyncio
async def test_provider_only_conflict_splits_adjacent_rows(store: TempStore) -> None:
    """No model_change: the split must come from provenance conflict alone."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan a",
                        "signature": "SIG_A",
                        "provider": "openai",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan b",
                        "signature": "SIG_B",
                        "provider": "other",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 2, "provider-only conflict must split"
    assert assistants[0].provider == "openai"
    assert assistants[1].provider == "other"


@pytest.mark.asyncio
async def test_change_entries_stay_ordered_after_flushed_group(
    store: TempStore,
) -> None:
    """model_change lands AFTER the assistant group it interrupts
    (history order preserved)."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan a",
                        "signature": "SIG_A",
                        "provider": "openai",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event(
                "model_change",
                {
                    "payload": {
                        "previousModel": "openai/m",
                        "newModel": "other/m",
                    }
                },
            ),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan b",
                        "signature": "SIG_B",
                        "provider": "other",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    shapes = [_entry_shape(e) for e in view.value.entries]
    assert shapes == ["user", "assistant", "model_change", "assistant"], (
        "assistant(A) must precede the model_change marker"
    )
    assistants = _assistant_entries(view.value.entries)
    assert assistants[0].provider == "openai"
    assert assistants[1].provider == "other"


@pytest.mark.asyncio
async def test_present_empty_optionals_persist_verbatim_but_session_omits_them(
    store: TempStore,
) -> None:
    """Present empty strings stay on the block; session projection drops them.

    Pin: project copies when key is defined (including ""); session-view
    stringField / thinkingSignatureOf require non-empty strings.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "q"}}),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "t",
                        "signature": "",
                        "provider": "",
                        "model": "",
                        "api": "",
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {
                    "payload": {
                        "text": "a",
                        "provider": "",
                        "model": "",
                        "api": "",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    text_row = next(row for row in listed.value if row.kind == "assistant_text")
    # Exact persisted block data — empty strings present, not dropped/null.
    assert thinking.blocks[0].content == {
        "text": "t",
        "signature": "",
        "provider": "",
        "model": "",
        "api": "",
    }
    assert text_row.blocks[0].content == {
        "text": "a",
        "provider": "",
        "model": "",
        "api": "",
    }
    # Empty signature must not inflate the token estimate (pin: only non-empty).
    assert thinking.token_estimate == estimate_tokens("t")

    # SQLite message_block content is the same exact JSON object (key order
    # as projected; values verbatim empty strings).
    db = open_raw(file_path)
    try:
        block_rows = db.prepare(
            """SELECT m.kind, mb.content
               FROM message m
               JOIN message_block mb ON mb.message_id = m.message_id
               WHERE m.kind IN ('assistant_thinking', 'assistant_text')
                 AND m.deleted_at IS NULL
               ORDER BY m.source_event_order, mb.block_index"""
        ).all()
        by_kind = {str(r["kind"]): json.loads(str(r["content"])) for r in block_rows}
        assert by_kind["assistant_thinking"] == {
            "text": "t",
            "signature": "",
            "provider": "",
            "model": "",
            "api": "",
        }
        assert by_kind["assistant_text"] == {
            "text": "a",
            "provider": "",
            "model": "",
            "api": "",
        }
    finally:
        db.close()

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 1
    # Empty provenance / signature omitted on export (None = omitted).
    assert assistants[0].provider is None
    assert assistants[0].model is None
    assert assistants[0].api is None
    thinking_part = next(p for p in assistants[0].content if p.type == "thinking")
    assert thinking_part.thinking == "t"
    assert thinking_part.thinking_signature is None


@pytest.mark.asyncio
async def test_identity_fields_merge_across_thinking_and_text_rows(
    store: TempStore,
) -> None:
    """First non-empty provider/model/api across thinking then text merges.

    Mutant that only reads the first row, only the last row, or only thinking
    fails the full triple. No conflict → single assistant group.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan",
                        "signature": "SIG_MERGE",
                        "provider": "openai",
                        # model/api deliberately omitted here
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {
                    "payload": {
                        "text": "done",
                        # provider omitted — inherits thinking's
                        "model": "gpt-merge",
                        "api": "responses",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking = next(row for row in listed.value if row.kind == "assistant_thinking")
    text_row = next(row for row in listed.value if row.kind == "assistant_text")
    assert thinking.blocks[0].content == {
        "text": "plan",
        "signature": "SIG_MERGE",
        "provider": "openai",
    }
    assert "model" not in thinking.blocks[0].content
    assert "api" not in thinking.blocks[0].content
    assert text_row.blocks[0].content == {
        "text": "done",
        "model": "gpt-merge",
        "api": "responses",
    }
    assert "provider" not in text_row.blocks[0].content

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 1, "no conflict → one grouped assistant"
    assert assistants[0].provider == "openai"
    assert assistants[0].model == "gpt-merge"
    assert assistants[0].api == "responses"
    assert assistants[0].content[0].thinking_signature == "SIG_MERGE"
    assert any(part.type == "text" and part.text == "done" for part in assistants[0].content)


@pytest.mark.asyncio
async def test_thinking_text_identity_conflict_splits_and_keeps_each_provenance(
    store: TempStore,
) -> None:
    """Conflict across thinking → text (not only thinking→thinking) splits."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "assistant_thinking",
                {
                    "payload": {
                        "text": "plan a",
                        "signature": "SIG_A",
                        "provider": "openai",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {
                    "payload": {
                        "text": "answer b",
                        "provider": "other",
                        "model": "m",
                        "api": "responses",
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return
    assistants = _assistant_entries(view.value.entries)
    assert len(assistants) == 2, "thinking/text provider conflict must split"
    assert assistants[0].provider == "openai"
    assert assistants[0].content[0].thinking_signature == "SIG_A"
    assert assistants[1].provider == "other"
    assert any(part.type == "text" and part.text == "answer b" for part in assistants[1].content)


@pytest.mark.asyncio
async def test_signature_token_estimate_equals_exact_pinned_concat_estimate(
    store: TempStore,
) -> None:
    """Token estimate is estimate_tokens(text+signature), not additive or >-only.

    Pin project.ts: estimateSource = text+signature when signature non-empty;
    otherwise text alone. Vector text='a', signature='b' is non-additive under
    o200k_base: concat estimate is 1, separate estimates total 2 — so a mutant
    that sums independent counts fails exact equality.
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    text = "a"
    signature = "b"
    # Pin numbers: concatenation is the contract; additive is the mutant guard.
    expected_concat = estimate_tokens(f"{text}{signature}")
    expected_text_only = estimate_tokens(text)
    expected_sig_only = estimate_tokens(signature)
    additive_mutant = expected_text_only + expected_sig_only
    assert expected_concat == 1
    assert expected_text_only == 1
    assert expected_sig_only == 1
    assert additive_mutant == 2
    # Explicit non-additivity guard — this vector must stay non-additive or the
    # test loses power against estimate_tokens(text)+estimate_tokens(sig).
    assert expected_concat != additive_mutant

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event(
                "assistant_thinking",
                {"payload": {"text": text, "signature": signature}},
            ),
            valid_event(
                "assistant_thinking",
                {"payload": {"text": text}},
            ),
            valid_event(
                "assistant_thinking",
                {"payload": {"text": text, "signature": ""}},
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    thinking_rows = [row for row in listed.value if row.kind == "assistant_thinking"]
    assert len(thinking_rows) == 3
    signed, unsigned, empty_sig = thinking_rows
    assert signed.blocks[0].content == {"text": text, "signature": signature}
    assert unsigned.blocks[0].content == {"text": text}
    assert empty_sig.blocks[0].content == {"text": text, "signature": ""}
    # Exact concatenation pin (1), not additive mutant (2), not mere greater-than.
    assert signed.token_estimate == expected_concat == 1
    assert signed.token_estimate != additive_mutant
    assert unsigned.token_estimate == expected_text_only == 1
    # Present empty signature does not inflate (still text-only count).
    assert empty_sig.token_estimate == expected_text_only == 1
