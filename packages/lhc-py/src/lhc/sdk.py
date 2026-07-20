"""Ported from packages/lhc/src/sdk.ts. Phase 1 — PARTIAL (Wave 1/7 import seam).

Wave 1 tests need init_lhc / Lhc / register_testing_work and a subset of
re-exports. Full SDK assembly lands in Wave 7; extend — do not reshape the
exports below. Nothing invented: work.drain (not sdk.drain) mirrors TS.
"""

from __future__ import annotations

from typing import Literal, Protocol, TypedDict

from .intake_stream import BatchResult, MessageEventInput
from .messages import (
    EditInput,
    MessageDeriveResult,
    MessageDetail,
    MessageListOptions,
    MessageRecord,
    MessageReportOpts,
    MutationResult,
    RemoveInput,
)
from .shared_tech.context import set_scheduler_poke, set_thread_touch
from .shared_tech.derivation import (
    DerivationReportEntry,
    InferenceCallbacks,
    ResolvedSdkConfig,
    SdkConfig,
    WorkHandler,
)
from .shared_tech.deterministic import create_deterministic_inference_callbacks
from .shared_tech.durable_work import (
    DurableWorkDispatcher,
    DurableWorkDispatcherMap,
    DurableWorkOperation,
)
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
from .shared_tech.view import (
    CompactReceipt,
    LlmRequestContext,
    PreviewCompactOutcome,
    PruneReceipt,
    SessionThreadView,
    StoredView,
    ViewStatus,
)
from .shared_tech.storage import Database
from .shared_tech.scheduler import DrainReport
from .shared_tech.work_queue import WorkHandlerMap, WorkKind
from .thread_view import CompactOpts, MaterializeOpts, MaterializeResult, PruneParams
from .threads import NewThreadInput, NewThreadResult, ThreadRef
from .turns import ChunkDeriveResult, ChunkRecord, TurnDeriveResult, TurnRecord

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

    def touch(self, file_path: str, db: Database) -> None: ...

    async def drain_settled(self, thread_id: str) -> None: ...

    # Test-only observability for coalescing exactness (TC-1.2): drain passes
    # started for a thread. Named as a test hook on purpose — not API.
    def test_pass_count(self, thread_id: str) -> int: ...


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

    async def show(self, ref: ThreadRef, message_id: str) -> OpResult[MessageDetail]: ...

    async def report(
        self,
        ref: ThreadRef,
        opts: MessageReportOpts | None = None,
    ) -> OpResult[list[DerivationReportEntry]]: ...

    async def derive(
        self,
        ref: ThreadRef,
        message_ids: list[str],
    ) -> OpResult[list[MessageDeriveResult]]: ...

    async def edit(self, ref: ThreadRef, edit: EditInput) -> OpResult[MutationResult]: ...

    async def remove(self, ref: ThreadRef, removal: RemoveInput) -> OpResult[MutationResult]: ...

    # Re-exported from messages domain (smoothing.clean_prompt) onto the SDK
    # surface — sync, pure.
    def clean_prompt(self, text: str) -> str: ...


class LhcTurns(Protocol):
    """Wave 2/4/5 import seam: sync-derive suite + Wave 4 list_chunks/list_turns."""

    async def list_turns(self, ref: ThreadRef) -> OpResult[list[TurnRecord]]: ...

    async def list_chunks(self, ref: ThreadRef) -> OpResult[list[ChunkRecord]]: ...

    async def derive_turn(self, ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]: ...

    async def derive_brief_chunk(self, ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]: ...

    async def derive_detailed_chunk(self, ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]: ...


class LhcThreadView(Protocol):
    """Wave 4/5/6 import seam: status, compact, context, prune, preview, materialize, session view."""

    async def get_llm_request_context(self, ref: ThreadRef) -> OpResult[LlmRequestContext]: ...

    async def get_session_thread_view(self, ref: ThreadRef) -> OpResult[SessionThreadView]: ...

    async def status(self, ref: ThreadRef) -> OpResult[ViewStatus]: ...

    async def compact(self, ref: ThreadRef, opts: CompactOpts) -> OpResult[CompactReceipt]: ...

    async def preview_compact(
        self, ref: ThreadRef, opts: CompactOpts
    ) -> OpResult[PreviewCompactOutcome]: ...

    async def prune(
        self, ref: ThreadRef, params: PruneParams | None = None
    ) -> OpResult[PruneReceipt]: ...

    async def materialize(
        self, ref: ThreadRef, opts: MaterializeOpts
    ) -> OpResult[MaterializeResult]: ...

    async def describe(self, ref: ThreadRef) -> OpResult[StoredView | None]: ...


class Lhc(Protocol):
    threads: LhcThreads
    intake_stream: LhcIntakeStream
    messages: LhcMessages
    turns: LhcTurns
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


# Dispatch-time lookups: an unregistered kind is reported explicitly — never
# a throw, never a silent undefined. Mirrors packages/lhc/src/sdk.ts.
def lookup_work_handler(map: WorkHandlerMap, kind: str) -> OpResult[WorkHandler]:
    raise NotImplementedError


def lookup_work_dispatcher(
    map: DurableWorkDispatcherMap,
    operation: DurableWorkOperation | None,
    kind: str,
) -> OpResult[DurableWorkDispatcher]:
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
    "lookup_work_dispatcher",
    "lookup_work_handler",
    "register_testing_work",
    "set_scheduler_poke",
    "set_thread_touch",
    "write_log",
]
