"""Ported from packages/lhc/test/fixtures/read-only-delta.ts. Phase 1 skeleton.

The shared read-only delta helper (Epic 04, DD-6): inspect describes, never
changes — asserted as ABSENCE OF DELTA in observable state, not absence of
write code. Snapshots queued work through both owners, boundary/zone/view
identity through the thread-view surface, the event log, the audit message
listing, and the raw derived-form rows — before and after an operation —
and requires deep equality.

ObservableState is pure data shape — real. `_queued_for`, `observable_state`,
and `expect_read_only` all reach the SDK / storage seam, so they are
skeletons.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypedDict, TypeVar

from lhc.shared_tech.work_queue import WorkOwner


class ObservableState(TypedDict):
    events: object
    messages: object
    messageWork: object
    turnWork: object
    viewStatus: object
    modelContext: object
    storedView: object
    derivations: object


def _queued_for(file_path: str, owner: WorkOwner) -> list[object]:
    raise NotImplementedError


async def observable_state(file_path: str) -> ObservableState:
    raise NotImplementedError


T = TypeVar("T")


# Runs one operation under the before/after snapshot and returns its result
# so call sites can keep asserting on it. Raises (deep-equality assertion)
# when the operation moved anything observable.
async def expect_read_only(file_path: str, operation: Callable[[], Awaitable[T]]) -> T:
    raise NotImplementedError


__all__ = [
    "ObservableState",
    "expect_read_only",
    "observable_state",
]
