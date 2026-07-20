"""Ported from packages/lhc/test/epic-fix.test.ts. Phase 1.

Epic Fix Batch 1: blank-path rejection (F-EPIC-001), read-surface reference
validation (F-EPIC-002), and strict CLI flag parsing (NB-2). New Green-phase
suite — the Red-committed files stay byte-identical.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

from lhc import intake_stream, messages, threads, turns
from lhc.shared_tech.errors import OpResult
from lhc.threads import ListThreadsInput, NewThreadInput, ThreadRef
from fixtures import TempStore, temp_store


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


@dataclass(frozen=True, slots=True)
class _ReadSurface:
    name: str
    call: Callable[[ThreadRef], Awaitable[OpResult[object]]]


_READ_SURFACES: list[_ReadSurface] = [
    _ReadSurface(name="intakeStream.listEvents", call=lambda ref: intake_stream.list_events(ref)),
    _ReadSurface(name="messages.list", call=lambda ref: messages.list(ref)),
    _ReadSurface(name="turns.listTurns", call=lambda ref: turns.list_turns(ref)),
]


async def test_new_thread_file_path_empty_caller_error_nothing_created_no_registry_row(
    store: TempStore,
) -> None:
    """newThread({ filePath: '' }) → caller_error, nothing created, no registry row"""
    result = await threads.new_thread(
        NewThreadInput(file_path="", registry_path=store.registry_path)
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_thread_ref"

    assert Path(store.registry_path).exists() is False
    listed = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert listed.ok is True
    if listed.ok:
        assert listed.value == []


async def test_new_thread_with_a_whitespace_only_path_is_refused_the_same_way(
    store: TempStore,
) -> None:
    """newThread with a whitespace-only path is refused the same way"""
    result = await threads.new_thread(
        NewThreadInput(file_path="   ", registry_path=store.registry_path)
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_thread_ref"
    assert Path(store.registry_path).exists() is False


async def test_resolve_thread_ref_file_path_empty_fails_closed_with_caller_error(
    store: TempStore,
) -> None:
    """resolveThreadRef({ filePath: '' }) fails closed with caller_error"""
    result = await threads.resolve_thread_ref({"filePath": ""})
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "caller_error"
    assert result.error.code == "invalid_thread_ref"


def _make_empty_path_test(surface: _ReadSurface):
    async def _test(store: TempStore) -> None:
        result = await surface.call({"filePath": ""})
        assert result.ok is False
        if result.ok:
            return
        assert result.error.error_class == "caller_error"

    _test.__name__ = f"test_{surface.name.replace('.', '_')}_empty_path_caller_error_no_storage_open"
    _test.__doc__ = f"{surface.name}: empty path → caller_error (no storage open)"
    return _test


def _make_unknown_id_test(surface: _ReadSurface):
    async def _test(store: TempStore) -> None:
        result = await surface.call(
            {"threadId": "th_unknown", "registryPath": store.registry_path}
        )
        assert result.ok is False
        if result.ok:
            return
        assert result.error.error_class == "caller_error"
        assert result.error.code == "thread_not_found"

    _test.__name__ = f"test_{surface.name.replace('.', '_')}_unknown_id_thread_not_found"
    _test.__doc__ = f"{surface.name}: unknown id → thread_not_found"
    return _test


test_intake_stream_list_events_empty_path_caller_error_no_storage_open = _make_empty_path_test(
    _READ_SURFACES[0]
)
test_messages_list_empty_path_caller_error_no_storage_open = _make_empty_path_test(
    _READ_SURFACES[1]
)
test_turns_list_turns_empty_path_caller_error_no_storage_open = _make_empty_path_test(
    _READ_SURFACES[2]
)

test_intake_stream_list_events_unknown_id_thread_not_found = _make_unknown_id_test(
    _READ_SURFACES[0]
)
test_messages_list_unknown_id_thread_not_found = _make_unknown_id_test(_READ_SURFACES[1])
test_turns_list_turns_unknown_id_thread_not_found = _make_unknown_id_test(_READ_SURFACES[2])
