"""Ported from packages/lhc/src/shared-tech/persist.ts. Phase 1 skeleton.

LAYERING NOTE: this module imports the threads domain — faithful to the TS,
where persist.ts is the sanctioned exception to "shared-tech may not import
the domains" (derivation.ts comment). The resulting shared_tech <-> threads
cycle survives ONLY because threads/__init__ imports shared_tech SUBMODULES
directly (e.g. `from ..shared_tech.errors import ...`), never the package.
That constraint is load-bearing; see the matching note in threads/__init__.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, TypeVar

from ..threads import ThreadRef
from ..threads.internal.create import open_thread_database
from ..threads.internal.registry import (
    open_registry_for_read,
    resolve_registry_path,
    select_thread_row,
    select_thread_rows_by_prefix,
)
from .context import resolve_instance_poke, run_with_thread_touch_suppressed
from .errors import ErrorResult, OpErr, OpResult, storage_failure
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
    raise NotImplementedError


def _thread_not_found(thread_id: str) -> OpErr:
    raise NotImplementedError


def _file_not_found(file_path: str) -> OpErr:
    raise NotImplementedError


def _ambiguous_thread_id(prefix: str, match_ids: tuple[str, ...] | list[str]) -> OpErr:
    raise NotImplementedError


def _invalid_thread_ref(reason: str) -> OpErr:
    raise NotImplementedError


def _detail(cause: object) -> str:
    raise NotImplementedError


def _is_blank_path(file_path: str) -> bool:
    raise NotImplementedError


async def _resolve_thread_file(thread_ref: ThreadRef) -> OpResult[dict[str, str]]:
    raise NotImplementedError


def _read_thread_id(db: Database, file_path: str) -> OpResult[str]:
    raise NotImplementedError


async def create_db_read_transaction(
    thread_ref: ThreadRef,
    operation: Callable[[DbReadTransaction], T | Awaitable[T]],
) -> OpResult[T]:
    raise NotImplementedError


async def create_db_write_transaction(
    thread_ref: ThreadRef,
    operation: Callable[[DbWriteTransaction], T | Awaitable[T]],
    clock: Callable[[], datetime] | None = None,
) -> OpResult[T]:
    raise NotImplementedError
