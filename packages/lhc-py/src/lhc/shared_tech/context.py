"""Ported from packages/lhc/src/shared-tech/context.ts.

Per-SDK-instance delivery seam. Each SDK runs every one of its operations
inside run_with_instance_seam, so code reached deep inside — enqueue's poke and
open_thread_database's touch — delivers to that SDK's scheduler in background
mode or to a no-op in manual mode, isolated from any other SDK in the process.
Carried through contextvars (TS: AsyncLocalStorage), not a mutable module slot
two SDKs would share.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, replace
from typing import Any, TypeVar, cast

from .derivation import ResolvedSdkConfig
from .storage import Database
from .view import ResolvedViewConfig

T = TypeVar("T")

SchedulerPoke = Callable[[str], None]
ThreadTouch = Callable[[str, Database], None]


@dataclass(frozen=True, slots=True)
class InstanceSeam:
    poke: SchedulerPoke
    touch: ThreadTouch
    # The instance's resolved view config rides the same seam the poke does, so
    # a thread-view operation invoked through sdk.* reads this SDK's
    # profiles/budgets/threshold. Below-SDK direct domain calls find no seam and
    # fall back to built-in defaults at the consuming site, never here.
    view: ResolvedViewConfig | None = None
    config: ResolvedSdkConfig | None = None


_seam_store: ContextVar[InstanceSeam | None] = ContextVar("lhc_instance_seam", default=None)

# The below-SDK default seam (the former module-global poke/touch slots).
_scheduler_poke: SchedulerPoke | None = None
_thread_touch: ThreadTouch | None = None


def _run_preserving_seam(token: Any, seam: InstanceSeam, result: T) -> T:
    """Reset the ContextVar after sync return, or after an awaitable completes.

    TS AsyncLocalStorage.run spans the whole async operation. Resetting when a
    coroutine is *returned* (before it is awaited) drops the seam across the
    first await — detect awaitables and defer reset into their finally.
    """
    if inspect.isawaitable(result):
        # A coroutine may be scheduled in a new asyncio Task, whose Context is
        # a copy of this one. ContextVar tokens cannot be reset in that copied
        # Context, so restore the caller now and establish a task-local token
        # when the coroutine actually starts running.
        _seam_store.reset(token)

        async def _preserve() -> Any:
            task_token = _seam_store.set(seam)
            try:
                return await cast(Awaitable[Any], result)
            finally:
                _seam_store.reset(task_token)

        return cast(T, _preserve())
    _seam_store.reset(token)
    return result


def run_with_instance_seam(seam: InstanceSeam, operation: Callable[[], T]) -> T:
    token = _seam_store.set(seam)
    try:
        result = operation()
    except BaseException:
        _seam_store.reset(token)
        raise
    return _run_preserving_seam(token, seam, result)


def set_scheduler_poke(poke: SchedulerPoke | None) -> None:
    global _scheduler_poke
    _scheduler_poke = poke


def set_thread_touch(touch: ThreadTouch | None) -> None:
    global _thread_touch
    _thread_touch = touch


# The poke target for a context built now: the running SDK's seam if one is
# in scope, else the below-SDK default (null-safe). Captured onto ctx.poke so
# the enqueue carries its target rather than reading a shared slot at fire
# time — except, deliberately, through the default fallback for direct calls.
def resolve_instance_poke() -> SchedulerPoke:
    seam = _seam_store.get()
    if seam is not None:
        return seam.poke

    def _fallback(thread_id: str) -> None:
        if _scheduler_poke is not None:
            _scheduler_poke(thread_id)

    return _fallback


# The view config for the operation now running: the SDK seam's resolved
# config when one is in scope, undefined for direct domain calls (the
# thread-view surface defaults those itself — see InstanceSeam.view).
def resolve_instance_view_config() -> ResolvedViewConfig | None:
    seam = _seam_store.get()
    return seam.view if seam is not None else None


def resolve_instance_config() -> ResolvedSdkConfig | None:
    seam = _seam_store.get()
    return seam.config if seam is not None else None


# Reads-only operation scope: runs fn under the current seam with the
# thread-touch announcement suppressed, so a pure read can never schedule a
# background scheduler's first-touch catch-up drain through open_thread_database
# calls. Everything else on the seam carries through unchanged; direct domain
# calls with no seam in scope delegate to below-SDK defaults, minus the touch.
# Write paths never use this.
def run_with_thread_touch_suppressed(operation: Callable[[], T]) -> T:
    seam = _seam_store.get()
    if seam is None:

        def _poke(thread_id: str) -> None:
            if _scheduler_poke is not None:
                _scheduler_poke(thread_id)

        def _touch(file_path: str, db: Database) -> None:
            if _thread_touch is not None:
                _thread_touch(file_path, db)

        base = InstanceSeam(poke=_poke, touch=_touch)
    else:
        base = seam

    def _noop_touch(_file_path: str, _db: Database) -> None:
        return None

    return run_with_instance_seam(replace(base, touch=_noop_touch), operation)


# Thread-file open announcement: open_thread_database fires this on every open,
# before any caller transaction begins. Delivers to the SDK seam in scope if
# any, else the below-SDK default. The background scheduler learns
# threadId→filePath and runs first-touch catch-up off this seam.
def fire_thread_touch(file_path: str, db: Database) -> None:
    seam = _seam_store.get()
    if seam is not None:
        seam.touch(file_path, db)
        return
    if _thread_touch is not None:
        _thread_touch(file_path, db)
