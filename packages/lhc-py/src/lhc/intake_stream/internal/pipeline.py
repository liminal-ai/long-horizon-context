"""Ported from packages/lhc/src/intake-stream/internal/pipeline.ts. Phase 1 skeleton.

Batch transaction pipeline. Walk-hook / clock test seams keep their module
state; pipeline bodies stay NotImplementedError.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime

from ...messages import create as _create_message
from ...shared_tech.errors import OpResult
from ...shared_tech.storage import Database
from ...threads import ThreadRef
from ...turns import TurnStateCorruptionError, create as _create_turn
from .. import BatchResult, EventRecord, MessageEventInput

# Closed over by Phase 2 walk; named for TS import fidelity.
_ = (_create_message, _create_turn, TurnStateCorruptionError)

# Test seam (set only through test/fixtures): called after each event is
# processed inside the walk, so atomicity under mid-walk failure can be
# induced through a real mechanism — closing the handle — rather than a
# mocked transaction object.
IntakeWalkHook = Callable[[Database, int], None]

_walk_hook: IntakeWalkHook | None = None


def set_intake_walk_hook(hook: IntakeWalkHook | None) -> None:
    raise NotImplementedError


# Test seam (set only through test/fixtures): replaces the wall clock so
# recordedAt is sourced deterministically for the public SDK contract proof —
# tests record the same batch through both reference shapes and read it back
# field-for-field, recordedAt included, with nothing stripped. Unset in
# production: recording stamps real wall time. An explicit clock argument to
# run_message_events still wins over the seam.
_injected_clock: Callable[[], datetime] | None = None


def set_intake_clock(clock: Callable[[], datetime] | None) -> None:
    raise NotImplementedError


def _detail(cause: object) -> str:
    raise NotImplementedError


def _recorded_keys(db: Database, keys: Sequence[str]) -> set[str]:
    raise NotImplementedError


def _max_event_order(db: Database) -> int:
    raise NotImplementedError


async def run_message_events(
    thread_ref: ThreadRef,
    events: Sequence[MessageEventInput],
    clock: Callable[[], datetime] | None = None,
) -> OpResult[BatchResult]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _RawEventRow:
    event_order: int
    event_kind: str
    idempotency_key: str
    actor: str
    harness: str
    payload: str
    recorded_at: str


async def run_list_events(thread_ref: ThreadRef) -> OpResult[list[EventRecord]]:
    raise NotImplementedError
