"""Ported from packages/lhc/src/sdk.ts.

Public SDK surface: namespace modules, init_lhc, work/logging/thread-view
protocols, and the type/value re-exports mirrors of sdk.ts.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
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
from .messages.internal.derive import (
    DispatchMessageDeriveWorkItem,
    dispatch_message_derive_work,
)
from .messages.internal.handlers import message_work_handlers
from .shared_tech import logging
from .shared_tech._jsstr import js_json_dumps, js_repr
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
    BriefTargets,
    ChunkPolicyConfig,
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
    LeaseConfig,
    ProviderProvenance,
    RenderingPart,
    ResolvedSdkConfig,
    SdkConfig,
    SubjectKind,
    ToolOutcome,
    ToolResultConfig,
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
    DurableWorkDispatcherItem,
    DurableWorkDispatcherMap,
    DurableWorkDispatchResult,
    DurableWorkOperation,
    apply_derivation_success,
)
from .shared_tech.errors import ErrorClass, ErrorCode, ErrorResult, OpErr, OpOk, OpResult, storage_failure
from .shared_tech.storage import Database, open_database
from .shared_tech.inference_adapter import create_inference_callbacks
from .shared_tech.inference_types import (
    InferenceConfig,
    ModelAssignment,
    ModelCall,
    ModelCallFailureKind,
    ModelCallInput,
    ModelCallResult,
    ResolvedInferenceConfig,
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
    query_derivation_log,
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
    DrainOpts,
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
from .turns.internal.derive import (
    DispatchTurnOwnedWorkItem,
    dispatch_turn_owned_work,
    turn_work_handlers,
)

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
        events: Sequence[MessageEventInput],
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


# Phase 2's Lhc implementation must be weak-referenceable and hashable
# (plain class or dataclass(slots=True, weakref_slot=True, eq=False));
# frozen+slots dataclass will not work as a WeakKeyDictionary key.
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
    return OpErr(
        error=ErrorResult(
            error_class="state_corruption",
            code="unknown_work_kind",
            reason=f'no handler registered for work kind "{kind}"',
        )
    )


def _require_positive(value: float, name: str) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise TypeError(f"{_INIT_CONFIG_PREFIX}: {name} must be a positive number, got {js_repr(value)}")


# Bind a domain surface to one SDK instance's delivery seam (epic-fix-001):
# every operation invoked through sdk.* runs inside run_with_instance_seam, so
# the poke/touch it triggers deep inside reaches THIS SDK's scheduler
# (background) or a no-op (manual) — never another SDK's. Non-function exports
# pass through unchanged. The wrapped object is the same shape as the
# namespace, so the public surface type holds.
def _scope_surface(surface: T, seam: InstanceSeam) -> T:
    class _Scoped:
        def __getattr__(self, key: str) -> object:
            value = getattr(surface, key)
            if not callable(value):
                return value

            def scoped(*args: object, **kwargs: object) -> object:
                return run_with_instance_seam(seam, lambda: value(*args, **kwargs))

            return scoped

    return _Scoped()  # type: ignore[return-value]


def _resolve_target_ratios(
    kind: Literal["detailed_turn_compression", "chunk_summary_brief"],
    assignment: ModelAssignment | None = None,
) -> CompressionTargets:
    defaults = _DEFAULT_INFERENCE_ASSIGNMENTS[kind]
    return CompressionTargets(
        min_ratio=(
            assignment.target_min_ratio
            if assignment is not None and assignment.target_min_ratio is not None
            else defaults.target_min_ratio  # type: ignore[arg-type]
        ),
        aim_ratio=(
            assignment.target_aim_ratio
            if assignment is not None and assignment.target_aim_ratio is not None
            else defaults.target_aim_ratio  # type: ignore[arg-type]
        ),
        max_ratio=(
            assignment.target_max_ratio
            if assignment is not None and assignment.target_max_ratio is not None
            else defaults.target_max_ratio  # type: ignore[arg-type]
        ),
    )


def _assignment_from(value: object, kind: str) -> ModelAssignment:
    if isinstance(value, ModelAssignment):
        return value
    if not isinstance(value, dict):
        raise TypeError(f"{_INIT_CONFIG_PREFIX}: inference.assignments.{kind} must be an object")
    return ModelAssignment(
        provider=value.get("provider"),  # type: ignore[arg-type]
        model=value.get("model"),  # type: ignore[arg-type]
        prompt=value.get("prompt"),  # type: ignore[arg-type]
        target_min_ratio=value.get("targetMinRatio", value.get("target_min_ratio")),  # type: ignore[arg-type]
        target_aim_ratio=value.get("targetAimRatio", value.get("target_aim_ratio")),  # type: ignore[arg-type]
        target_max_ratio=value.get("targetMaxRatio", value.get("target_max_ratio")),  # type: ignore[arg-type]
        thinking=value.get("thinking"),  # type: ignore[arg-type]
    )


def _merge_assignment(default: ModelAssignment, override: ModelAssignment) -> ModelAssignment:
    return ModelAssignment(
        provider=override.provider,
        model=override.model,
        prompt=override.prompt,
        target_min_ratio=(
            override.target_min_ratio
            if override.target_min_ratio is not None
            else default.target_min_ratio
        ),
        target_aim_ratio=(
            override.target_aim_ratio
            if override.target_aim_ratio is not None
            else default.target_aim_ratio
        ),
        target_max_ratio=(
            override.target_max_ratio
            if override.target_max_ratio is not None
            else default.target_max_ratio
        ),
        thinking=override.thinking if override.thinking is not None else default.thinking,
    )


def _merge_assignment_value(
    default: ModelAssignment, value: object, kind: str
) -> ModelAssignment:
    if not isinstance(value, dict):
        return _merge_assignment(default, _assignment_from(value, kind))
    return ModelAssignment(
        provider=value.get("provider", default.provider),  # type: ignore[arg-type]
        model=value.get("model", default.model),  # type: ignore[arg-type]
        prompt=value.get("prompt", default.prompt),  # type: ignore[arg-type]
        target_min_ratio=value.get(
            "targetMinRatio", value.get("target_min_ratio", default.target_min_ratio)
        ),  # type: ignore[arg-type]
        target_aim_ratio=value.get(
            "targetAimRatio", value.get("target_aim_ratio", default.target_aim_ratio)
        ),  # type: ignore[arg-type]
        target_max_ratio=value.get(
            "targetMaxRatio", value.get("target_max_ratio", default.target_max_ratio)
        ),  # type: ignore[arg-type]
        thinking=value.get("thinking", default.thinking),  # type: ignore[arg-type]
    )


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
    if isinstance(inference, dict):
        call = inference.get("call")
        provided = inference.get("assignments", {})
        timeout_ms = inference.get("timeoutMs", inference.get("timeout_ms", 60_000))
        max_input_chars = inference.get("maxInputChars", inference.get("max_input_chars", 200_000))
    else:
        call = inference.call
        provided = inference.assignments if inference.assignments is not None else {}
        timeout_ms = inference.timeout_ms if inference.timeout_ms is not None else 60_000
        max_input_chars = inference.max_input_chars if inference.max_input_chars is not None else 200_000
    if not callable(call):
        raise TypeError(f"{_INIT_CONFIG_PREFIX}: inference.call must be a function")
    if not isinstance(provided, dict):
        raise TypeError(f"{_INIT_CONFIG_PREFIX}: inference.assignments must be an object")

    inference_keys = set(_DEFAULT_INFERENCE_ASSIGNMENTS)
    for key in provided:
        if key not in inference_keys:
            raise TypeError(
                f'{_INIT_CONFIG_PREFIX}: inference.assignments has unknown derivation type "{key}"'
            )

    merged: dict[str, ModelAssignment] = {}
    for kind, default in _DEFAULT_INFERENCE_ASSIGNMENTS.items():
        assignment = (
            _merge_assignment_value(default, provided[kind], kind)
            if kind in provided
            else default
        )
        for field in ("provider", "model", "prompt"):
            value = getattr(assignment, field)
            if not isinstance(value, str) or value.strip() == "":
                raise TypeError(
                    f"{_INIT_CONFIG_PREFIX}: inference.assignments.{kind}.{field} must be a non-empty string"
                )
        for field in ("target_min_ratio", "target_aim_ratio", "target_max_ratio"):
            value = getattr(assignment, field)
            if value is not None and (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value <= 0
            ):
                public = {
                    "target_min_ratio": "targetMinRatio",
                    "target_aim_ratio": "targetAimRatio",
                    "target_max_ratio": "targetMaxRatio",
                }[field]
                raise TypeError(
                    f"{_INIT_CONFIG_PREFIX}: inference.assignments.{kind}.{public} must be a positive number"
                )
        if assignment.prompt not in PROMPT_REGISTRY:
            raise TypeError(
                f'{_INIT_CONFIG_PREFIX}: inference.assignments.{kind}.prompt names unknown template "{assignment.prompt}"'
            )
        merged[kind] = assignment

    _require_positive(timeout_ms, "inference.timeoutMs")  # type: ignore[arg-type]
    _require_positive(max_input_chars, "inference.maxInputChars")  # type: ignore[arg-type]
    return create_inference_callbacks(
        ResolvedInferenceConfig(
            call=call,  # type: ignore[arg-type]
            assignments=merged,
            guards=guards,
            timeout_ms=timeout_ms,  # type: ignore[arg-type]
            max_input_chars=max_input_chars,  # type: ignore[arg-type]
        )
    )


# Dispatch-time lookup: an unregistered kind is reported explicitly — never
# a throw, never a silent undefined.
def lookup_work_handler(map: WorkHandlerMap, kind: str) -> OpResult[WorkHandler]:
    handler = map.get(kind)  # type: ignore[arg-type]
    return _unknown_work_kind(kind) if handler is None else OpOk(value=handler)


def lookup_work_dispatcher(
    map: DurableWorkDispatcherMap,
    operation: DurableWorkOperation | None,
    kind: str,
) -> OpResult[DurableWorkDispatcher]:
    if operation is None:
        return _unknown_work_kind(kind)
    dispatcher = map.get(operation.operation)
    return _unknown_work_kind(kind) if dispatcher is None else OpOk(value=dispatcher)


def register_testing_work(sdk: Lhc, registration: _TestingWorkRegistration) -> None:
    target = _work_registration_by_sdk.get(sdk)
    if target is None:
        raise TypeError("registerTestingWork called with an SDK not created by initLhc")
    target.work_handlers.update(registration.get("handlers", {}))
    target.work_dispatchers.update(registration.get("dispatchers", {}))


def _config_value(config: object, snake: str, camel: str | None = None) -> object:
    if isinstance(config, dict):
        return config.get(camel or snake, config.get(snake))
    return getattr(config, snake)


def _coerce_guards(value: object) -> object:
    if not isinstance(value, dict):
        return value
    from .shared_tech.inference_types import (
        DerivationGuards,
        DetailedTurnCompressionGuards,
        SmoothedPromptGuards,
        ToolResultSummaryGuards,
    )

    smoothed = value.get("smoothedPrompt", value.get("smoothed_prompt"))
    tool = value.get("toolResultSummary", value.get("tool_result_summary"))
    detailed = value.get("detailedTurnCompression", value.get("detailed_turn_compression"))
    return DerivationGuards(
        smoothed_prompt=(
            SmoothedPromptGuards(
                max_inference_tokens=smoothed.get(
                    "maxInferenceTokens", smoothed.get("max_inference_tokens")
                ),
                suspicious_output_ratio=smoothed.get(
                    "suspiciousOutputRatio", smoothed.get("suspicious_output_ratio")
                ),
            )
            if isinstance(smoothed, dict)
            else None
        ),
        tool_result_summary=(
            ToolResultSummaryGuards(
                timeout_ms=tool.get("timeoutMs", tool.get("timeout_ms"))
            )
            if isinstance(tool, dict)
            else None
        ),
        detailed_turn_compression=(
            DetailedTurnCompressionGuards(
                tiny_turn_tokens=detailed.get(
                    "tinyTurnTokens", detailed.get("tiny_turn_tokens")
                )
            )
            if isinstance(detailed, dict)
            else None
        ),
    )


class _LhcImpl:
    pass


class _IntakeStreamSurface:
    """TS: typeof intakeStreamDomain & { initLhc } — domain ops plus re-entry."""

    message_events = staticmethod(intake_stream.message_events)
    list_events = staticmethod(intake_stream.list_events)
    # Bound after init_lhc is defined (see bottom of this module).
    init_lhc: Callable[[SdkConfig], Lhc]


# The only initialization path: inference callbacks, mode, clock, and policy enter here.
# Config mistakes are programmer errors at construction and throw; operating
# failures after construction return OpResults per the error contract.
def init_lhc(config: SdkConfig) -> Lhc:
    direct = _config_value(config, "inference_callbacks", "inferenceCallbacks")
    inference = _config_value(config, "inference")
    if (direct is None) == (inference is None):
        raise TypeError(f"{_INIT_CONFIG_PREFIX}: exactly one of inferenceCallbacks or inference")

    mode = _config_value(config, "mode")
    if mode not in ("background", "manual"):
        raise TypeError(
            f'{_INIT_CONFIG_PREFIX}: mode must be "background" or "manual", got {js_json_dumps(mode)}'
        )

    guards = resolve_guards(_coerce_guards(_config_value(config, "guards")))  # type: ignore[arg-type]
    provided_assignments: object = None
    if isinstance(inference, dict):
        provided_assignments = inference.get("assignments")
    elif inference is not None:
        provided_assignments = inference.assignments
    assignment_map = provided_assignments if isinstance(provided_assignments, dict) else {}
    detailed_assignment = (
        _assignment_from(assignment_map["detailed_turn_compression"], "detailed_turn_compression")
        if "detailed_turn_compression" in assignment_map
        else None
    )
    brief_assignment = (
        _assignment_from(assignment_map["chunk_summary_brief"], "chunk_summary_brief")
        if "chunk_summary_brief" in assignment_map
        else None
    )
    compression_targets = _resolve_target_ratios(
        "detailed_turn_compression", detailed_assignment
    )
    brief_values = _resolve_target_ratios("chunk_summary_brief", brief_assignment)

    if inference is not None:
        inference_callbacks = _resolve_inference_callbacks(inference, guards)  # type: ignore[arg-type]
    else:
        if direct is None or isinstance(direct, (str, bytes, int, float, bool)):
            raise TypeError(
                f"{_INIT_CONFIG_PREFIX}: inferenceCallbacks must implement InferenceCallbacks"
            )
        operation_names = {
            "smoothPrompt": "smooth_prompt",
            "summarizeToolResult": "summarize_tool_result",
            "compressDetailedTurn": "compress_detailed_turn",
            "summarizeChunkBrief": "summarize_chunk_brief",
        }
        for public, python_name in operation_names.items():
            value = direct.get(python_name) if isinstance(direct, dict) else getattr(direct, python_name, None)
            if not callable(value):
                raise TypeError(
                    f"{_INIT_CONFIG_PREFIX}: inferenceCallbacks is missing operation {public}"
                )
        inference_callbacks = direct  # type: ignore[assignment]

    tool_value = _config_value(config, "tool_result", "toolResult")
    if isinstance(tool_value, dict):
        tool_config = ToolResultConfig(
            small_tier_tokens=tool_value.get("smallTierTokens", tool_value.get("small_tier_tokens")),
            small_target_ratio=tool_value.get("smallTargetRatio", tool_value.get("small_target_ratio")),
            mid_target_ratio=tool_value.get("midTargetRatio", tool_value.get("mid_target_ratio")),
        )
    else:
        tool_config = tool_value or ToolResultConfig(1000, 0.15, 0.04)
    lease_value = _config_value(config, "lease")
    if isinstance(lease_value, dict):
        lease_config = LeaseConfig(
            duration_ms=lease_value.get("durationMs", lease_value.get("duration_ms"))
        )
    else:
        lease_config = lease_value or LeaseConfig(120_000)
    chunk_value = _config_value(config, "chunk_policy", "chunkPolicy")
    if isinstance(chunk_value, dict):
        chunk_config = ChunkPolicyConfig(
            target_projected_tokens=chunk_value.get(
                "targetProjectedTokens", chunk_value.get("target_projected_tokens")
            ),
            max_projected_tokens=chunk_value.get(
                "maxProjectedTokens", chunk_value.get("max_projected_tokens")
            ),
        )
    else:
        chunk_config = chunk_value or ChunkPolicyConfig(2200, 4400)

    view_value = _config_value(config, "view")
    if view_value is None:
        view_config = ResolvedViewConfig(
            profiles={profile.name: profile for profile in BUILT_IN_PROFILES},
            visibility=DEFAULT_VISIBILITY,
            compact_threshold=DEFAULT_COMPACT_THRESHOLD,
        )
    else:
        view_config = resolve_view_config(view_value)  # type: ignore[arg-type]

    clock = _config_value(config, "clock")
    resolved = ResolvedSdkConfig(
        inference_callbacks=inference_callbacks,
        mode=mode,  # type: ignore[arg-type]
        clock=clock if callable(clock) else lambda: datetime.now(timezone.utc),
        guards=guards,
        compression_targets=compression_targets,
        brief_targets=BriefTargets(
            min_ratio=brief_values.min_ratio,
            aim_ratio=brief_values.aim_ratio,
            max_ratio=brief_values.max_ratio,
        ),
        tool_result=tool_config,  # type: ignore[arg-type]
        lease=lease_config,  # type: ignore[arg-type]
        chunk_policy=chunk_config,  # type: ignore[arg-type]
        view=view_config,
    )

    checks = (
        (resolved.guards.smoothed_prompt.max_inference_tokens, "guards.smoothedPrompt.maxInferenceTokens"),
        (resolved.guards.smoothed_prompt.suspicious_output_ratio, "guards.smoothedPrompt.suspiciousOutputRatio"),
        (resolved.guards.tool_result_summary.timeout_ms, "guards.toolResultSummary.timeoutMs"),
        (resolved.guards.detailed_turn_compression.tiny_turn_tokens, "guards.detailedTurnCompression.tinyTurnTokens"),
        (resolved.compression_targets.min_ratio, "compressionTargets.minRatio"),
        (resolved.compression_targets.aim_ratio, "compressionTargets.aimRatio"),
        (resolved.compression_targets.max_ratio, "compressionTargets.maxRatio"),
        (resolved.brief_targets.min_ratio, "briefTargets.minRatio"),
        (resolved.brief_targets.aim_ratio, "briefTargets.aimRatio"),
        (resolved.brief_targets.max_ratio, "briefTargets.maxRatio"),
        (resolved.tool_result.small_tier_tokens, "toolResult.smallTierTokens"),
        (resolved.tool_result.small_target_ratio, "toolResult.smallTargetRatio"),
        (resolved.tool_result.mid_target_ratio, "toolResult.midTargetRatio"),
        (resolved.lease.duration_ms, "lease.durationMs"),
        (resolved.chunk_policy.target_projected_tokens, "chunkPolicy.targetProjectedTokens"),
    )
    for value, name in checks:
        _require_positive(value, name)
    for targets, name in (
        (resolved.compression_targets, "compressionTargets"),
        (resolved.brief_targets, "briefTargets"),
    ):
        if targets.max_ratio < targets.min_ratio:
            raise TypeError(f"{_INIT_CONFIG_PREFIX}: {name}.maxRatio must be >= minRatio")
        if not targets.min_ratio <= targets.aim_ratio <= targets.max_ratio:
            raise TypeError(
                f"{_INIT_CONFIG_PREFIX}: {name}.aimRatio must be between minRatio and maxRatio"
            )
    if resolved.chunk_policy.max_projected_tokens < resolved.chunk_policy.target_projected_tokens:
        raise TypeError(
            f"{_INIT_CONFIG_PREFIX}: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens"
        )

    # Handler maps merge from per-domain contributions at construction.
    work_handlers = map_work_q_handlers([message_work_handlers, turn_work_handlers])

    async def _dispatch_message_derive(
        run: HandlerRunContext, item: DurableWorkDispatcherItem
    ) -> DurableWorkDispatchResult:
        return await dispatch_message_derive_work(
            run,
            DispatchMessageDeriveWorkItem(
                work_item_id=item.work_item_id,
                source_version=item.source_version,
                derivations=item.derivations,
            ),
        )

    def _dispatch_turn_owned(kind: WorkKind) -> DurableWorkDispatcher:
        async def _dispatch(
            run: HandlerRunContext, item: DurableWorkDispatcherItem
        ) -> DurableWorkDispatchResult:
            return await dispatch_turn_owned_work(
                run,
                DispatchTurnOwnedWorkItem(
                    work_item_id=item.work_item_id,
                    kind=kind,
                    source_ref=item.source_ref,
                    source_version=item.source_version,
                    derivations=item.derivations,
                ),
            )

        return _dispatch

    work_dispatchers: DurableWorkDispatcherMap = {
        "messages.derive": _dispatch_message_derive,
        "turns.deriveTurn": _dispatch_turn_owned("turn_derivation"),
        "turns.deriveDetailedTurnCompression": _dispatch_turn_owned("detailed_turn_compression"),
        "turns.deriveDetailedChunk": _dispatch_turn_owned("chunk_summary_detailed"),
        "turns.deriveBriefChunk": _dispatch_turn_owned("chunk_summary_brief"),
    }

    drain_deps = DrainDeps(
        lookup_dispatcher=lambda operation, kind: lookup_work_dispatcher(
            work_dispatchers, operation, kind
        ),
        has_any_handler=lambda: len(work_dispatchers) > 0,
        config=resolved,
        open_thread_database=threads.open_thread_database,
    )
    scheduler = create_scheduler(resolved.mode, drain_deps)

    # Per-instance delivery seam. Background installs real poke/touch; manual
    # installs no-ops so construction order never auto-drains a manual SDK.
    if resolved.mode == "background":
        seam = InstanceSeam(
            poke=scheduler.poke,
            touch=scheduler.touch,
            view=resolved.view,
            config=resolved,
        )
        set_scheduler_poke(scheduler.poke)
        set_thread_touch(scheduler.touch)
    else:
        seam = InstanceSeam(
            poke=lambda _thread_id: None,
            touch=lambda _file_path, _db: None,
            view=resolved.view,
            config=resolved,
        )

    intake_surface = _IntakeStreamSurface()
    intake_surface.init_lhc = init_lhc

    class _Logging:
        async def write(self, ref: ThreadRef, entry: LogEntry) -> OpResult[None]:
            if isinstance(entry, dict):
                entry = LogEntry(
                    level=entry["level"],
                    message=entry["message"],
                    derivation_type=entry.get(
                        "derivationType", entry.get("derivation_type")
                    ),
                    subject_id=entry.get("subjectId", entry.get("subject_id")),
                    reason=entry.get("reason"),
                    floor_used=entry.get("floorUsed", entry.get("floor_used")),
                )

            async def _op() -> OpResult[None]:
                try:
                    written = await create_db_write_transaction(
                        ref,
                        lambda transaction: write_log(transaction, entry),
                        resolved.clock,
                    )
                    return OpOk(value=None) if written.ok else written
                except Exception as cause:  # noqa: BLE001 — mirrors TS catch
                    reason = str(cause)
                    return storage_failure(f"log write failed: {reason}")

            return await run_with_instance_seam(seam, _op)  # type: ignore[return-value]

        async def query(
            self, ref: ThreadRef, q: LogQuery
        ) -> OpResult[list[StoredLogEntry]]:
            if isinstance(q, dict):
                q = LogQuery(
                    level=q.get("level"),
                    derivation_type=q.get(
                        "derivationType", q.get("derivation_type")
                    ),
                    subject_id=q.get("subjectId", q.get("subject_id")),
                    reason=q.get("reason"),
                )

            async def _op() -> OpResult[list[StoredLogEntry]]:
                try:
                    return await create_db_read_transaction(
                        ref, lambda transaction: query_log(transaction.db, q)
                    )
                except Exception as cause:  # noqa: BLE001 — mirrors TS catch
                    reason = str(cause)
                    return storage_failure(f"log query failed: {reason}")

            return await run_with_instance_seam(seam, _op)  # type: ignore[return-value]

        async def query_derivation_log(
            self, ref: ThreadRef, q: DerivationLogQuery
        ) -> OpResult[list[StoredDerivationLogEntry]]:
            if isinstance(q, dict):
                q = DerivationLogQuery(
                    subject_kind=q.get("subjectKind", q.get("subject_kind")),
                    subject_id=q.get("subjectId", q.get("subject_id")),
                    derivation_type=q.get(
                        "derivationType", q.get("derivation_type")
                    ),
                    event_kind=q.get("eventKind", q.get("event_kind")),
                )

            async def _op() -> OpResult[list[StoredDerivationLogEntry]]:
                try:
                    return await create_db_read_transaction(
                        ref,
                        lambda transaction: query_derivation_log(transaction.db, q),
                    )
                except Exception as cause:  # noqa: BLE001 — mirrors TS catch
                    reason = str(cause)
                    return storage_failure(f"derivation log query failed: {reason}")

            return await run_with_instance_seam(seam, _op)  # type: ignore[return-value]

    class _Work:
        async def drain(
            self, ref: ThreadRef, opts: _DrainOpts | None = None
        ) -> OpResult[DrainReport]:
            async def _op() -> OpResult[DrainReport]:
                resolved_ref = await threads.resolve_thread_ref(ref)
                if not resolved_ref.ok:
                    return resolved_ref
                drain_opts: DrainOpts | None = None
                if opts is not None:
                    max_items = opts.get("maxItems", opts.get("max_items"))  # type: ignore[arg-type]
                    drain_opts = DrainOpts(max_items=max_items)  # type: ignore[arg-type]
                return await run_drain(
                    resolved_ref.value.file_path, drain_deps, drain_opts
                )

            return await run_with_instance_seam(seam, _op)  # type: ignore[return-value]

    sdk = _LhcImpl()
    sdk.threads = _scope_surface(threads, seam)
    sdk.intake_stream = _scope_surface(intake_surface, seam)
    sdk.messages = _scope_surface(messages, seam)
    sdk.turns = _scope_surface(turns, seam)
    sdk.thread_view = _scope_surface(thread_view, seam)
    sdk.inspect = _scope_surface(inspect, seam)
    sdk.logging = _Logging()
    sdk.config = resolved
    sdk.scheduler = scheduler
    sdk.work = _Work()

    async def drain_settled(ref: ThreadRef) -> None:
        resolved_ref = await threads.resolve_thread_ref(ref)
        if not resolved_ref.ok:
            return
        thread_id = peek_thread_id(resolved_ref.value.file_path)
        if thread_id is None:
            return
        await scheduler.drain_settled(thread_id)

    sdk.drain_settled = drain_settled
    _work_registration_by_sdk[sdk] = _WorkRegistration(work_handlers, work_dispatchers)
    return sdk  # type: ignore[return-value]


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
