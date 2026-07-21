"""Ported from packages/lhc/src/shared-tech/persist.ts.

LAYERING NOTE: this module imports the threads domain — faithful to the TS,
where persist.ts is the sanctioned exception to "shared-tech may not import
the domains" (derivation.ts comment). The resulting shared_tech <-> threads
cycle survives ONLY because threads/__init__ imports shared_tech SUBMODULES
directly (e.g. `from ..shared_tech.errors import ...`), never the package.
That constraint is load-bearing; see the matching note in threads/__init__.
"""

from __future__ import annotations

import inspect
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol, TypeVar, cast

from ..threads import ThreadRef
from ..threads.internal.create import open_thread_database
from ..threads.internal.registry import (
    open_registry_for_read,
    resolve_registry_path,
    select_thread_row,
    select_thread_rows_by_prefix,
)
from .context import resolve_instance_poke, run_with_thread_touch_suppressed
from .errors import ErrorResult, OpErr, OpOk, OpResult, storage_failure
from .storage import Database

T = TypeVar("T")


class PostCommitHook(Protocol):
    def add(self, operation: Callable[[], None]) -> None: ...


class PostCommitHookSet(Protocol):
    def add(self, operation: Callable[[], None]) -> None: ...

    def flush(self) -> None: ...


@dataclass(frozen=True, slots=True)
class DbReadTransaction:
    db: Database
    thread_id: str
    file_path: str


@dataclass(frozen=True, slots=True)
class DbWriteTransaction:
    db: Database
    thread_id: str
    file_path: str
    clock: Callable[[], datetime]
    post_commit_hook: PostCommitHook
    poke: Callable[[str], None]


def create_post_commit_hook_set() -> PostCommitHookSet:
    operations: list[Callable[[], None]] = []

    class _HookSet:
        def add(self, operation: Callable[[], None]) -> None:
            operations.append(operation)

        def flush(self) -> None:
            while operations:
                operations.pop(0)()

    return _HookSet()


def _thread_not_found(thread_id: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="thread_not_found",
            reason=f"no thread registered with id {thread_id}",
        )
    )


def _file_not_found(file_path: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="thread_not_found",
            reason=f"no thread file exists at {file_path}",
        )
    )


def _ambiguous_thread_id(prefix: str, match_ids: tuple[str, ...] | list[str]) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="ambiguous_thread_id",
            reason=(
                f'thread id "{prefix}" is ambiguous: it matches {len(match_ids)} threads '
                f"({', '.join(match_ids)}); use a longer id"
            ),
        )
    )


def _invalid_thread_ref(reason: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="invalid_thread_ref",
            reason=reason,
        )
    )


def _detail(cause: object) -> str:
    return str(cause)


def _is_blank_path(file_path: str) -> bool:
    return file_path.strip() == ""


_MISSING = object()


def _ref_member(thread_ref: object, camel_name: str, snake_name: str) -> object:
    if isinstance(thread_ref, dict):
        camel_value = thread_ref.get(camel_name, _MISSING)
        if camel_value is not _MISSING:
            return camel_value
        return thread_ref.get(snake_name, _MISSING)
    camel_value = getattr(thread_ref, camel_name, _MISSING)
    if camel_value is not _MISSING:
        return camel_value
    return getattr(thread_ref, snake_name, _MISSING)


async def _resolve_thread_file(thread_ref: ThreadRef) -> OpResult[dict[str, str]]:
    file_path_value = _ref_member(thread_ref, "filePath", "file_path")
    if file_path_value is not _MISSING:
        file_path = cast(str, file_path_value)
        if _is_blank_path(file_path):
            return _invalid_thread_ref("filePath must be a non-empty path; received a blank string")
        return OpOk({"filePath": file_path})

    thread_id = cast(str, _ref_member(thread_ref, "threadId", "thread_id"))
    registry_path_value = _ref_member(thread_ref, "registryPath", "registry_path")
    registry_path = None if registry_path_value is _MISSING else cast(str | None, registry_path_value)
    registry: Database | None = None
    try:
        registry = open_registry_for_read(resolve_registry_path(registry_path))
        if registry is None:
            return _thread_not_found(thread_id)
        exact = select_thread_row(registry, thread_id)
        if exact is not None:
            return OpOk({"filePath": exact.file_path})
        matches = select_thread_rows_by_prefix(registry, thread_id)
        if len(matches) == 1:
            return OpOk({"filePath": matches[0].file_path})
        if len(matches) > 1:
            return _ambiguous_thread_id(thread_id, [match.thread_id for match in matches])
        return _thread_not_found(thread_id)
    except BaseException as cause:
        return storage_failure(f"registry read failed: {_detail(cause)}")
    finally:
        if registry is not None:
            registry.close()


def _read_thread_id(db: Database, file_path: str) -> OpResult[str]:
    try:
        row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get()
        if row is None:
            return storage_failure(f"thread file at {file_path} lost its metadata row")
        return OpOk(str(row["thread_id"]))
    except BaseException as cause:
        return storage_failure(f"thread metadata read failed: {_detail(cause)}")


async def create_db_read_transaction(
    thread_ref: ThreadRef,
    operation: Callable[[DbReadTransaction], T | Awaitable[T]],
) -> OpResult[T]:
    async def _run() -> OpResult[T]:
        resolved = await _resolve_thread_file(thread_ref)
        if not resolved.ok:
            return resolved
        file_path = resolved.value["filePath"]
        if not os.path.exists(file_path):
            return _file_not_found(file_path)
        opened = open_thread_database(file_path)
        if not opened.ok:
            return opened
        db = opened.value
        try:
            db.exec("BEGIN;")
            thread_id = _read_thread_id(db, file_path)
            if not thread_id.ok:
                db.exec("ROLLBACK;")
                return thread_id
            value = operation(
                DbReadTransaction(db=db, thread_id=thread_id.value, file_path=file_path)
            )
            if inspect.isawaitable(value):
                value = await cast(Awaitable[T], value)
            db.exec("COMMIT;")
            return OpOk(cast(T, value))
        except BaseException:
            try:
                db.exec("ROLLBACK;")
            except BaseException:
                pass
            raise
        finally:
            try:
                db.close()
            except BaseException:
                pass

    return await cast(Awaitable[OpResult[T]], run_with_thread_touch_suppressed(_run))


async def create_db_write_transaction(
    thread_ref: ThreadRef,
    operation: Callable[[DbWriteTransaction], T | Awaitable[T]],
    clock: Callable[[], datetime] | None = None,
) -> OpResult[T]:
    resolved = await _resolve_thread_file(thread_ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value["filePath"]
    if not os.path.exists(file_path):
        return _file_not_found(file_path)
    opened = open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    post_commit_hook = create_post_commit_hook_set()
    resolved_clock = clock if clock is not None else lambda: datetime.now(timezone.utc)
    try:
        thread_id = _read_thread_id(db, file_path)
        if not thread_id.ok:
            return thread_id
        db.exec("BEGIN IMMEDIATE;")
        try:
            value = operation(
                DbWriteTransaction(
                    db=db,
                    thread_id=thread_id.value,
                    file_path=file_path,
                    clock=resolved_clock,
                    post_commit_hook=post_commit_hook,
                    poke=resolve_instance_poke(),
                )
            )
            if inspect.isawaitable(value):
                value = await cast(Awaitable[T], value)
            db.exec("COMMIT;")
        except BaseException:
            try:
                db.exec("ROLLBACK;")
            except BaseException:
                pass
            raise
        post_commit_hook.flush()
        return OpOk(cast(T, value))
    finally:
        try:
            db.close()
        except BaseException:
            pass
