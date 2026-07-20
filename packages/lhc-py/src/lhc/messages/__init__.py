"""Ported from packages/lhc/src/messages/index.ts. Phase 1 skeleton.

Full messages surface: create/list/show/report/derive/edit/remove plus the
mutation result contract. Internal modules own store/project/cascade/handlers;
this package re-exports the public API and private index helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, TypedDict

from ..intake_stream import EventRecord
from ..shared_tech.derivation import Derivation, DerivationReportEntry
from ..shared_tech.errors import ErrorResult, OpErr, OpResult
from ..shared_tech.storage import Database
from ..shared_tech.work_queue import WorkItemRecord, WorkKind
from ..threads import ThreadRef
from .internal.cascade import CascadeClear
from .internal.derive import (
    MessageDeriveFailed,
    MessageDeriveResult,
    MessageDerived,
    MessageNotDerivable,
)
from .internal.smoothing import clean_prompt

if TYPE_CHECKING:
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
    # Stored derivations for messages that are derivation sources. Kinds with no
    # derivable output carry no rows and no key. Stored state is returned
    # verbatim, never re-derived on read.
    derivations: list[Derivation] | None = None
    # The deleted-audit marker is present only on deleted records, which only
    # the includeDeleted listing and show read ever surface. A default list never
    # carries the key.
    deleted: bool | None = None


# The event as the walk holds it after recording: the validated input plus
# its server-stamped order and timestamp.
RecordedEvent = EventRecord


@dataclass(frozen=True, slots=True)
class MessageCreated:
    message_id: str
    kind: MessageKind
    tool_call_id: str | None = None


@dataclass(frozen=True, slots=True)
class MessageCreateResult:
    message: MessageCreated | None
    queued_work: list[WorkItemRecord]


_SQL_SELECT_THREAD_ID = """SELECT thread_id FROM thread_metadata WHERE id = 1"""


# Cross-domain surface, called by intake-stream inside the batch transaction.
# Synchronous and throwing by design: message creation failure propagates to the
# pipeline's catch and rejects the whole batch. Returns null for turn_end (no
# message). turn_id is the membership stamp, settled by the pipeline before
# this call.
def create(
    transaction: DbWriteTransaction,
    recorded_event: RecordedEvent,
    turn_id: str,
) -> MessageCreateResult:
    raise NotImplementedError


# The kind gate, exact by design: a prompt queues prompt_smoothing, a tool
# result queues tool_result_summary, nothing else queues anything —
# text, thinking, and note messages are not derivation sources.
def _queue_message_work(
    transaction: DbWriteTransaction,
    message: MessageCreated | None,
) -> list[WorkItemRecord]:
    raise NotImplementedError


def _thread_not_found(file_path: str) -> OpErr:
    raise NotImplementedError


# Bounded-listing options: from/to are source-event-order bounds, limit caps
# the count after bounds, includeDeleted is the audit opt-in. All optional:
# existing callers see visible messages, unbounded, in record order.


def _invalid_bounds(reason: str) -> ErrorResult:
    raise NotImplementedError


# Bounds mistakes are operational caller errors returned as results, never a
# silent empty list a caller could mistake for an empty window.
def _validate_list_options(opts: MessageListOptions) -> ErrorResult | None:
    raise NotImplementedError


async def list(thread_ref: ThreadRef, filter: MessageListOptions | None = None) -> OpResult[list[MessageRecord]]:
    raise NotImplementedError


# In-transaction read for coordinators that already hold an open thread
# handle (thread-view's compact selection): the live message records in
# source order with their projected blocks, so thread-view asks the messages
# owner for its records instead of reading the message tables itself.
def read_live_messages(db: Database) -> list[MessageRecord]:
    raise NotImplementedError


# The single-message view returns the canonical record: every block with
# complete content, full tool results, never view-shortened derivations. It
# also joins message derivations with their states and mechanically stamped
# metadata from the owner's report read.
@dataclass(frozen=True, slots=True)
class MessageDetail:
    message_id: str
    source_event_order: int
    kind: MessageKind
    blocks: list[Block]
    token_estimate: int
    actor: str
    harness: str
    recorded_at: str
    turn_id: str
    # Always present and honest: show on a deleted message returns the record
    # flagged, never not-found.
    deleted: bool
    # The owner report's queue-joined entries, never synthesized here: the same
    # `report_message_derivations` read messages.report serves, scoped by id.
    derivations: list[DerivationReportEntry]


async def show(thread_ref: ThreadRef, message_id: str) -> OpResult[MessageDetail]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class MessageReportOpts:
    not_ready: bool | None = None
    message_id: str | None = None


# This owner's repair report: every message-owned derivation's durable state
# joined with live queue detail in one query — the five operational
# situations (pending, ready, failed, blocked) read from the rows
# without any queue API. Needs no inference; reads degrade, never block.
async def report(
    thread_ref: ThreadRef,
    opts: MessageReportOpts | None = None,
) -> OpResult[list[DerivationReportEntry]]:
    raise NotImplementedError


# Synchronous message-owned derivation. For each message id, the domain
# selects the one message-owned derivation implied by the stored message kind
# (`user_prompt` -> `smoothed_prompt`, `tool_result` -> `tool_result_summary`),
# runs the existing handler, and lands the normal version-checked derivation
# write before returning. Non-derivable message kinds return `not_derivable`.
async def derive(thread_ref: ThreadRef, message_ids: list[str]) -> OpResult[list[MessageDeriveResult]]:
    raise NotImplementedError


# ── mutations ────────────────────────────────────────────────────

# The mutation result contract: what changed in the record, which dependent
# derivations cleared, which dropped (delete only), what replacement work
# queued, and which still-queued old items the cascade tidied away. Shared by
# edit and delete. CascadeClear lives in internal/cascade (TS home).


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
    """The mutation result contract shared by `edit` and `remove`."""

    changed: MutationChanged
    cleared: list[CascadeClear]
    dropped: list[CascadeClear]
    queued: list[MutationQueuedWork]
    superseded: list[str]


@dataclass(frozen=True, slots=True)
class EditInput:
    message_id: str
    content: str


@dataclass(frozen=True, slots=True)
class RemoveInput:
    message_id: str


# Editing changes a closed-turn message's content and blocks, re-stamps the
# token estimate, and walks the full dependent chain: clear to pending,
# supersede queued old work, and enqueue replacements at the next source
# version in one transaction.
async def edit(thread_ref: ThreadRef, edit: EditInput) -> OpResult[MutationResult]:
    raise NotImplementedError


# Delete is message-record level: the deleted_at stamp plus the delete cascade
# (own derivations dropped, turn and chunk cleared and re-queued for minus-one
# composition) land in one transaction.
async def remove(thread_ref: ThreadRef, removal: RemoveInput) -> OpResult[MutationResult]:
    raise NotImplementedError


__all__ = [
    "Block",
    "BlockType",
    "CascadeClear",
    "EditInput",
    "MessageCreateResult",
    "MessageCreated",
    "MessageDeriveFailed",
    "MessageDeriveResult",
    "MessageDerived",
    "MessageDetail",
    "MessageKind",
    "MessageListOptions",
    "MessageNotDerivable",
    "MessageRecord",
    "MessageReportOpts",
    "MutationChanged",
    "MutationQueuedWork",
    "MutationResult",
    "RecordedEvent",
    "RemoveInput",
    "clean_prompt",
    "create",
    "derive",
    "edit",
    "list",
    "read_live_messages",
    "remove",
    "report",
    "show",
]
