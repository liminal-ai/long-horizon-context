"""Ported from packages/lhc/src/shared-tech/context.ts. Phase 1 skeleton.

Per-SDK-instance delivery seam. Each SDK runs every one of its operations
inside run_with_instance_seam, so code reached deep inside — enqueue's poke and
open_thread_database's touch — delivers to that SDK's scheduler in background
mode or to a no-op in manual mode, isolated from any other SDK in the process.
Carried through contextvars (TS: AsyncLocalStorage), not a mutable module slot
two SDKs would share.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

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


def run_with_instance_seam(seam: InstanceSeam, operation: Callable[[], T]) -> T:
    raise NotImplementedError


def set_scheduler_poke(poke: SchedulerPoke | None) -> None:
    raise NotImplementedError


def set_thread_touch(touch: ThreadTouch | None) -> None:
    raise NotImplementedError


# The poke target for a context built now: the running SDK's seam if one is
# in scope, else the below-SDK default (null-safe). Captured onto ctx.poke so
# the enqueue carries its target rather than reading a shared slot at fire
# time — except, deliberately, through the default fallback for direct calls.
def resolve_instance_poke() -> SchedulerPoke:
    raise NotImplementedError


# The view config for the operation now running: the SDK seam's resolved
# config when one is in scope, undefined for direct domain calls (the
# thread-view surface defaults those itself — see InstanceSeam.view).
def resolve_instance_view_config() -> ResolvedViewConfig | None:
    raise NotImplementedError


def resolve_instance_config() -> ResolvedSdkConfig | None:
    raise NotImplementedError


# Reads-only operation scope: runs fn under the current seam with the
# thread-touch announcement suppressed, so a pure read can never schedule a
# background scheduler's first-touch catch-up drain through open_thread_database
# calls. Everything else on the seam carries through unchanged; direct domain
# calls with no seam in scope delegate to below-SDK defaults, minus the touch.
# Write paths never use this.
def run_with_thread_touch_suppressed(operation: Callable[[], T]) -> T:
    raise NotImplementedError


# Thread-file open announcement: open_thread_database fires this on every open,
# before any caller transaction begins. Delivers to the SDK seam in scope if
# any, else the below-SDK default. The background scheduler learns
# threadId→filePath and runs first-touch catch-up off this seam.
def fire_thread_touch(file_path: str, db: Database) -> None:
    raise NotImplementedError
