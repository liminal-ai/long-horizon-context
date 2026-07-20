"""Ported from packages/lhc/src/threads/index.ts. Phase 1 skeleton.

Thread creation, registry resolution, list, info, and ThreadRef interpretation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import NotRequired, TypedDict, Union

from ..shared_tech.errors import ErrorResult, OpErr, OpOk, OpResult, storage_failure
# LAYERING CONSTRAINT (load-bearing): import shared_tech SUBMODULES only,
# never `from ..shared_tech import ...` — persist.py imports this domain,
# and a package-level import here would deadlock that cycle. See persist.py.
from .internal.create import (
    create_thread_file,
    delete_thread_file,
    generate_thread_id,
    open_thread_database,
)
from .internal.registry import (
    RegistryRow,
    SelectAllThreadRowsOpts,
    insert_thread_row,
    open_registry_for_read,
    open_registry_for_write,
    resolve_registry_path,
    select_all_thread_rows,
    select_thread_row,
    select_thread_rows_by_prefix,
)

__all__ = [
    "ListThreadsInput",
    "NewThreadInput",
    "NewThreadResult",
    "ResolveInput",
    "ResolvedThreadPath",
    "ThreadFileInfo",
    "ThreadInfo",
    "ThreadRef",
    "ThreadRefById",
    "ThreadRefByPath",
    "info",
    "list_threads",
    "new_thread",
    "open_thread_database",
    "resolve",
    "resolve_thread_ref",
]


class ThreadRefById(TypedDict):
    threadId: str
    registryPath: NotRequired[str]


class ThreadRefByPath(TypedDict):
    filePath: str


ThreadRef = Union[ThreadRefById, ThreadRefByPath]


@dataclass(frozen=True, slots=True)
class NewThreadInput:
    file_path: str
    title: str | None = None
    cwd: str | None = None
    registry_path: str | None = None


@dataclass(frozen=True, slots=True)
class ResolveInput:
    thread_id: str
    registry_path: str | None = None


@dataclass(frozen=True, slots=True)
class ListThreadsInput:
    cwd: str | None = None
    registry_path: str | None = None


@dataclass(frozen=True, slots=True)
class ThreadInfo:
    thread_id: str
    file_path: str
    created_at: str
    title: str | None = None
    cwd: str | None = None


@dataclass(frozen=True, slots=True)
class NewThreadResult:
    thread_id: str
    file_path: str


@dataclass(frozen=True, slots=True)
class ThreadFileInfo:
    thread_id: str
    created_at: str


@dataclass(frozen=True, slots=True)
class ResolvedThreadPath:
    file_path: str


def _to_thread_info(row: RegistryRow) -> ThreadInfo:
    return ThreadInfo(
        thread_id=row.thread_id,
        file_path=row.file_path,
        created_at=row.created_at,
        title=row.title,
        cwd=row.cwd,
    )


def _thread_not_found(thread_id: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="thread_not_found",
            reason=f"no thread registered with id {thread_id}",
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


def _is_blank_path(file_path: str) -> bool:
    return file_path.strip() == ""


def _detail(cause: object) -> str:
    return str(cause)


def _iso_millis(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _config_get(value: object, snake: str, camel: str) -> object:
    """TS plain objects use camelCase; Python dataclasses use snake_case."""
    if isinstance(value, dict):
        if camel in value:
            return value[camel]
        return value.get(snake)
    return getattr(value, snake, None)


def _coerce_new_thread_input(input: NewThreadInput | dict[str, object]) -> NewThreadInput:
    if isinstance(input, NewThreadInput):
        return input
    file_path = _config_get(input, "file_path", "filePath")
    if not isinstance(file_path, str):
        file_path = "" if file_path is None else str(file_path)
    title = _config_get(input, "title", "title")
    cwd = _config_get(input, "cwd", "cwd")
    registry_path = _config_get(input, "registry_path", "registryPath")
    return NewThreadInput(
        file_path=file_path,
        title=title if isinstance(title, str) or title is None else str(title),
        cwd=cwd if isinstance(cwd, str) or cwd is None else str(cwd),
        registry_path=(
            registry_path
            if isinstance(registry_path, str) or registry_path is None
            else str(registry_path)
        ),
    )


def _coerce_resolve_input(input: ResolveInput | dict[str, object]) -> ResolveInput:
    if isinstance(input, ResolveInput):
        return input
    thread_id = _config_get(input, "thread_id", "threadId")
    registry_path = _config_get(input, "registry_path", "registryPath")
    return ResolveInput(
        thread_id="" if thread_id is None else str(thread_id),
        registry_path=(
            registry_path
            if isinstance(registry_path, str) or registry_path is None
            else str(registry_path)
        ),
    )


def _coerce_list_threads_input(
    input: ListThreadsInput | dict[str, object] | None,
) -> ListThreadsInput | None:
    if input is None or isinstance(input, ListThreadsInput):
        return input
    cwd = _config_get(input, "cwd", "cwd")
    registry_path = _config_get(input, "registry_path", "registryPath")
    return ListThreadsInput(
        cwd=cwd if isinstance(cwd, str) or cwd is None else str(cwd),
        registry_path=(
            registry_path
            if isinstance(registry_path, str) or registry_path is None
            else str(registry_path)
        ),
    )


async def new_thread(input: NewThreadInput | dict[str, object]) -> OpResult[NewThreadResult]:
    input = _coerce_new_thread_input(input)
    if _is_blank_path(input.file_path):
        return _invalid_thread_ref("filePath must be a non-empty path; received a blank string")
    if Path(input.file_path).exists():
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="path_exists",
                reason=f"a file already exists at {input.file_path}",
            )
        )

    thread_id = generate_thread_id()
    created_at = _iso_millis(datetime.now(timezone.utc))

    try:
        create_thread_file(input.file_path, thread_id, created_at)
    except BaseException as cause:
        delete_thread_file(input.file_path)
        return storage_failure(f"thread file creation failed: {_detail(cause)}")

    registry = None
    try:
        registry = open_registry_for_write(resolve_registry_path(input.registry_path))
        insert_thread_row(
            registry,
            RegistryRow(
                thread_id=thread_id,
                file_path=input.file_path,
                created_at=created_at,
                title=input.title,
                cwd=input.cwd,
            ),
        )
    except BaseException as cause:
        delete_thread_file(input.file_path)
        return storage_failure(f"registry insert failed: {_detail(cause)}")
    finally:
        if registry is not None:
            registry.close()

    return OpOk(NewThreadResult(thread_id=thread_id, file_path=input.file_path))


async def resolve(input: ResolveInput | dict[str, object]) -> OpResult[ThreadInfo]:
    input = _coerce_resolve_input(input)
    registry = None
    try:
        registry = open_registry_for_read(resolve_registry_path(input.registry_path))
        if registry is None:
            return _thread_not_found(input.thread_id)
        exact = select_thread_row(registry, input.thread_id)
        if exact is not None:
            return OpOk(_to_thread_info(exact))
        matches = select_thread_rows_by_prefix(registry, input.thread_id)
        if len(matches) == 1:
            return OpOk(_to_thread_info(matches[0]))
        if len(matches) > 1:
            return _ambiguous_thread_id(input.thread_id, [match.thread_id for match in matches])
        return _thread_not_found(input.thread_id)
    except BaseException as cause:
        return storage_failure(f"registry read failed: {_detail(cause)}")
    finally:
        if registry is not None:
            registry.close()


async def list_threads(
    input: ListThreadsInput | dict[str, object] | None = None,
) -> OpResult[list[ThreadInfo]]:
    input = _coerce_list_threads_input(input)
    registry = None
    try:
        registry = open_registry_for_read(
            resolve_registry_path(None if input is None else input.registry_path)
        )
        if registry is None:
            return OpOk([])
        opts = (
            SelectAllThreadRowsOpts()
            if input is None or input.cwd is None
            else SelectAllThreadRowsOpts(cwd=input.cwd)
        )
        return OpOk([_to_thread_info(row) for row in select_all_thread_rows(registry, opts)])
    except BaseException as cause:
        return storage_failure(f"registry read failed: {_detail(cause)}")
    finally:
        if registry is not None:
            registry.close()


async def info(ref: ThreadRef) -> OpResult[ThreadFileInfo]:
    # Imported here to preserve the sanctioned persist <-> threads cycle.
    from ..shared_tech.persist import DbReadTransaction, create_db_read_transaction

    def _read(transaction: DbReadTransaction) -> OpResult[ThreadFileInfo]:
        row = transaction.db.prepare(
            "SELECT thread_id, created_at FROM thread_metadata WHERE id = 1"
        ).get()
        if row is None:
            return storage_failure(
                f"thread file at {transaction.file_path} lost its metadata row"
            )
        return OpOk(
            ThreadFileInfo(
                thread_id=str(row["thread_id"]),
                created_at=str(row["created_at"]),
            )
        )

    try:
        result = await create_db_read_transaction(ref, _read)
        return result.value if result.ok else result
    except BaseException as cause:
        return storage_failure(f"thread info read failed: {_detail(cause)}")


async def resolve_thread_ref(ref: ThreadRef) -> OpResult[ResolvedThreadPath]:
    if "threadId" in ref:
        resolved = await resolve(
            ResolveInput(
                thread_id=ref["threadId"],
                registry_path=ref.get("registryPath"),
            )
        )
        if not resolved.ok:
            return resolved
        return OpOk(ResolvedThreadPath(file_path=resolved.value.file_path))
    file_path = ref["filePath"]
    if _is_blank_path(file_path):
        return _invalid_thread_ref("filePath must be a non-empty path; received a blank string")
    return OpOk(ResolvedThreadPath(file_path=file_path))
