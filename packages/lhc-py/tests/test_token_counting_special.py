"""R5 — literal special-token strings count on capture and slice paths (pin 81cd48c)."""

from __future__ import annotations

import pytest

from lhc import intake_stream, messages, threads
from lhc.shared_tech.token_counting import estimate_tokens, slice_tokens
from lhc.threads import NewThreadInput
from fixtures import TempStore, temp_store, valid_event


HOSTILE = "before <|endoftext|> after <|fim_prefix|> tail"


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _create_thread(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


def test_estimate_tokens_counts_literal_special_token_text() -> None:
    assert estimate_tokens(HOSTILE) > 0


def test_estimate_tokens_empty_and_plain_text() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("ordinary text") > 0


def test_slice_tokens_slices_and_reassembles_byte_identically() -> None:
    total = estimate_tokens(HOSTILE)
    first = slice_tokens(HOSTILE, 0, 3)
    second = slice_tokens(HOSTILE, first.to_token, total - first.to_token)
    assert first.total_tokens == total
    assert first.text + second.text == HOSTILE


async def test_intake_materializes_special_token_text_with_total_token_estimate(
    store: TempStore,
) -> None:
    """Real intake path: literal special-token strings must count, never rollback."""
    file_path = await _create_thread(store)
    result = await intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": HOSTILE}}),
            valid_event("turn_end"),
        ],
    )
    assert result.ok is True

    listed = await messages.list({"filePath": file_path})
    assert listed.ok is True
    assert len(listed.value) == 1
    assert listed.value[0].token_estimate == estimate_tokens(HOSTILE)
    assert listed.value[0].token_estimate > 0
