"""Ported from packages/lhc/src/threads/index.ts. Phase 1 — PARTIAL (Wave 1/3 import seam).

Wave 1 needs ThreadRef, open_thread_database, and new_thread. Full threads
surface lands in Wave 3; extend — do not reshape ThreadRef.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import NotRequired, TypedDict, Union

from ..shared_tech.errors import OpResult
from .internal.create import open_thread_database

__all__ = [
    "NewThreadInput",
    "ThreadInfo",
    "ThreadRef",
    "ThreadRefById",
    "ThreadRefByPath",
    "new_thread",
    "open_thread_database",
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


async def new_thread(input: NewThreadInput | dict[str, object]) -> OpResult[NewThreadResult]:
    raise NotImplementedError
