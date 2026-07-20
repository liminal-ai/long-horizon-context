"""Ported from packages/lhc/src/threads/index.ts. Phase 1 skeleton.

Thread creation, registry resolution, list, info, and ThreadRef interpretation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import NotRequired, TypedDict, Union

from ..shared_tech.errors import OpErr, OpResult
# LAYERING CONSTRAINT (load-bearing): import shared_tech SUBMODULES only,
# never `from ..shared_tech import ...` — persist.py imports this domain,
# and a package-level import here would deadlock that cycle. See persist.py.
from .internal.create import open_thread_database
from .internal.registry import RegistryRow

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
    raise NotImplementedError


def _thread_not_found(thread_id: str) -> OpErr:
    raise NotImplementedError


def _ambiguous_thread_id(prefix: str, match_ids: tuple[str, ...] | list[str]) -> OpErr:
    raise NotImplementedError


def _invalid_thread_ref(reason: str) -> OpErr:
    raise NotImplementedError


def _is_blank_path(file_path: str) -> bool:
    raise NotImplementedError


def _detail(cause: object) -> str:
    raise NotImplementedError


async def new_thread(input: NewThreadInput) -> OpResult[NewThreadResult]:
    raise NotImplementedError


async def resolve(input: ResolveInput) -> OpResult[ThreadInfo]:
    raise NotImplementedError


async def list_threads(input: ListThreadsInput | None = None) -> OpResult[list[ThreadInfo]]:
    raise NotImplementedError


async def info(ref: ThreadRef) -> OpResult[ThreadFileInfo]:
    raise NotImplementedError


async def resolve_thread_ref(ref: ThreadRef) -> OpResult[ResolvedThreadPath]:
    raise NotImplementedError
