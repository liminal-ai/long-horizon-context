"""Ported from packages/lhc/src/shared-tech/scheduler.ts.

SDK-internal scheduler and drain: the one component holding cross-operation
in-memory state. The drain loop lives here: claim under BEGIN IMMEDIATE,
dispatch through the handler map with no open transaction, and complete in a
second short transaction.
"""

from __future__ import annotations

import asyncio
import math
import os
import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Protocol

from .derivation import ResolvedSdkConfig
from .durable_work import (
    DerivationAttempt,
    DerivationCompletionError,
    DerivationTerminalFailure,
    DurableWorkDispatcher,
    DurableWorkDispatcherItem,
    DurableWorkOperation,
    apply_derivation_terminal_failure,
)
from .errors import ErrorResult, OpErr, OpOk, OpResult, storage_failure
from .logging.derivation_log import (
    DerivationLogEntry,
    DerivationLogEventKind,
    DerivationLogTarget,
    append_derivation_log,
)
from .persist import DbReadTransaction
from .storage import Database
from .work_queue import (
    ClaimedWorkItem,
    EnqueueDerivationTarget,
    WorkKind,
    WorkSourceRef,
    claim_next,
    count_live_items,
)

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
    return DrainRanEntry(
        work_item_id=item.work_item_id,
        kind=item.kind,  # type: ignore[arg-type]
        source_ref=item.source_ref,
        disposition=disposition,
        reason=reason,
    )


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
    if identity is None or not derivations:
        return
    transaction = DbReadTransaction(
        db=db, thread_id=identity.thread_id, file_path=identity.file_path
    )
    for target in derivations:
        append_derivation_log(
            transaction,
            DerivationLogEntry(
                target=DerivationLogTarget(
                    subject_kind=target.subject_kind,
                    subject_id=target.subject_id,
                    derivation_type=target.derivation_type,
                ),
                event_kind=event_kind,
                payload=payload,
            ),
        )


def _iso_millis(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _attempt(item: ClaimedWorkItem) -> DerivationAttempt:
    return DerivationAttempt(
        source_version=item.source_version,
        derivations=item.derivations,
        work_item_id=item.work_item_id,
    )


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
    clock = deps.config.clock
    ran: list[DrainRanEntry] = []
    stopped_because: Literal["empty", "in_flight", "max_items"]
    claim_expires_at: str | None = None
    while True:
        if opts is not None and opts.max_items is not None and len(ran) >= opts.max_items:
            stopped_because = "max_items"
            break
        claim = claim_next(db, _iso_millis(clock()), deps.config.lease.duration_ms)
        if claim.outcome == "empty":
            stopped_because = "empty"
            break
        if claim.outcome == "in_flight":
            stopped_because = "in_flight"
            claim_expires_at = claim.claim_expires_at
            break
        item = claim.item
        if claim.outcome == "expired":
            reason = "claim_expired"
            terminal = apply_derivation_terminal_failure(
                db,
                _attempt(item),
                DerivationTerminalFailure(
                    reason=reason, state="failed", now=_iso_millis(clock())
                ),
            )
            if terminal != "lost_lease":
                _log_derivation_execution(
                    identity,
                    db,
                    item.derivations,
                    "terminal_failed",
                    {"reason": reason},
                )
            ran.append(
                _ran_entry(
                    item,
                    "lost_lease" if terminal == "lost_lease" else "failed_terminal",
                    reason,
                )
            )
            continue

        looked_up = deps.lookup_dispatcher(item.operation, item.kind)
        if not looked_up.ok:
            reason = looked_up.error.code
            terminal = apply_derivation_terminal_failure(
                db,
                _attempt(item),
                DerivationTerminalFailure(
                    reason=reason, state="failed", now=_iso_millis(clock())
                ),
            )
            ran.append(
                _ran_entry(
                    item,
                    "lost_lease" if terminal == "lost_lease" else "failed_terminal",
                    reason,
                )
            )
            continue

        if item.operation is None:
            reason = "unknown_work_kind"
            terminal = apply_derivation_terminal_failure(
                db,
                _attempt(item),
                DerivationTerminalFailure(
                    reason=reason, state="failed", now=_iso_millis(clock())
                ),
            )
            ran.append(
                _ran_entry(
                    item,
                    "lost_lease" if terminal == "lost_lease" else "failed_terminal",
                    reason,
                )
            )
            continue

        from .derivation import HandlerRunContext

        run = HandlerRunContext(
            thread_id=identity.thread_id if identity is not None else "",
            file_path=identity.file_path if identity is not None else "",
            open_db=lambda: db,
            inference_callbacks=deps.config.inference_callbacks,
            clock=clock,
            config=deps.config,
        )
        dispatch_item = DurableWorkDispatcherItem(
            work_item_id=item.work_item_id,
            kind=item.kind,
            source_ref=item.source_ref,
            source_version=item.source_version,
            derivations=item.derivations,
            operation=item.operation,
        )
        try:
            outcome = await looked_up.value(run, dispatch_item)
            if isinstance(outcome, dict):
                from .durable_work import (
                    DurableWorkDispatchBlocked,
                    DurableWorkDispatchFailed,
                    DurableWorkDispatchSettled,
                )

                disposition = outcome.get("disposition")
                if disposition in ("done", "stale_discarded", "lost_lease"):
                    outcome = DurableWorkDispatchSettled(disposition=disposition)
                elif disposition == "blocked":
                    outcome = DurableWorkDispatchBlocked(
                        reason=str(outcome.get("reason", ""))
                    )
                elif disposition == "failed":
                    outcome = DurableWorkDispatchFailed(
                        reason=str(outcome.get("reason", ""))
                    )
        except DerivationCompletionError:
            raise
        except BaseException as cause:
            from .durable_work import DurableWorkDispatchFailed

            outcome = DurableWorkDispatchFailed(reason=f"handler threw: {cause}")

        if outcome.disposition in ("done", "stale_discarded", "lost_lease"):
            ran.append(_ran_entry(item, outcome.disposition))
            continue
        if outcome.disposition not in ("blocked", "failed"):
            raise RuntimeError(
                f"unknown durable work disposition {outcome.disposition}"
            )
        terminal = apply_derivation_terminal_failure(
            db,
            _attempt(item),
            DerivationTerminalFailure(
                reason=outcome.reason,
                state="blocked" if outcome.disposition == "blocked" else "failed",
                now=_iso_millis(clock()),
            ),
        )
        if terminal != "lost_lease":
            _log_derivation_execution(
                identity,
                db,
                item.derivations,
                "terminal_failed",
                {"reason": outcome.reason},
            )
        ran.append(
            _ran_entry(
                item,
                "lost_lease" if terminal == "lost_lease" else "failed_terminal",
                outcome.reason,
            )
        )
    return DrainReport(
        ran=ran,
        stopped_because=stopped_because,
        remaining=count_live_items(db),
        claim_expires_at=claim_expires_at,
    )


def _thread_not_found(file_path: str) -> OpResult[DrainReport]:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="thread_not_found",
            reason=f"no thread file exists at {file_path}",
        )
    )


# The drain operation against a thread file: open (validates + migrates),
# drain, close. Both the SDK's work.drain and the background loop's passes
# run through here — manual and background modes share one drain.
async def run_drain(
    file_path: str,
    deps: DrainDeps,
    opts: DrainOpts | None = None,
) -> OpResult[DrainReport]:
    if not os.path.exists(file_path):
        return _thread_not_found(file_path)
    opened = deps.open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    try:
        thread_id = _read_thread_id(db)
        if thread_id is None:
            return storage_failure(
                f"thread file at {file_path} lost its metadata row"
            )
        return OpOk(
            value=await drain_open_db(
                db,
                deps,
                opts,
                DrainIdentity(thread_id=thread_id, file_path=file_path),
            )
        )
    except DerivationCompletionError as cause:
        return OpErr(
            error=ErrorResult(
                error_class=cause.error_class,
                code=cause.code,
                reason=str(cause),
            )
        )
    except BaseException as cause:
        return storage_failure(f"drain failed: {cause}")
    finally:
        db.close()


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
    row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get()
    return str(row["thread_id"]) if row is not None else None


# Read a thread file's id without side effects (no migration, no touch) —
# drain_settled must observe scheduler state, never schedule work.
def peek_thread_id(file_path: str) -> str | None:
    if not os.path.exists(file_path):
        return None
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            f"file:{file_path}?mode=ro", uri=True, isolation_level=None
        )
        row = connection.execute(
            "SELECT thread_id FROM thread_metadata WHERE id = 1"
        ).fetchone()
        return str(row[0]) if row is not None else None
    except sqlite3.Error:
        return None
    finally:
        if connection is not None:
            connection.close()


def _state_for(
    states: dict[str, _ThreadDrainState],
    thread_id: str,
) -> _ThreadDrainState:
    state = states.get(thread_id)
    if state is None:
        state = _ThreadDrainState(
            thread_id=thread_id,
            file_path="",
            running=False,
            pending=False,
            passes=0,
            waiters=[],
            wake_timer=None,
        )
        states[thread_id] = state
    return state


def _clear_wake(st: _ThreadDrainState) -> None:
    if st.wake_timer is not None:
        cancel = getattr(st.wake_timer, "cancel", None)
        if cancel is not None:
            cancel()
        st.wake_timer = None


def _arm_wake(
    st: _ThreadDrainState,
    wake_at: str,
    deps: DrainDeps,
    states: dict[str, _ThreadDrainState] | None = None,
) -> None:
    _clear_wake(st)
    try:
        parsed = datetime.fromisoformat(wake_at.replace("Z", "+00:00"))
        now = deps.config.clock()
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        delay = max(_WAKE_MIN_DELAY_MS / 1000, (parsed - now).total_seconds())
        if not math.isfinite(delay):
            delay = _WAKE_MIN_DELAY_MS / 1000
    except (TypeError, ValueError, OverflowError):
        delay = _WAKE_MIN_DELAY_MS / 1000
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        st.pending = True
        return

    def wake() -> None:
        st.wake_timer = None
        if states is not None:
            _schedule(st.thread_id, states, deps)

    st.wake_timer = loop.call_later(delay, wake)


def _next_wake_at(report: DrainReport | None) -> str | None:
    if report is not None and report.stopped_because == "in_flight":
        return report.claim_expires_at
    return None


async def _run_loop(
    st: _ThreadDrainState,
    deps: DrainDeps,
    states: dict[str, _ThreadDrainState] | None = None,
) -> None:
    await asyncio.sleep(0)
    last_report: DrainReport | None = None
    try:
        while True:
            st.pending = False
            st.passes += 1
            result = await run_drain(st.file_path, deps)
            last_report = result.value if result.ok else None
            if not st.pending:
                break
    finally:
        st.running = False
        wake_at = _next_wake_at(last_report)
        if st.wake_timer is None and wake_at is not None:
            _arm_wake(st, wake_at, deps, states)
        else:
            waiters = st.waiters[:]
            st.waiters.clear()
            for waiter in waiters:
                waiter()


def _schedule(thread_id: str, states: dict[str, _ThreadDrainState], deps: DrainDeps) -> None:
    st = _state_for(states, thread_id)
    _clear_wake(st)
    if not st.file_path:
        return
    if st.running:
        st.pending = True
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        st.pending = True
        return
    st.running = True
    st.pending = False
    loop.create_task(_run_loop(st, deps, states))


def create_scheduler(mode: SchedulerMode, deps: DrainDeps) -> Scheduler:
    states: dict[str, _ThreadDrainState] = {}
    seen: set[str] = set()

    class _Scheduler:
        @property
        def mode(self) -> SchedulerMode:
            return mode

        def poke(self, thread_id: str) -> None:
            if mode != "background" or not deps.has_any_handler():
                return
            _schedule(thread_id, states, deps)

        def touch(self, file_path: str, db: Database) -> None:
            if mode != "background":
                return
            thread_id = _read_thread_id(db)
            if thread_id is None:
                return
            st = _state_for(states, thread_id)
            st.file_path = file_path
            was_pending = st.pending and not st.running
            if thread_id in seen:
                if was_pending and deps.has_any_handler():
                    _schedule(thread_id, states, deps)
                return
            seen.add(thread_id)
            if deps.has_any_handler() and (
                was_pending or count_live_items(db) > 0
            ):
                _schedule(thread_id, states, deps)

        async def drain_settled(self, thread_id: str) -> None:
            if mode != "background":
                return
            st = states.get(thread_id)
            if st is None:
                return
            if st.pending and not st.running and st.file_path and deps.has_any_handler():
                _schedule(thread_id, states, deps)
            if not st.running and not st.pending and st.wake_timer is None:
                return
            loop = asyncio.get_running_loop()
            future: asyncio.Future[None] = loop.create_future()
            st.waiters.append(
                lambda: None if future.done() else future.set_result(None)
            )
            await future

        def test_pass_count(self, thread_id: str) -> int:
            st = states.get(thread_id)
            return st.passes if st is not None else 0

    return _Scheduler()
