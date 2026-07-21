"""Ported from packages/lhc/src/shared-tech/derivation.ts.

Shared derivation vocabulary: state machine types, the inference callback
boundary, and the handler contract. Both owning domains consume these;
neither owns them. Repair reports, mutation cascade, and drain all speak this
vocabulary across domain lines, so it lives in shared-tech.

Wave 1 completed the PARTIAL Wave 0 exemplar type subset — definitions that
were already present are unchanged; new surface is appended below.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Literal, Protocol, TypedDict, Union

from .inference_types import DerivationGuards, InferenceConfig, ResolvedDerivationGuards
from .storage import Database
from .view import ResolvedViewConfig, SdkViewConfig

ToolOutcome = Literal["succeeded", "failed", "unknown"]

SubjectKind = Literal["message", "turn", "chunk"]

DerivationState = Literal["pending", "ready", "failed", "blocked"]


# Recorded by the inference adapter (it alone knows the assignment) and copied
# by handlers into derivation metadata. Never derived from model output.
@dataclass(frozen=True, slots=True)
class ProviderProvenance:
    provider: str
    model: str
    prompt: str


class InferenceRequestMessage(TypedDict):
    role: Literal["system", "user"]
    content: str


@dataclass(frozen=True, slots=True)
class InferenceOk:
    text: str
    provenance: ProviderProvenance | None = None
    request_messages: list[InferenceRequestMessage] | None = None
    raw_response: str | None = None
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class InferenceErr:
    reason: str
    request_messages: list[InferenceRequestMessage] | None = None
    ok: Literal[False] = False


InferenceResult = Union[InferenceOk, InferenceErr]

ToolResultOperationClass = Literal[
    "read",
    "mutation_write",
    "mutation_edit",
    "command",
    "search_or_listing",
    "verification",
    "vcs_inspection",
    "filesystem_mutation",
    "multi_tool",
    "unknown",
]

ToolResultResponseShape = Literal[
    "structured_receipt",
    "simple_failure",
    "no_output",
    "search_result",
    "test_result",
    "file_content",
    "large_file_content",
    "diff_output",
    "large_log",
    "multi_tool_result",
    "unknown_content",
]

ToolResultPromptMode = Literal[
    "receipt",
    "failure",
    "no_output",
    "search_summary",
    "test_summary",
    "content_summary",
    "diff_summary",
    "large_log",
    "multi_tool_summary",
    "generic_summary",
]

# Facts dict keys are DATA, not identifiers — they stay camelCase exactly as
# in the TS ("exitCode", "toolName", ...). See the port brief's conventions.
ToolResultFacts = dict[str, object]


@dataclass(frozen=True, slots=True)
class ToolResultClassification:
    operation_class: ToolResultOperationClass
    response_shape: ToolResultResponseShape
    prompt_mode: ToolResultPromptMode
    facts: ToolResultFacts


class SmoothPromptInput(TypedDict):
    text: str


class SummarizeToolResultInput(TypedDict, total=False):
    toolName: str
    content: str
    outcome: ToolOutcome
    targetTokens: int
    operationClass: ToolResultOperationClass
    responseShape: ToolResultResponseShape
    promptMode: ToolResultPromptMode
    facts: ToolResultFacts


class CompressDetailedTurnInput(TypedDict):
    dialogueText: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class SummarizeChunkBriefInput(TypedDict):
    text: str
    inputTokens: int
    targetMinTokens: int
    targetAimTokens: int
    targetMaxTokens: int


class InferenceCallbacks(Protocol):
    def smooth_prompt(self, i: SmoothPromptInput) -> Awaitable[InferenceResult]: ...

    def summarize_tool_result(self, i: SummarizeToolResultInput) -> Awaitable[InferenceResult]: ...

    def compress_detailed_turn(self, i: CompressDetailedTurnInput) -> Awaitable[InferenceResult]: ...

    def summarize_chunk_brief(self, i: SummarizeChunkBriefInput) -> Awaitable[InferenceResult]: ...


# ── types appended in Wave 1 (complete derivation.ts surface) ──────────────


@dataclass(frozen=True, slots=True)
class DependencyGap:
    """A composed derivation's record of a dependency that fell back during composition:
    names the source record and the derivation type that was not ready.
    """

    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str


# Mechanically stamped derivation metadata: tool outcomes, fallback detail,
# and inference provenance. The queue is not an audit table; durable outcome
# detail lives on the derivation and in derivation logs.
@dataclass(frozen=True, slots=True)
class DerivationMetadata:
    outcome: ToolOutcome | None = None
    last_error: str | None = None
    discard_reason: str | None = None
    fallback_floor: str | None = None
    fallback_used: bool | None = None
    inference_attempted: bool | None = None
    inference_succeeded: bool | None = None
    size_disposition: Literal["in_range", "under_min", "over_max"] | None = None
    # Which provider/model/prompt produced the content, copied from the
    # InferenceResult's config-known strings, never authored from model output.
    # Deterministic domain assembly never sets it.
    provenance: ProviderProvenance | None = None


def decode_derivation_metadata(raw: object) -> DerivationMetadata:
    """Decode stored derivation.metadata JSON into DerivationMetadata.

    TS casts JSON.parse(...) as DerivationMetadata; Python must map camelCase
    keys and nested provenance explicitly.
    """
    if not isinstance(raw, dict):
        return DerivationMetadata()
    provenance_raw = raw.get("provenance")
    provenance = None
    if isinstance(provenance_raw, dict):
        provider = provenance_raw.get("provider")
        model = provenance_raw.get("model")
        prompt = provenance_raw.get("prompt")
        if (
            isinstance(provider, str)
            and isinstance(model, str)
            and isinstance(prompt, str)
        ):
            provenance = ProviderProvenance(
                provider=provider, model=model, prompt=prompt
            )
    size = raw.get("sizeDisposition")
    size_disposition: Literal["in_range", "under_min", "over_max"] | None = None
    if size in ("in_range", "under_min", "over_max"):
        size_disposition = size  # type: ignore[assignment]
    return DerivationMetadata(
        outcome=raw.get("outcome") if isinstance(raw.get("outcome"), str) else None,  # type: ignore[arg-type]
        last_error=raw.get("lastError") if isinstance(raw.get("lastError"), str) else None,
        discard_reason=(
            raw.get("discardReason") if isinstance(raw.get("discardReason"), str) else None
        ),
        fallback_floor=(
            raw.get("fallbackFloor") if isinstance(raw.get("fallbackFloor"), str) else None
        ),
        fallback_used=(
            raw.get("fallbackUsed") if isinstance(raw.get("fallbackUsed"), bool) else None
        ),
        inference_attempted=(
            raw.get("inferenceAttempted")
            if isinstance(raw.get("inferenceAttempted"), bool)
            else None
        ),
        inference_succeeded=(
            raw.get("inferenceSucceeded")
            if isinstance(raw.get("inferenceSucceeded"), bool)
            else None
        ),
        size_disposition=size_disposition,
        provenance=provenance,
    )


# The read shape for one derivation's state row.
@dataclass(frozen=True, slots=True)
class Derivation:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    state: DerivationState
    source_version: int  # which version of the source this derivation derives from
    content: str | None = None  # ready only
    reason: str | None = None  # failed | blocked
    gaps: list[DependencyGap] | None = None  # composed derivations; landed-with-fallback record
    metadata: DerivationMetadata | None = None  # mechanically stamped fields; never model-authored
    derived_at: str | None = None


@dataclass(frozen=True, slots=True)
class DerivationReportQueue:
    status: Literal["queued", "claimed"]


# One row of an owner's repair report: the derivation's durable state joined
# with the queue's mechanical detail for the live item still working toward it,
# if any.
@dataclass(frozen=True, slots=True)
class DerivationReportEntry:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    state: DerivationState
    source_version: int
    content: str | None = None
    reason: str | None = None
    gaps: list[DependencyGap] | None = None
    metadata: DerivationMetadata | None = None
    derived_at: str | None = None
    queue: DerivationReportQueue | None = None


# Message kinds a rendering part can carry — mirrors the intake event-kind
# vocabulary minus turn_end (turn_end never projects a message). Mirrored
# rather than imported: shared-tech/ may not import the domains.
RenderingPartKind = Literal[
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "runtime_note",
    "model_change",
    "thinking_level_change",
    "tool_call",
    "tool_result",
]


@dataclass(frozen=True, slots=True)
class RenderingPartBlock:
    block_type: str
    content: dict[str, object]


@dataclass(frozen=True, slots=True)
class RenderingPart:
    message_id: str
    kind: RenderingPartKind
    text: str  # ready derivation content, or raw/truncated fallback
    fallback: bool  # true ⇒ gap recorded
    blocks: list[RenderingPartBlock] | None = None
    outcome: ToolOutcome | None = None  # tool activity only


InferenceCallbackName = Literal[
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
]

INFERENCE_CALLBACK_OPERATIONS: tuple[InferenceCallbackName, ...] = (
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
)


@dataclass(frozen=True, slots=True)
class ToolResultConfig:
    small_tier_tokens: int
    small_target_ratio: float
    mid_target_ratio: float


@dataclass(frozen=True, slots=True)
class LeaseConfig:
    duration_ms: int


@dataclass(frozen=True, slots=True)
class ChunkPolicyConfig:
    target_projected_tokens: int
    max_projected_tokens: int


# ── LHC initialization config ────────────────────────────────────
# Inference callbacks arrive exactly one way: direct callback injection
# (`inference_callbacks`) or `inference` (host model-call function + per-kind
# assignments).
@dataclass(frozen=True, slots=True)
class SdkConfig:
    mode: Literal["background", "manual"]
    inference_callbacks: InferenceCallbacks | None = None
    inference: InferenceConfig | None = None
    clock: Callable[[], datetime] | None = None
    guards: DerivationGuards | None = None
    tool_result: ToolResultConfig | None = None  # 1000 / 0.15 / 0.04
    lease: LeaseConfig | None = None  # 120000
    chunk_policy: ChunkPolicyConfig | None = None  # 2200 / 4400
    view: SdkViewConfig | None = None  # profiles, visibility budgets, compact threshold


@dataclass(frozen=True, slots=True)
class CompressionTargets:
    min_ratio: float
    aim_ratio: float
    max_ratio: float


@dataclass(frozen=True, slots=True)
class BriefTargets:
    min_ratio: float
    aim_ratio: float
    max_ratio: float


# Every optional filled by init_lhc's central defaults.
@dataclass(frozen=True, slots=True)
class ResolvedSdkConfig:
    inference_callbacks: InferenceCallbacks
    mode: Literal["background", "manual"]
    clock: Callable[[], datetime]
    guards: ResolvedDerivationGuards
    compression_targets: CompressionTargets
    brief_targets: BriefTargets
    tool_result: ToolResultConfig
    lease: LeaseConfig
    chunk_policy: ChunkPolicyConfig
    view: ResolvedViewConfig


# ── handler contract ─────────────────────────────────────────────
@dataclass(frozen=True, slots=True)
class HandlerRunContext:
    thread_id: str
    file_path: str
    open_db: Callable[[], Database]  # short-txn access; NEVER held across inference calls
    inference_callbacks: InferenceCallbacks
    clock: Callable[[], datetime]
    config: ResolvedSdkConfig


# A successful handler hands its derivation content back as data; the
# drain's completion transaction performs the version-checked UPDATE and the
# item-row deletion atomically. The handler never opens that transaction
# itself, so the version check and the done/stale_discarded disposition stay in
# one place: the queue util.
@dataclass(frozen=True, slots=True)
class HandlerDerivationWrite:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    content: str
    metadata: DerivationMetadata | None = None
    gaps: list[DependencyGap] | None = None


# Completion-transaction hook for work that must land atomically with
# version-checked derivation writes: chunk placement and close→summary enqueues
# above all. The queue util invokes it inside completion's BEGIN IMMEDIATE,
# after derivation writes and only when they hit. A stale completion must not
# place a turn or enqueue summaries. on_commit registrations flush after that
# COMMIT succeeds and drop on rollback, so a crash leaves either a placed turn
# with its enqueues or nothing, never a derived-but-unplaced turn.
@dataclass(frozen=True, slots=True)
class CompletionTx:
    db: Database
    on_commit: Callable[[Callable[[], None]], None]


@dataclass(frozen=True, slots=True)
class HandlerOk:
    ok: Literal[True] = True
    derivations: list[HandlerDerivationWrite] | None = None
    on_applied: Callable[[CompletionTx], None] | None = None


@dataclass(frozen=True, slots=True)
class HandlerDeferred:
    reason: str
    on_deferred: Callable[[CompletionTx], None]
    ok: Literal[False] = False
    deferred: Literal[True] = True


@dataclass(frozen=True, slots=True)
class HandlerFailed:
    reason: str
    ok: Literal[False] = False


@dataclass(frozen=True, slots=True)
class HandlerBlocked:
    reason: str
    ok: Literal[False] = False
    blocked: Literal[True] = True


HandlerOutcome = Union[HandlerOk, HandlerDeferred, HandlerFailed, HandlerBlocked]


class WorkItemRef(TypedDict):
    workItemId: str
    kind: str
    sourceRef: dict[str, str]


# item is the queue util's WorkItemRecord; typed structurally here so the
# shared layer does not depend on the util's module (and vice versa stays
# one-directional: tech-utils imports shared).
WorkHandler = Callable[[HandlerRunContext, WorkItemRef], Awaitable[HandlerOutcome]]
