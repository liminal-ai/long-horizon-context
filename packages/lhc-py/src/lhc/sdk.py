"""Ported from packages/lhc/src/sdk.ts. Phase 1 — PARTIAL (Wave 1/7 import seam).

Wave 1 tests need init_lhc / Lhc / register_testing_work and a subset of
re-exports. Full SDK assembly lands in Wave 7; extend — do not reshape the
exports below. Nothing invented: work.drain (not sdk.drain) mirrors TS.
"""

from __future__ import annotations

from typing import Literal, Protocol, TypedDict

from .intake_stream import BatchResult, MessageEventInput
from .messages import MessageListOptions, MessageRecord
from .shared_tech.context import set_scheduler_poke, set_thread_touch
from .shared_tech.derivation import InferenceCallbacks, ResolvedSdkConfig, SdkConfig, WorkHandler
from .shared_tech.deterministic import create_deterministic_inference_callbacks
from .shared_tech.durable_work import DurableWorkDispatcherMap
from .shared_tech.errors import OpResult
from .shared_tech.logging import (
    DerivationLogQuery,
    LogEntry,
    LogLevel,
    LogQuery,
    StoredDerivationLogEntry,
    StoredLogEntry,
    write_log,
)
from .shared_tech.view import LlmRequestContext
from .shared_tech.work_queue import DrainReport, WorkHandlerMap, WorkKind
from .threads import NewThreadInput, NewThreadResult, ThreadRef


class DrainOpts(TypedDict, total=False):
    maxItems: int


class WorkSurface(Protocol):
    """The work surface used by CLI work operations."""

    async def drain(
        self,
        ref: ThreadRef,
        opts: DrainOpts | None = None,
    ) -> OpResult[DrainReport]: ...


class LoggingSurface(Protocol):
    async def write(self, ref: ThreadRef, entry: LogEntry) -> OpResult[None]: ...

    async def query(
        self,
        ref: ThreadRef,
        q: LogQuery,
    ) -> OpResult[list[StoredLogEntry]]: ...

    async def query_derivation_log(
        self,
        ref: ThreadRef,
        q: DerivationLogQuery,
    ) -> OpResult[list[StoredDerivationLogEntry]]: ...


class Scheduler(Protocol):
    mode: Literal["background", "manual"]

    def poke(self, thread_id: str) -> None: ...

    async def drain_settled(self, thread_id: str) -> None: ...


class LhcThreads(Protocol):
    async def new_thread(self, input: NewThreadInput) -> OpResult[NewThreadResult]: ...


class LhcIntakeStream(Protocol):
    async def message_events(
        self,
        ref: ThreadRef,
        events: list[MessageEventInput] | tuple[MessageEventInput, ...],
    ) -> OpResult[BatchResult]: ...


class LhcMessages(Protocol):
    async def list(
        self,
        ref: ThreadRef,
        filter: MessageListOptions | None = None,
    ) -> OpResult[list[MessageRecord]]: ...


class LhcThreadView(Protocol):
    async def get_llm_request_context(self, ref: ThreadRef) -> OpResult[LlmRequestContext]: ...


class Lhc(Protocol):
    threads: LhcThreads
    intake_stream: LhcIntakeStream
    messages: LhcMessages
    thread_view: LhcThreadView
    logging: LoggingSurface
    config: ResolvedSdkConfig
    scheduler: Scheduler
    work: WorkSurface

    async def drain_settled(self, ref: ThreadRef) -> None: ...


class TestingWorkRegistration(TypedDict, total=False):
    handlers: WorkHandlerMap
    dispatchers: DurableWorkDispatcherMap


def init_lhc(config: SdkConfig) -> Lhc:
    raise NotImplementedError


def register_testing_work(sdk: Lhc, registration: TestingWorkRegistration) -> None:
    raise NotImplementedError


__all__ = [
    "Lhc",
    "LogEntry",
    "LogLevel",
    "LogQuery",
    "LoggingSurface",
    "Scheduler",
    "StoredLogEntry",
    "WorkSurface",
    "create_deterministic_inference_callbacks",
    "init_lhc",
    "register_testing_work",
    "set_scheduler_poke",
    "set_thread_touch",
    "write_log",
]
