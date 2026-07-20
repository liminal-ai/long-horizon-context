"""Ported from packages/lhc/test/threads.test.ts. Phase 1.

Flow 1: thread creation, registry, resolution (TC-1.1, 1.2, 1.3, 1.5, 1.6
plus lazy-init and read-path-equivalence supplementals). TC-1.4 is owned by
Story 2 and lives in test_intake.py.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from lhc import TOKEN_ESTIMATOR_ID, threads
from lhc.threads import ListThreadsInput, NewThreadInput, ResolveInput
from fixtures import TempStore, open_raw, temp_store


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _read_metadata(thread_path: str) -> dict[str, str]:
    db = open_raw(thread_path)
    try:
        return db.prepare("SELECT thread_id, created_at, token_estimator FROM thread_metadata").get()
    finally:
        db.close()


def _registry_rows(registry_path: str) -> list[dict[str, object]]:
    db = open_raw(registry_path)
    try:
        return db.prepare(
            "SELECT thread_id, file_path, title, created_at FROM threads ORDER BY created_at, thread_id"
        ).all()
    finally:
        db.close()


async def test_tc_1_1_create_at_a_fresh_path_file_metadata_row_registry_row(store: TempStore) -> None:
    """TC-1.1: create at a fresh path — file, metadata row, registry row"""
    thread_path = store.thread_path()
    result = await threads.new_thread(
        NewThreadInput(file_path=thread_path, title="first thread", registry_path=store.registry_path)
    )

    assert result.ok is True
    if not result.ok:
        return
    assert result.value.file_path == thread_path
    assert re.match(r"^th_[a-z0-9]+$", result.value.thread_id)
    assert Path(thread_path).exists()

    # AC-1.3: the id reads back from the file alone, no registry involved.
    metadata = _read_metadata(thread_path)
    assert metadata["thread_id"] == result.value.thread_id
    assert metadata["token_estimator"] == TOKEN_ESTIMATOR_ID
    # AC-1.3 / TS: expect(new Date(metadata.created_at).toISOString()).toBe(metadata.created_at)
    created_at = metadata["created_at"]
    parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    assert (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
        == created_at
    )

    rows = _registry_rows(store.registry_path)
    assert len(rows) == 1
    assert rows[0] == {
        "thread_id": result.value.thread_id,
        "file_path": thread_path,
        "title": "first thread",
        "created_at": metadata["created_at"],
    }


async def test_tc_1_2_occupied_path_refused_file_untouched_registry_unchanged(store: TempStore) -> None:
    """TC-1.2: occupied path refused, file untouched, registry unchanged"""
    first = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    assert first.ok is True

    occupied = str(Path(store.dir) / "occupied.bin")
    original_bytes = "pre-existing content that must survive"
    Path(occupied).write_text(original_bytes, encoding="utf-8")

    result = await threads.new_thread(
        NewThreadInput(file_path=occupied, registry_path=store.registry_path)
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "path_exists"
    assert result.error.error_class == "caller_error"

    assert Path(occupied).read_text(encoding="utf-8") == original_bytes
    assert len(_registry_rows(store.registry_path)) == 1


async def test_tc_1_3_resolve_known_id_returns_path_and_metadata_unknown_id_fails_thread_not_found(
    store: TempStore,
) -> None:
    """TC-1.3: resolve known id returns path and metadata; unknown id fails thread_not_found"""
    thread_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=thread_path, title="resolvable", registry_path=store.registry_path)
    )
    assert created.ok is True
    if not created.ok:
        return

    known = await threads.resolve(
        ResolveInput(thread_id=created.value.thread_id, registry_path=store.registry_path)
    )
    assert known.ok is True
    if not known.ok:
        return
    assert known.value.thread_id == created.value.thread_id
    assert known.value.file_path == thread_path
    assert known.value.title == "resolvable"
    assert known.value.created_at == _read_metadata(thread_path)["created_at"]

    unknown = await threads.resolve(
        ResolveInput(thread_id="th_does_not_exist", registry_path=store.registry_path)
    )
    assert unknown.ok is False
    if unknown.ok:
        return
    assert unknown.error.code == "thread_not_found"
    assert unknown.error.error_class == "caller_error"


async def test_tc_1_5_listing_returns_all_rows_absent_registry_lists_empty_without_creating_a_file(
    store: TempStore,
) -> None:
    """TC-1.5: listing returns all rows; absent registry lists empty without creating a file"""
    created: list[tuple[str, str]] = []
    for title in ["one", "two", "three"]:
        result = await threads.new_thread(
            NewThreadInput(
                file_path=store.thread_path(title),
                title=title,
                registry_path=store.registry_path,
            )
        )
        assert result.ok is True
        if result.ok:
            created.append((result.value.thread_id, result.value.file_path))

    listed = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert listed.ok is True
    if not listed.ok:
        return
    assert len(listed.value) == 3
    by_id = {info.thread_id: info for info in listed.value}
    for index, title in enumerate(["one", "two", "three"]):
        info = by_id.get(created[index][0])
        assert info is not None
        assert info.file_path == created[index][1]
        assert info.title == title
        assert info.created_at

    absent_path = str(Path(store.dir) / "never-written.sqlite")
    empty = await threads.list_threads(ListThreadsInput(registry_path=absent_path))
    assert empty.ok is True
    if not empty.ok:
        return
    assert empty.value == []
    assert Path(absent_path).exists() is False


async def test_tc_1_6_registry_insert_failure_compensates_thread_file_deleted_no_registry_no_orphan_row(
    store: TempStore,
) -> None:
    """TC-1.6: registry insert failure compensates — thread file deleted, no registry, no orphan row"""
    blocker = str(Path(store.dir) / "blocker")
    Path(blocker).write_text("a regular file where a directory must be", encoding="utf-8")
    bad_registry = str(Path(blocker) / "registry.sqlite")

    thread_path = store.thread_path()
    result = await threads.new_thread(
        NewThreadInput(file_path=thread_path, registry_path=bad_registry)
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.error_class == "system_error"
    assert result.error.code == "storage_failure"

    assert Path(thread_path).exists() is False
    assert Path(bad_registry).exists() is False
    assert Path(blocker).read_text(encoding="utf-8") == "a regular file where a directory must be"


async def test_lazy_init_supplemental_resolve_against_an_absent_registry_returns_thread_not_found_and_creates_nothing(
    store: TempStore,
) -> None:
    """lazy-init supplemental: resolve against an absent registry returns thread_not_found and creates nothing"""
    absent_path = str(Path(store.dir) / "absent-registry.sqlite")
    result = await threads.resolve(
        ResolveInput(thread_id="th_anything", registry_path=absent_path)
    )
    assert result.ok is False
    if result.ok:
        return
    assert result.error.code == "thread_not_found"
    assert Path(absent_path).exists() is False


async def test_read_path_equivalence_resolve_thread_ref_lands_id_and_path_references_on_the_same_file(
    store: TempStore,
) -> None:
    """read-path equivalence: resolveThreadRef lands id and path references on the same file"""
    thread_path = store.thread_path()
    created = await threads.new_thread(
        NewThreadInput(file_path=thread_path, registry_path=store.registry_path)
    )
    assert created.ok is True
    if not created.ok:
        return

    by_id = await threads.resolve_thread_ref(
        {"threadId": created.value.thread_id, "registryPath": store.registry_path}
    )
    by_path = await threads.resolve_thread_ref({"filePath": thread_path})
    assert by_id.ok is True
    assert by_path.ok is True
    if not by_id.ok or not by_path.ok:
        return
    assert by_id.value.file_path == thread_path
    assert by_path.value.file_path == thread_path

    # Both reads reach the same thread: identical metadata through either ref.
    assert _read_metadata(by_id.value.file_path)["thread_id"] == created.value.thread_id
    assert _read_metadata(by_path.value.file_path)["thread_id"] == created.value.thread_id

    unknown = await threads.resolve_thread_ref(
        {"threadId": "th_unknown", "registryPath": store.registry_path}
    )
    assert unknown.ok is False
    if unknown.ok:
        return
    assert unknown.error.code == "thread_not_found"
