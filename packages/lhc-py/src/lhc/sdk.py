"""Ported from packages/lhc/src/sdk.ts. Phase 1 skeleton.

Public SDK surface: namespace modules, init_lhc, work/logging/thread-view
protocols, and the type/value re-exports mirrors of sdk.ts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, TypeVar, TypedDict
from weakref import WeakKeyDictionary

from . import inspect, intake_stream, messages, thread_view, threads, turns
from .intake_stream import BatchResult, EventKind, EventRecord, MessageEventInput
from .messages import (
    Block,
    BlockType,
    EditInput,
    MessageCreateResult,
    MessageDeriveResult,
    MessageDetail,
    MessageListOptions,
    MessageRecord,
    MessageReportOpts,
    MutationResult,
    RecordedEvent,
    RemoveInput,
)
from .messages.internal.derive import dispatch_message_derive_work
from .messages.internal.handlers import message_work_handlers
from .shared_tech import logging
from .shared_tech.context import (
    InstanceSeam,
    run_with_instance_seam,
    set_scheduler_poke,
    set_thread_touch,
)
from .shared_tech.derivation import (
    INFERENCE_CALLBACK_OPERATIONS,
    CompletionTx,
    CompressionTargets,
    DependencyGap,
    Derivation,
    DerivationMetadata,
    DerivationReportEntry,
    DerivationState,
    HandlerDerivationWrite,
    HandlerOutcome,
    HandlerRunContext,
    InferenceCallbacks,
    InferenceResult,
    ProviderProvenance,
    RenderingPart,
    ResolvedSdkConfig,
    SdkConfig,
    SubjectKind,
    ToolOutcome,
    ToolResultClassification,
    ToolResultFacts,
    ToolResultOperationClass,
    ToolResultPromptMode,
    ToolResultResponseShape,
    WorkHandler,
)
from .shared_tech.deterministic import (
    DeterministicOpName,
    create_deterministic_inference_callbacks,
    deterministic_outcomes_suffix,
    deterministic_text,
)
from .shared_tech.durable_work import (
    DurableWorkDispatcher,
    DurableWorkDispatcherMap,
    DurableWorkDispatchResult,
    DurableWorkOperation,
    apply_derivation_success,
)
from .shared_tech.errors import ErrorClass, ErrorCode, ErrorResult, OpErr, OpResult, storage_failure
from .shared_tech.storage import Database
from .shared_tech.inference_adapter import create_inference_callbacks
from .shared_tech.inference_types import (
    InferenceConfig,
    ModelAssignment,
    ModelCall,
    ModelCallFailureKind,
    ModelCallInput,
    ModelCallResult,
    ResolvedDerivationGuards,
    ThinkingLevel,
    resolve_guards,
)
from .shared_tech.inspect import HealthReport, InspectOverview, ViewContentsReport
from .shared_tech.logging import (
    DerivationLogQuery,
    LogEntry,
    LogLevel,
    LogQuery,
    StoredDerivationLogEntry,
    StoredLogEntry,
    query_log,
    write_log,
)
from .shared_tech.persist import (
    DbReadTransaction,
    DbWriteTransaction,
    PostCommitHook,
    create_db_read_transaction,
    create_db_write_transaction,
)
from .shared_tech.prompts import DEFAULT_PROMPT_NAMES, PROMPT_NAMES, PROMPT_REGISTRY
from .shared_tech.scheduler import (
    DrainDeps,
    DrainReport,
    Scheduler,
    SchedulerMode,
    create_scheduler,
    peek_thread_id,
    run_drain,
)
from .shared_tech.token_counting import TOKEN_ESTIMATOR_ID, estimate_tokens
from .shared_tech.view import (
    Band,
    CompactReceipt,
    LlmRequestContext,
    LlmRequestContextMessage,
    LlmRequestContextPart,
    PreviewCompactOutcome,
    PreviewCompactResult,
    PruneReceipt,
    ResolvedViewConfig,
    SdkViewConfig,
    SessionAssistantMessage,
    SessionAssistantPart,
    SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry,
    SessionThreadView,
    SessionThreadViewEntry,
    SessionThreadViewEntrySource,
    SessionThreadViewMessage,
    SessionToolResultMessage,
    SessionUserMessage,
    StoredView,
    ViewCompactParams,
    ViewProfile,
    ViewProfileOverride,
    ViewStatus,
    VisibilityBudgets,
)
from .shared_tech.work_queue import (
    WORK_KIND_REGISTRY,
    ClaimedWorkItem,
    EnqueueDerivationTarget,
    EnqueueInput,
    QueueDetailRow,
    WorkHandlerMap,
    WorkItemRecord,
    WorkKind,
    WorkOwner,
    WorkSourceRef,
    count_live_items,
    enqueue,
    map_work_q_handlers,
    queue_detail,
    supersede_queued,
)
from .thread_view import (
    BUILT_IN_PROFILES,
    DEFAULT_COMPACT_THRESHOLD,
    DEFAULT_VISIBILITY,
    CompactOpts,
    MaterializeOpts,
    MaterializeResult,
    PruneParams,
    resolve_view_config,
)
from .threads import (
    ListThreadsInput,
    NewThreadInput,
    NewThreadResult,
    ResolveInput,
    ResolvedThreadPath,
    ThreadFileInfo,
    ThreadInfo,
    ThreadRef,
    open_thread_database,
)
from .turns import (
    ChunkDeriveResult,
    ChunkRecord,
    CompactChunkMaterial,
    RecordedTurnEvent,
    TurnChunkStructure,
    TurnDeriveResult,
    TurnRecord,
    TurnReportOpts,
    TurnStateCorruptionError,
    TurnTransitionOutcome,
)
from .turns.internal.derive import dispatch_turn_owned_work, turn_work_handlers

# Closed over by Phase 2 init_lhc body; named for TS import fidelity.
_ = (
    INFERENCE_CALLBACK_OPERATIONS,
    PROMPT_REGISTRY,
    DrainDeps,
    apply_derivation_success,
    create_db_read_transaction,
    create_db_write_transaction,
    create_inference_callbacks,
    create_scheduler,
    dispatch_message_derive_work,
    dispatch_turn_owned_work,
    inspect,
    intake_stream,
    logging,
    map_work_q_handlers,
    message_work_handlers,
    messages,
    peek_thread_id,
    resolve_guards,
    resolve_view_config,
    run_drain,
    run_with_instance_seam,
    set_scheduler_poke,
    set_thread_touch,
    storage_failure,
    thread_view,
    threads,
    turn_work_handlers,
    turns,
)

T = TypeVar("T")


# TS WorkSurface.drain opts is inline `{ maxItems?: number }` — not a public export.
class _DrainOpts(TypedDict, total=False):
    maxItems: int


# The work surface used by CLI work operations.
class WorkSurface(Protocol):
    async def drain(
        self,
        ref: ThreadRef,
        opts: _DrainOpts | None = None,
    ) -> OpResult[DrainReport]: ...


# The thread-view surface as the SDK exposes it: operations only. Config
# substrate is construction machinery, not an operation. `describe` is the
# stored-snapshot read the inspect domain composes.
class ThreadViewSurface(Protocol):
    async def get_llm_request_context(self, ref: ThreadRef) -> OpResult[LlmRequestContext]: ...

    async def get_session_thread_view(self, ref: ThreadRef) -> OpResult[SessionThreadView]: ...

    async def status(self, ref: ThreadRef) -> OpResult[ViewStatus]: ...

    async def prune(
        self, ref: ThreadRef, params: PruneParams | None = None
    ) -> OpResult[PruneReceipt]: ...

    async def describe(self, ref: ThreadRef) -> OpResult[StoredView | None]: ...

    async def preview_compact(
        self, ref: ThreadRef, opts: CompactOpts
    ) -> OpResult[PreviewCompactOutcome]: ...

    async def compact(self, ref: ThreadRef, opts: CompactOpts) -> OpResult[CompactReceipt]: ...

    async def materialize(
        self, ref: ThreadRef, opts: MaterializeOpts
    ) -> OpResult[MaterializeResult]: ...


# Wave 1–6 import-seam alias — same surface as ThreadViewSurface.


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


class LhcThreads(Protocol):
    async def new_thread(self, input: NewThreadInput) -> OpResult[NewThreadResult]: ...

    async def resolve(self, input: ResolveInput) -> OpResult[ThreadInfo]: ...

    async def list_threads(self, input: ListThreadsInput | None = None) -> OpResult[list[ThreadInfo]]: ...

    async def info(self, ref: ThreadRef) -> OpResult[ThreadFileInfo]: ...

    async def resolve_thread_ref(self, ref: ThreadRef) -> OpResult[ResolvedThreadPath]: ...

    def open_thread_database(self, file_path: str) -> OpResult[Database]: ...


class LhcIntakeStream(Protocol):
    async def message_events(
        self,
        ref: ThreadRef,
        events: list[MessageEventInput] | tuple[MessageEventInput, ...],
    ) -> OpResult[BatchResult]: ...

    async def list_events(self, ref: ThreadRef) -> OpResult[list[EventRecord]]: ...


# TS: typeof intakeStreamDomain & { initLhc(config): Lhc }
class IntakeStreamSurface(LhcIntakeStream, Protocol):
    def init_lhc(self, config: SdkConfig) -> Lhc: ...


class LhcMessages(Protocol):
    def create(
        self,
        transaction: DbWriteTransaction,
        recorded_event: RecordedEvent,
        turn_id: str,
    ) -> MessageCreateResult: ...

    async def list(
        self,
        ref: ThreadRef,
        filter: MessageListOptions | None = None,
    ) -> OpResult[list[MessageRecord]]: ...

    def read_live_messages(self, db: Database) -> list[MessageRecord]: ...

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
    def create(
        self,
        transaction: DbWriteTransaction,
        recorded_event: RecordedTurnEvent,
    ) -> TurnTransitionOutcome: ...

    async def list_turns(self, ref: ThreadRef) -> OpResult[list[TurnRecord]]: ...

    async def list_chunks(self, ref: ThreadRef) -> OpResult[list[ChunkRecord]]: ...

    def get_chunk_text(
        self,
        transaction: DbReadTransaction,
        chunk_id: str,
        derivation_type: Literal[
            "chunk_summary_detailed", "chunk_summary_brief"
        ] = "chunk_summary_detailed",
    ) -> CompactChunkMaterial: ...

    def read_turn_chunk_structure(self, db: Database) -> TurnChunkStructure: ...

    async def report(
        self,
        ref: ThreadRef,
        opts: TurnReportOpts | None = None,
    ) -> OpResult[list[DerivationReportEntry]]: ...

    async def derive_turn(self, ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]: ...

    async def derive_brief_chunk(self, ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]: ...

    async def derive_detailed_chunk(self, ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]: ...

    # Exported class on the turns domain namespace (TS `export class TurnStateCorruptionError`).
    TurnStateCorruptionError: type[TurnStateCorruptionError]


class LhcInspect(Protocol):
    async def overview(self, ref: ThreadRef) -> OpResult[InspectOverview]: ...

    async def health(self, ref: ThreadRef) -> OpResult[HealthReport]: ...

    async def view(self, ref: ThreadRef) -> OpResult[ViewContentsReport]: ...


class Lhc(Protocol):
    threads: LhcThreads
    intake_stream: IntakeStreamSurface
    messages: LhcMessages
    turns: LhcTurns
    thread_view: ThreadViewSurface
    # Read-only report surface. Scoped through the instance seam like every other
    # namespace so composed status reads resolve this SDK's view config.
    inspect: LhcInspect
    logging: LoggingSurface
    config: ResolvedSdkConfig
    scheduler: Scheduler
    work: WorkSurface

    # Resolves when the scheduler has no running or pending drain for the
    # thread (issue 3) — the awaitable for background mode, and a no-op
    # resolve in manual mode.
    async def drain_settled(self, ref: ThreadRef) -> None: ...


# TS registerTestingWork registration bag is inline — not a public export.
class _TestingWorkRegistration(TypedDict, total=False):
    handlers: WorkHandlerMap
    dispatchers: DurableWorkDispatcherMap


@dataclass(frozen=True, slots=True)
class _WorkRegistration:
    work_handlers: WorkHandlerMap
    work_dispatchers: DurableWorkDispatcherMap


_work_registration_by_sdk: WeakKeyDictionary[Lhc, _WorkRegistration] = WeakKeyDictionary()

_INIT_CONFIG_PREFIX = "initLhc config"


@dataclass(frozen=True, slots=True)
class _DefaultInferenceLane:
    provider: str
    model: str


# The default provider lane and model for inference derivation types, used
# when the host omits an inference type from inference.assignments. The
# provider key is a host routing key; LHC never resolves it.
_DEFAULT_INFERENCE_LANE = _DefaultInferenceLane(provider="codex", model="gpt-5.4-mini")

# Default assignment per inference derivation type: documented default lane and
# model, registry default prompt template, and tested target ratios for
# compression/brief types. Deterministic derivations are not inference
# assignments. Construction-internal: defaults are observable through routed
# calls, not part of the public export surface.
_DEFAULT_INFERENCE_THINKING: ThinkingLevel = "none"

_DEFAULT_INFERENCE_ASSIGNMENTS: dict[str, ModelAssignment] = {
    "smoothed_prompt": ModelAssignment(
        provider=_DEFAULT_INFERENCE_LANE.provider,
        model=_DEFAULT_INFERENCE_LANE.model,
        prompt=DEFAULT_PROMPT_NAMES.get("smoothed_prompt", "smoothing-v1"),
        thinking=_DEFAULT_INFERENCE_THINKING,
    ),
    "tool_result_summary": ModelAssignment(
        provider=_DEFAULT_INFERENCE_LANE.provider,
        model=_DEFAULT_INFERENCE_LANE.model,
        prompt=DEFAULT_PROMPT_NAMES.get("tool_result_summary", "tool-result-v2"),
        thinking=_DEFAULT_INFERENCE_THINKING,
    ),
    "detailed_turn_compression": ModelAssignment(
        provider=_DEFAULT_INFERENCE_LANE.provider,
        model=_DEFAULT_INFERENCE_LANE.model,
        # Stated prompt target (v3) is lower than these ratios — see detailed-turn-compression-v3.ts.
        prompt=DEFAULT_PROMPT_NAMES.get("detailed_turn_compression", "detailed-turn-compression-v3"),
        # These ratios (and the targets stated in prompts) are steering, not decided
        # specs or tolerances. Ballparks that get the model in the zone; adjust freely.
        target_min_ratio=0.35,
        target_max_ratio=0.65,
        target_aim_ratio=0.5,
        thinking=_DEFAULT_INFERENCE_THINKING,
    ),
    "chunk_summary_brief": ModelAssignment(
        provider=_DEFAULT_INFERENCE_LANE.provider,
        model=_DEFAULT_INFERENCE_LANE.model,
        # Stated prompt target (v3) is lower than these ratios — see chunk-brief-v3.ts.
        prompt=DEFAULT_PROMPT_NAMES.get("chunk_summary_brief", "chunk-brief-v3"),
        # Steering, not specs — see the comment on detailed_turn_compression above.
        target_min_ratio=0.08,
        target_max_ratio=0.2,
        target_aim_ratio=0.12,
        thinking=_DEFAULT_INFERENCE_THINKING,
    ),
}


def _unknown_work_kind(kind: str) -> OpErr:
    raise NotImplementedError


def _require_positive(value: float, name: str) -> None:
    raise NotImplementedError


# Bind a domain surface to one SDK instance's delivery seam (epic-fix-001):
# every operation invoked through sdk.* runs inside run_with_instance_seam, so
# the poke/touch it triggers deep inside reaches THIS SDK's scheduler
# (background) or a no-op (manual) — never another SDK's. Non-function exports
# pass through unchanged. The wrapped object is the same shape as the
# namespace, so the public surface type holds.
def _scope_surface(surface: T, seam: InstanceSeam) -> T:
    raise NotImplementedError


def _resolve_target_ratios(
    kind: Literal["detailed_turn_compression", "chunk_summary_brief"],
    assignment: ModelAssignment | None = None,
) -> CompressionTargets:
    raise NotImplementedError


# Resolve the `inference` construction path: validate the host function and
# assignment map, then fill defaults. Provided inference assignments must carry
# non-empty provider/model and a registry-known prompt. Inference types the host
# omits are filled from DEFAULT_INFERENCE_ASSIGNMENTS. Unknown keys are
# rejected, never silently ignored. Then the adapter is built into the same
# InferenceCallbacks slot direct injection uses. No partial construction: every
# mistake throws before anything is assembled.
def _resolve_inference_callbacks(
    inference: InferenceConfig,
    guards: ResolvedDerivationGuards,
) -> InferenceCallbacks:
    raise NotImplementedError


# Dispatch-time lookup: an unregistered kind is reported explicitly — never
# a throw, never a silent undefined.
def lookup_work_handler(map: WorkHandlerMap, kind: str) -> OpResult[WorkHandler]:
    raise NotImplementedError


def lookup_work_dispatcher(
    map: DurableWorkDispatcherMap,
    operation: DurableWorkOperation | None,
    kind: str,
) -> OpResult[DurableWorkDispatcher]:
    raise NotImplementedError


def register_testing_work(sdk: Lhc, registration: _TestingWorkRegistration) -> None:
    raise NotImplementedError


# The only initialization path: inference callbacks, mode, clock, and policy enter here.
# Config mistakes are programmer errors at construction and throw; operating
# failures after construction return OpResults per the error contract.
def init_lhc(config: SdkConfig) -> Lhc:
    raise NotImplementedError


__all__ = [
    "BUILT_IN_PROFILES",
    "Band",
    "BatchResult",
    "Block",
    "BlockType",
    "ChunkRecord",
    "ClaimedWorkItem",
    "CompactReceipt",
    "CompletionTx",
    "DEFAULT_COMPACT_THRESHOLD",
    "DEFAULT_PROMPT_NAMES",
    "DEFAULT_VISIBILITY",
    "DbReadTransaction",
    "DbWriteTransaction",
    "DependencyGap",
    "Derivation",
    "DerivationMetadata",
    "DerivationReportEntry",
    "DerivationState",
    "DeterministicOpName",
    "DrainReport",
    "DurableWorkDispatchResult",
    "DurableWorkDispatcher",
    "DurableWorkDispatcherMap",
    "DurableWorkOperation",
    "EnqueueDerivationTarget",
    "EnqueueInput",
    "ErrorClass",
    "ErrorCode",
    "ErrorResult",
    "EventKind",
    "EventRecord",
    "HandlerDerivationWrite",
    "HandlerOutcome",
    "HandlerRunContext",
    "HealthReport",
    "InferenceCallbacks",
    "InferenceConfig",
    "InferenceResult",
    "InspectOverview",
    "IntakeStreamSurface",
    "Lhc",
    "LlmRequestContext",
    "LlmRequestContextMessage",
    "LlmRequestContextPart",
    "LogEntry",
    "LogLevel",
    "LogQuery",
    "LoggingSurface",
    "MessageDetail",
    "MessageEventInput",
    "MessageListOptions",
    "MessageRecord",
    "ModelAssignment",
    "ModelCall",
    "ModelCallFailureKind",
    "ModelCallInput",
    "ModelCallResult",
    "MutationResult",
    "OpResult",
    "PROMPT_NAMES",
    "PostCommitHook",
    "PreviewCompactOutcome",
    "PreviewCompactResult",
    "ProviderProvenance",
    "PruneReceipt",
    "QueueDetailRow",
    "RenderingPart",
    "ResolvedSdkConfig",
    "ResolvedViewConfig",
    "Scheduler",
    "SchedulerMode",
    "SdkConfig",
    "SdkViewConfig",
    "SessionAssistantMessage",
    "SessionAssistantPart",
    "SessionModelChangeEntry",
    "SessionThinkingLevelChangeEntry",
    "SessionThreadView",
    "SessionThreadViewEntry",
    "SessionThreadViewEntrySource",
    "SessionThreadViewMessage",
    "SessionToolResultMessage",
    "SessionUserMessage",
    "StoredLogEntry",
    "StoredView",
    "SubjectKind",
    "TOKEN_ESTIMATOR_ID",
    "ThreadFileInfo",
    "ThreadRef",
    "ThreadViewSurface",
    "ToolOutcome",
    "ToolResultClassification",
    "ToolResultFacts",
    "ToolResultOperationClass",
    "ToolResultPromptMode",
    "ToolResultResponseShape",
    "TurnRecord",
    "ViewCompactParams",
    "ViewContentsReport",
    "ViewProfile",
    "ViewProfileOverride",
    "ViewStatus",
    "VisibilityBudgets",
    "WORK_KIND_REGISTRY",
    "WorkHandler",
    "WorkHandlerMap",
    "WorkItemRecord",
    "WorkKind",
    "WorkOwner",
    "WorkSourceRef",
    "WorkSurface",
    "apply_derivation_success",
    "count_live_items",
    "create_db_read_transaction",
    "create_db_write_transaction",
    "create_deterministic_inference_callbacks",
    "deterministic_outcomes_suffix",
    "deterministic_text",
    "enqueue",
    "estimate_tokens",
    "init_lhc",
    "inspect",
    "intake_stream",
    "logging",
    "lookup_work_dispatcher",
    "lookup_work_handler",
    "map_work_q_handlers",
    "messages",
    "query_log",
    "queue_detail",
    "register_testing_work",
    "set_scheduler_poke",
    "set_thread_touch",
    "supersede_queued",
    "thread_view",
    "threads",
    "turns",
    "write_log",
]
