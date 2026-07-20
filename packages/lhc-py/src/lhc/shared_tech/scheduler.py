"""Ported from packages/lhc/src/shared-tech/scheduler.ts. Phase 1 skeleton.

SDK-internal scheduler and drain: the one component holding cross-operation
in-memory state. The drain loop lives here: claim under BEGIN IMMEDIATE,
dispatch through the handler map with no open transaction, and complete in a
second short transaction.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from .derivation import ResolvedSdkConfig
from .durable_work import DurableWorkDispatcher, DurableWorkOperation
from .errors import ErrorResult, OpResult
from .logging.derivation_log import DerivationLogEventKind
from .storage import Database
from .work_queue import ClaimedWorkItem, EnqueueDerivationTarget, WorkKind, WorkSourceRef

# The type of the thread DB opener function, injected by SDK wiring to avoid
# importing from the threads domain.
ThreadDbOpener = Callable[[str], OpResult[Database]]

SchedulerMode = Literal["background", "manual"]


@dataclass(frozen=True, slots=True)
class DrainRanEntry:
    work_item_id: str
    kind: WorkKind
    source_ref: WorkSourceRef
    disposition: Literal["done", "failed_terminal", "stale_discarded", "lost_lease"]
    reason: str | None = None


# Drain report shape. `superseded` never appears here: the cascade deletes
# superseded items and reports them on the mutation result; a drain never sees
# them.
@dataclass(frozen=True, slots=True)
class DrainReport:
    ran: list[DrainRanEntry]
    stopped_because: Literal["empty", "in_flight", "max_items"]
    remaining: int  # live items left behind the stop point
    claim_expires_at: str | None = None  # head's claim_expires_at when stopped_because = "in_flight"


@dataclass(frozen=True, slots=True)
class DrainDeps:
    lookup_dispatcher: Callable[
        [DurableWorkOperation | None, str],
        OpResult[DurableWorkDispatcher],
    ]
    # Whether any handler is registered at all. Background scheduling is gated
    # on this, fail-closed: with an empty map a background drain could only
    # turn queued rows into failed_terminal — destruction, not processing — so
    # pokes and catch-up stay inert until a handler table is populated
    # explicitly.
    has_any_handler: Callable[[], bool]
    config: ResolvedSdkConfig
    # The thread DB opener, injected by SDK wiring to avoid importing from the
    # threads domain.
    open_thread_database: ThreadDbOpener


def _ran_entry(
    item: ClaimedWorkItem,
    disposition: Literal["done", "failed_terminal", "stale_discarded", "lost_lease"],
    reason: str | None = None,
) -> DrainRanEntry:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class DrainIdentity:
    thread_id: str
    file_path: str


@dataclass(frozen=True, slots=True)
class DrainOpts:
    max_items: int | None = None


def _log_derivation_execution(
    identity: DrainIdentity | None,
    db: Database,
    derivations: Sequence[EnqueueDerivationTarget],
    event_kind: DerivationLogEventKind,
    payload: dict[str, object],
) -> None:
    raise NotImplementedError


# The drain loop against an open handle. Claim → dispatch → complete, one
# item at a time, until the head stops it (empty / in_flight) or
# max_items is reached. The handler runs with NO open transaction; the only
# exit from a handler failure is a terminal path — the drain never catches an
# error and records success.
async def drain_open_db(
    db: Database,
    deps: DrainDeps,
    opts: DrainOpts | None = None,
    identity: DrainIdentity | None = None,
) -> DrainReport:
    raise NotImplementedError


def _thread_not_found(file_path: str) -> OpResult[DrainReport]:
    raise NotImplementedError


# The drain operation against a thread file: open (validates + migrates),
# drain, close. Both the SDK's work.drain and the background loop's passes
# run through here — manual and background modes share one drain.
async def run_drain(
    file_path: str,
    deps: DrainDeps,
    opts: DrainOpts | None = None,
) -> OpResult[DrainReport]:
    raise NotImplementedError


@dataclass
class _ThreadDrainState:
    thread_id: str
    file_path: str
    running: bool
    pending: bool
    passes: int  # test-only observability (TC-1.2); must not become API
    waiters: list[Callable[[], None]]
    wake_timer: object | None  # ReturnType<typeof scheduleTimer> in TS


# A wake floored to a sane minimum: an already-past wake target must nudge
# once, not busy-spin (the durable claim_next gate is the real guard).
_WAKE_MIN_DELAY_MS = 5


class Scheduler(Protocol):
    @property
    def mode(self) -> SchedulerMode: ...

    # Post-commit nudge that work was queued for a thread. Manual mode is no-op
    # by contract. Background mode starts a drain, or coalesces into the pending
    # flag if one is already running for the thread.
    def poke(self, thread_id: str) -> None: ...

    # Thread-file open announcement: learns threadId → filePath and, on the first
    # touch of a thread this process lifetime, schedules catch-up if the queue
    # has leftover live work.
    def touch(self, file_path: str, db: Database) -> None: ...

    # Resolves when the scheduler has no running or pending drain for the
    # thread (issue 3). Manual mode resolves immediately.
    async def drain_settled(self, thread_id: str) -> None: ...

    # Test-only observability for coalescing exactness (TC-1.2): drain passes
    # started for a thread. Named as a test hook on purpose — not API.
    def test_pass_count(self, thread_id: str) -> int: ...


def _read_thread_id(db: Database) -> str | None:
    raise NotImplementedError


# Read a thread file's id without side effects (no migration, no touch) —
# drain_settled must observe scheduler state, never schedule work.
def peek_thread_id(file_path: str) -> str | None:
    raise NotImplementedError


def _state_for(
    states: dict[str, _ThreadDrainState],
    thread_id: str,
) -> _ThreadDrainState:
    raise NotImplementedError


def _clear_wake(st: _ThreadDrainState) -> None:
    raise NotImplementedError


def _arm_wake(st: _ThreadDrainState, wake_at: str, deps: DrainDeps) -> None:
    raise NotImplementedError


def _next_wake_at(report: DrainReport | None) -> str | None:
    raise NotImplementedError


async def _run_loop(st: _ThreadDrainState, deps: DrainDeps) -> None:
    raise NotImplementedError


def _schedule(thread_id: str, states: dict[str, _ThreadDrainState], deps: DrainDeps) -> None:
    raise NotImplementedError


def create_scheduler(mode: SchedulerMode, deps: DrainDeps) -> Scheduler:
    raise NotImplementedError
