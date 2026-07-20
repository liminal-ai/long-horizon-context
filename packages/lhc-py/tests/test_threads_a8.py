"""Ported from packages/lhc/test/threads-a8.test.ts. Phase 1.

A-8 registry additions: cwd column, partial-id resolve with ambiguity failure,
cwd-scoped listing, and deterministic most-recent ordering.
"""

from __future__ import annotations

import pytest

from lhc import threads
from lhc.threads import ListThreadsInput, NewThreadInput, ResolveInput
from fixtures import TempStore, temp_store


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _create(store: TempStore, *, title: str | None = None, cwd: str | None = None) -> str:
    result = await threads.new_thread(
        NewThreadInput(
            file_path=store.thread_path(),
            registry_path=store.registry_path,
            title=title,
            cwd=cwd,
        )
    )
    if not result.ok:
        raise RuntimeError(f"create failed: {result.error.reason}")
    return result.value.thread_id


async def test_new_thread_stores_cwd_resolve_and_list_threads_carry_it_back(store: TempStore) -> None:
    """newThread stores cwd; resolve and listThreads carry it back"""
    id_ = await _create(store, cwd="/work/project-a", title="a")

    resolved = await threads.resolve(ResolveInput(thread_id=id_, registry_path=store.registry_path))
    assert resolved.ok is True
    if resolved.ok:
        assert resolved.value.cwd == "/work/project-a"

    listed = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert listed.ok is True
    if listed.ok:
        assert listed.value[0].cwd == "/work/project-a"


async def test_a_thread_created_with_no_cwd_reports_cwd_undefined(store: TempStore) -> None:
    """a thread created with no cwd reports cwd undefined"""
    id_ = await _create(store, title="no-cwd")
    resolved = await threads.resolve(ResolveInput(thread_id=id_, registry_path=store.registry_path))
    assert resolved.ok is True
    if resolved.ok:
        assert resolved.value.cwd is None


async def test_resolves_a_unique_prefix_to_the_one_matching_thread(store: TempStore) -> None:
    """resolves a unique prefix to the one matching thread"""
    id_ = await _create(store, title="only")
    prefix = id_[:8]  # a true partial: shorter than the full id
    assert len(prefix) < len(id_)

    resolved = await threads.resolve(ResolveInput(thread_id=prefix, registry_path=store.registry_path))
    assert resolved.ok is True
    if resolved.ok:
        assert resolved.value.thread_id == id_


async def test_a_full_id_still_resolves_exactly_exact_match_path(store: TempStore) -> None:
    """a full id still resolves exactly (exact match path)"""
    id_ = await _create(store)
    resolved = await threads.resolve(ResolveInput(thread_id=id_, registry_path=store.registry_path))
    assert resolved.ok is True
    if resolved.ok:
        assert resolved.value.thread_id == id_


async def test_an_ambiguous_prefix_fails_ambiguous_thread_id_and_creates_nothing(store: TempStore) -> None:
    """an ambiguous prefix fails ambiguous_thread_id and creates nothing"""
    a = await _create(store)
    b = await _create(store)
    # Every id shares the "th_" scheme prefix, so it matches both threads.
    ambiguous = await threads.resolve(ResolveInput(thread_id="th_", registry_path=store.registry_path))
    assert ambiguous.ok is False
    if not ambiguous.ok:
        assert ambiguous.error.code == "ambiguous_thread_id"
        assert ambiguous.error.error_class == "caller_error"
        assert a in ambiguous.error.reason
        assert b in ambiguous.error.reason

    # No thread was created by the failed resolution.
    listed = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert listed.ok is True
    if listed.ok:
        assert len(listed.value) == 2


async def test_an_unresolvable_id_fails_thread_not_found_never_a_silent_match(store: TempStore) -> None:
    """an unresolvable id fails thread_not_found, never a silent match"""
    await _create(store)
    missing = await threads.resolve(
        ResolveInput(thread_id="th_zzzzzzzzzzzzzzzz", registry_path=store.registry_path)
    )
    assert missing.ok is False
    if not missing.ok:
        assert missing.error.code == "thread_not_found"


async def test_like_metacharacters_in_a_partial_id_match_literally_not_as_wildcards(store: TempStore) -> None:
    """LIKE metacharacters in a partial id match literally, not as wildcards"""
    await _create(store)
    await _create(store)
    # "_" is a LIKE single-char wildcard; unescaped it would match every id
    # (all begin "th_..."). Escaped, "th%" / "_" must be treated literally and
    # match nothing, since no id literally contains "%" or begins "th_%".
    pct = await threads.resolve(ResolveInput(thread_id="th%", registry_path=store.registry_path))
    assert pct.ok is False
    if not pct.ok:
        assert pct.error.code == "thread_not_found"


async def test_list_threads_cwd_returns_only_that_cwds_threads(store: TempStore) -> None:
    """listThreads({cwd}) returns only that cwd's threads"""
    a1 = await _create(store, cwd="/work/a")
    a2 = await _create(store, cwd="/work/a")
    await _create(store, cwd="/work/b")

    scoped = await threads.list_threads(
        ListThreadsInput(cwd="/work/a", registry_path=store.registry_path)
    )
    assert scoped.ok is True
    if scoped.ok:
        assert len(scoped.value) == 2
        assert {t.thread_id for t in scoped.value} == {a1, a2}
        for t in scoped.value:
            assert t.cwd == "/work/a"

    all_ = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert all_.ok is True
    if all_.ok:
        assert len(all_.value) == 3


async def test_an_empty_cwd_lists_nothing_without_failing(store: TempStore) -> None:
    """an empty cwd lists nothing without failing"""
    await _create(store, cwd="/work/a")
    empty = await threads.list_threads(
        ListThreadsInput(cwd="/elsewhere", registry_path=store.registry_path)
    )
    assert empty.ok is True
    if empty.ok:
        assert empty.value == []


async def test_the_last_listed_thread_is_the_most_recently_created_insertion_order_tie_break(
    store: TempStore,
) -> None:
    """the last listed thread is the most recently created (insertion-order tie-break)"""
    await _create(store, title="first")
    await _create(store, title="second")
    last = await _create(store, title="third")

    listed = await threads.list_threads(ListThreadsInput(registry_path=store.registry_path))
    assert listed.ok is True
    if listed.ok:
        assert len(listed.value) == 3
        assert listed.value[-1].thread_id == last
