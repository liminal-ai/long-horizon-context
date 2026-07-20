"""Ported from packages/lhc/src/messages/index.ts. Phase 1 — PARTIAL (Wave 1/2/3 import seam).

Wave 3 adds `create` for the intake pipeline import seam. Full messages
surface (project/store/cascade/mutate) lands in Wave 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, TypedDict, Union

from ..shared_tech.errors import ErrorResult, OpResult
from ..shared_tech.work_queue import WorkItemRecord, WorkKind
from ..threads import ThreadRef

if TYPE_CHECKING:
    from ..intake_stream import EventRecord
    from ..shared_tech.persist import DbWriteTransaction

# Data keys verbatim from TS MessageListOptions; "from" is a Python keyword,
# so the functional TypedDict form is required. All optional: existing callers
# see visible messages, unbounded, in record order.
MessageListOptions = TypedDict(
    "MessageListOptions",
    {"from": int, "to": int, "limit": int, "includeDeleted": bool},
    total=False,
)

BlockType = Literal["text", "tool_call", "tool_result", "model_change", "thinking_level_change"]

# TS: Exclude<EventKind, "turn_end">
MessageKind = Literal[
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
class Block:
    block_type: BlockType
    content: dict[str, object]


@dataclass(frozen=True, slots=True)
class MessageRecord:
    message_id: str
    source_event_order: int
    kind: MessageKind
    blocks: list[Block]
    token_estimate: int
    actor: str
    harness: str
    recorded_at: str
    turn_id: str
    deleted: bool | None = None


@dataclass(frozen=True, slots=True)
class MessageCreated:
    message_id: str
    kind: MessageKind
    tool_call_id: str | None = None


@dataclass(frozen=True, slots=True)
class MessageCreateResult:
    message: MessageCreated | None
    queued_work: list[WorkItemRecord]


# Cross-domain surface, called by intake-stream inside the batch transaction.
def create(
    transaction: DbWriteTransaction,
    recorded_event: EventRecord,
    turn_id: str,
) -> MessageCreateResult:
    raise NotImplementedError


async def list(thread_ref: ThreadRef, filter: MessageListOptions | None = None) -> OpResult[list[MessageRecord]]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class MessageDerived:
    message_id: str
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class MessageNotDerivable:
    message_id: str
    outcome: Literal["not_derivable"] = "not_derivable"


@dataclass(frozen=True, slots=True)
class MessageDeriveFailed:
    message_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


MessageDeriveResult = Union[MessageDerived, MessageNotDerivable, MessageDeriveFailed]


async def derive(thread_ref: ThreadRef, message_ids: list[str]) -> OpResult[list[MessageDeriveResult]]:
    raise NotImplementedError


# ── mutations (Wave 3 out-of-order minimal add) ───────────────────
#
# `CascadeClear`/`MutationResult` belong to `internal/cascade.ts` /
# `index.ts`'s mutation surface (Wave 4). The Wave 3 lifecycle fixture's
# `LifecyclePhases` needs `MutationResult`'s shape for its `mutate` phase
# (`sdk.messages.edit` / `.remove` results) — pre-declared here, faithful to
# TS names/fields, so Wave 4 extends rather than reshapes it. See
# PORT_STATUS.md row 10 (cascade.ts) and row 9 (messages/index.ts).


@dataclass(frozen=True, slots=True)
class CascadeClear:
    """Ported ahead of packages/lhc/src/messages/internal/cascade.ts (Wave 4)."""

    subject_kind: Literal["message", "turn", "chunk"]
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class MutationChanged:
    message_ids: list[str]
    turn_ids: list[str]


@dataclass(frozen=True, slots=True)
class MutationQueuedWork:
    work_item_id: str
    kind: WorkKind


@dataclass(frozen=True, slots=True)
class MutationResult:
    """The mutation result contract shared by `edit` and `remove` (Wave 4)."""

    changed: MutationChanged
    cleared: list[CascadeClear]
    dropped: list[CascadeClear]
    queued: list[MutationQueuedWork]
    superseded: list[str]
