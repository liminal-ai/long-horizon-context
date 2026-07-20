"""Ported from packages/lhc/test/view-render-targets.test.ts. Phase 1.

Epic 03 Story 5: render targets (TC-5.1, TC-5.2, TC-5.3, TC-5.5).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from lhc import init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    LlmRequestContextMessage,
    LlmRequestContextPart,
    PartialViewProfilePercentages,
    ViewCompactParams,
)
from lhc.thread_view import CompactOpts, MaterializeOpts
from fixtures import (
    DerivedThreadFixture,
    TempStore,
    assert_pi_session_conformance,
    create_inference_callbacks_double,
    derived_thread_fixture,
    event_batch,
    open_raw,
    temp_store,
)

GRADIENT_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=16, detailed=10, brief=49),
)


def _sha256(value: str | bytes) -> str:
    if isinstance(value, str):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
    return hashlib.sha256(value).hexdigest()


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


def _db_rows(db, sql: str) -> list[dict[str, object]]:
    return [dict(row) for row in db.prepare(sql).all()]


def _full_state_hash(file_path: str) -> str:
    db = open_raw(file_path)
    try:
        payload = {
            "events": _db_rows(db, "SELECT * FROM event ORDER BY event_order"),
            "messages": _db_rows(db, "SELECT * FROM message ORDER BY source_event_order"),
            "blocks": _db_rows(db, "SELECT * FROM message_block ORDER BY message_id, block_index"),
            "turns": _db_rows(db, "SELECT * FROM turns ORDER BY turn_order"),
            "chunks": _db_rows(db, "SELECT * FROM chunk ORDER BY chunk_order"),
            "members": _db_rows(db, "SELECT * FROM chunk_member ORDER BY chunk_id, member_idx"),
            "derivations": _db_rows(
                db,
                "SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
            ),
            "views": _db_rows(db, "SELECT * FROM thread_view"),
            "bands": _db_rows(db, "SELECT * FROM thread_view_band ORDER BY band"),
            "boundary": _db_rows(db, "SELECT * FROM view_boundary"),
            "work": _db_rows(db, "SELECT * FROM work_item ORDER BY work_item_id"),
        }
        return _sha256(_json_stringify(payload))
    finally:
        db.close()


@dataclass(frozen=True, slots=True)
class _SessionFile:
    text: str
    header: dict[str, object]
    entries: list[dict[str, object]]


def _read_session_file(path: str) -> _SessionFile:
    text = Path(path).read_text(encoding="utf-8")
    lines = [line for line in text.split("\n") if line != ""]
    header = json.loads(lines[0] if lines else "{}")
    entries = [json.loads(line) for line in lines[1:]]
    return _SessionFile(text=text, header=header, entries=entries)


def _message_text(message: LlmRequestContextMessage | None) -> str | None:
    if message is None:
        return None
    return "".join(part.text for part in message.content)


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


async def test_bands_brief_detailed_smooth_with_labels_then_the_tail_repeated_contexts_byte_identical(
    fixture: DerivedThreadFixture,
) -> None:
    """bands brief → detailed → smooth with labels, then the tail; repeated contexts byte-identical"""
    ref = {"filePath": fixture.file_path}
    compacted = await fixture.sdk.thread_view.compact(ref, CompactOpts(params=GRADIENT_PARAMS))
    assert compacted.ok is True

    first = await fixture.sdk.thread_view.get_llm_request_context(ref)
    assert first.ok is True
    if not first.ok:
        return
    messages = first.value.messages
    texts = [_message_text(message) for message in messages]

    band_texts = [text for text in texts if text and text.startswith("[context ·")]
    assert [
        (m.group(1) if (m := re.match(r"^\[context · ([^\]]+)\]", text or "")) else None)
        for text in band_texts
    ] == ["brief", "detailed", "smooth"]
    for i in range(len(band_texts)):
        assert messages[i].role == "user"
    assert texts[: len(band_texts)] == band_texts

    tail = messages[len(band_texts) :]
    tail_texts = [_message_text(message) for message in tail]
    assert tail[0] == LlmRequestContextMessage(
        role="user",
        content=[LlmRequestContextPart(type="text", text="turn 9: please investigate area 9")],
    )
    prompts = [
        text.split(":")[0]
        for text in tail_texts
        if text and text.startswith("turn ")
    ]
    assert prompts == ["turn 9", "turn 10", "turn 11", "turn 12"]
    for m in tail:
        text = _message_text(m) or ""
        if text.startswith("[tool call") or text.startswith("[thinking]"):
            assert m.role == "assistant"
        if text.startswith("[tool result"):
            assert m.role == "user"

    second = await fixture.sdk.thread_view.get_llm_request_context(ref)
    assert second.ok is True
    if not second.ok:
        return
    assert _json_stringify(second.value) == _json_stringify(first.value)


async def test_every_model_context_message_appears_in_the_file_same_order_same_text_repeat_is_byte_identical_state_hash_unchanged(
    fixture: DerivedThreadFixture,
    store: TempStore,
) -> None:
    """every model-context message appears in the file, same order, same text; repeat is byte-identical; state hash unchanged"""
    ref = {"filePath": fixture.file_path}
    compacted = await fixture.sdk.thread_view.compact(ref, CompactOpts(params=GRADIENT_PARAMS))
    assert compacted.ok is True
    context_messages = await fixture.sdk.thread_view.get_llm_request_context(ref)
    assert context_messages.ok is True
    if not context_messages.ok:
        return

    before = _full_state_hash(fixture.file_path)
    out_path = str(Path(store.dir) / "render-parity.jsonl")
    materialized = await fixture.sdk.thread_view.materialize(ref, MaterializeOpts(path=out_path))
    assert materialized.ok is True
    if not materialized.ok:
        return
    assert materialized.value.written_path == out_path

    file = _read_session_file(out_path)
    entries = file.entries
    assert isinstance(entries, list)
    assert len(entries) == len(context_messages.value.messages)
    for i, entry in enumerate(entries):
        source = context_messages.value.messages[i]
        assert entry["message"]["role"] == source.role
        assert entry["message"]["content"] == _to_jsonable(source.content)

    described = await fixture.sdk.thread_view.describe(ref)
    assert described.ok is True
    if not described.ok or described.value is None:
        return
    assert entries[0]["timestamp"] == described.value.created_at
    assert entries[0]["id"] == f"{described.value.view_id}-brief"
    assert file.header["timestamp"] == described.value.created_at  # type: ignore[index]

    again = await fixture.sdk.thread_view.materialize(ref, MaterializeOpts(path=out_path))
    assert again.ok is True
    assert _sha256(Path(out_path).read_bytes()) == _sha256(file.text.encode("utf-8"))

    assert _full_state_hash(fixture.file_path) == before


async def test_rejects_an_unknown_format_naming_the_accepted_values_writing_nothing(
    fixture: DerivedThreadFixture,
    store: TempStore,
) -> None:
    """rejects an unknown format naming the accepted values, writing nothing"""
    out_path = Path(store.dir) / "never-written.jsonl"
    result = await fixture.sdk.thread_view.materialize(
        {"filePath": fixture.file_path},
        MaterializeOpts(path=str(out_path), format="markdown"),  # type: ignore[arg-type]
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "unknown_format"
    assert "pi-session" in result.error.reason
    with pytest.raises((OSError, FileNotFoundError)):
        out_path.read_text(encoding="utf-8")


async def test_valid_file_tail_only_content_loadable_against_the_format_fixture_header_from_the_threads_created_at(
    store: TempStore,
) -> None:
    """valid file, tail-only content, loadable against the format fixture, header from the thread's created-at"""
    sdk = init_lhc(SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual"))
    file_path = store.thread_path("never-compacted")
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    assert created.ok is True
    seeded = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            *event_batch(["user_prompt", "assistant_text", "turn_end"]),
            *event_batch(["user_prompt", "assistant_text"]),
        ],
    )
    assert seeded.ok is True

    out_path = str(Path(store.dir) / "tail-only.jsonl")
    materialized = await sdk.thread_view.materialize(
        {"filePath": file_path}, MaterializeOpts(path=out_path)
    )
    assert materialized.ok is True

    file = _read_session_file(out_path)
    assert_pi_session_conformance(file.text)

    context_messages = await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    assert context_messages.ok is True
    if not context_messages.ok:
        return
    described = await sdk.thread_view.describe({"filePath": file_path})
    assert described.ok is True
    if not described.ok:
        return
    assert described.value is None
    entries = file.entries
    assert isinstance(entries, list)
    assert len(entries) == 4
    assert all(
        not entry["message"]["content"][0]["text"].startswith("[context ·")
        for entry in entries
    )
    for i, entry in enumerate(entries):
        assert entry["message"]["content"] == _to_jsonable(
            context_messages.value.messages[i].content
        )

    db = open_raw(file_path)
    try:
        meta = db.prepare(
            "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1"
        ).get()
        assert meta is not None
    finally:
        db.close()
    assert file.header["timestamp"] == meta["created_at"]  # type: ignore[index]
    assert file.header["id"] == f"{meta['thread_id']}:{meta['created_at']}"  # type: ignore[index]


async def test_header_line_entry_shape_parentid_chain_message_encoding_all_validate(
    fixture: DerivedThreadFixture,
    store: TempStore,
) -> None:
    """header line, entry shape, parentId chain, message encoding all validate"""
    ref = {"filePath": fixture.file_path}
    compacted = await fixture.sdk.thread_view.compact(ref, CompactOpts(params=GRADIENT_PARAMS))
    assert compacted.ok is True
    out_path = str(Path(store.dir) / "conformance.jsonl")
    materialized = await fixture.sdk.thread_view.materialize(ref, MaterializeOpts(path=out_path))
    assert materialized.ok is True

    file = _read_session_file(out_path)
    assert_pi_session_conformance(file.text)

    entries = file.entries
    assert isinstance(entries, list)
    assert entries[0]["parentId"] is None
    for i in range(1, len(entries)):
        assert entries[i]["parentId"] == entries[i - 1]["id"]
