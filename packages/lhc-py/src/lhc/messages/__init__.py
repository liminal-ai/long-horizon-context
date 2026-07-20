"""Ported from packages/lhc/src/messages/index.ts. Phase 1 skeleton.

Full messages surface: create/list/show/report/derive/edit/remove plus the
mutation result contract. Internal modules own store/project/cascade/handlers;
this package re-exports the public API and private index helpers.

WARNING: this module exports `async def list(...)`, which shadows the builtin
`list` at module level (TS fidelity). Phase 2 bodies in this module must use
`_builtin_list` / `builtins.list`, never bare `list` for the type.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypedDict

from ..intake_stream import EventRecord
from ..shared_tech.derivation import Derivation, DerivationReportEntry
from ..shared_tech.errors import ErrorResult, OpErr, OpResult
from ..shared_tech.persist import create_db_read_transaction
from ..shared_tech.storage import Database
from ..shared_tech.work_queue import (
    EnqueueDerivationTarget,
    EnqueueInput,
    WorkItemRecord,
    WorkKind,
    enqueue,
)
from ..threads import ThreadRef

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

# IMPORT-ORDER CONSTRAINT: the internal modules below construct the record
# types defined above via runtime `from .. import ...` while this package is
# still partially initialized. The record definitions MUST stay above these
# imports — reordering breaks every import of this package.
from .internal.cascade import CascadeClear
from .internal.derive import (
    MessageDeriveFailed,
    MessageDeriveResult,
    MessageDerived,
    MessageNotDerivable,
)
from .internal.smoothing import clean_prompt
from .internal.project import project_event
from .internal.derivations import read_message_derivations
from .internal.store import MessageRow, insert_message, read_messages
from .internal.work import MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS


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
    projected = project_event(recorded_event)
    if projected is None:
        return MessageCreateResult(message=None, queued_work=[])
    kind = recorded_event["eventKind"]
    message_id = f'm{recorded_event["eventOrder"]}'
    insert_message(
        transaction.db,
        MessageRow(
            message_id=message_id,
            source_event_order=recorded_event["eventOrder"],
            kind=kind,  # type: ignore[arg-type]
            token_estimate=projected.token_estimate,
            actor=recorded_event["actor"],
            harness=recorded_event["harness"],
            turn_id=turn_id,
            blocks=projected.blocks,
        ),
    )
    if kind in ("tool_call", "tool_result"):
        message = MessageCreated(
            message_id=message_id,
            kind=kind,
            tool_call_id=recorded_event["payload"]["toolCallId"],
        )
    else:
        message = MessageCreated(message_id=message_id, kind=kind)
    return MessageCreateResult(
        message=message,
        queued_work=_queue_message_work(transaction, message),
    )


# The kind gate, exact by design: a prompt queues prompt_smoothing, a tool
# result queues tool_result_summary, nothing else queues anything —
# text, thinking, and note messages are not derivation sources.
def _queue_message_work(
    transaction: DbWriteTransaction,
    message: MessageCreated | None,
) -> list[WorkItemRecord]:
    if message is None:
        return []
    kind = MESSAGE_WORK_KINDS.get(message.kind)
    if kind is None:
        return []
    derivation = MESSAGE_WORK_DERIVATIONS.get(kind)
    if derivation is None:
        raise RuntimeError(f"no derived derivation mapped for message work kind {kind}")
    return [
        enqueue(
            transaction,
            EnqueueInput(
                owner="messages",
                kind=kind,
                source_ref={"messageId": message.message_id},
                derivations=[
                    EnqueueDerivationTarget(
                        subject_kind="message",
                        subject_id=message.message_id,
                        derivation_type=derivation,
                    )
                ],
            ),
        )
    ]


def _thread_not_found(file_path: str) -> OpErr:
    raise NotImplementedError


# Bounded-listing options: from/to are source-event-order bounds, limit caps
# the count after bounds, includeDeleted is the audit opt-in. All optional:
# existing callers see visible messages, unbounded, in record order.


def _invalid_bounds(reason: str) -> ErrorResult:
    return ErrorResult(
        error_class="caller_error",
        code="invalid_bounds",
        reason=reason,
    )


# Bounds mistakes are operational caller errors returned as results, never a
# silent empty list a caller could mistake for an empty window.
def _validate_list_options(opts: MessageListOptions) -> ErrorResult | None:
    integers: tuple[tuple[str, object], ...] = (
        ("from", opts.get("from")),  # type: ignore[literal-required]
        ("to", opts.get("to")),  # type: ignore[literal-required]
        ("limit", opts.get("limit")),  # type: ignore[literal-required]
    )
    for name, value in integers:
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int)
        ):
            return _invalid_bounds(f"{name} must be an integer, got {value}")
    if (
        opts.get("from") is not None  # type: ignore[literal-required]
        and opts.get("to") is not None  # type: ignore[literal-required]
        and opts["from"] > opts["to"]
    ):
        return _invalid_bounds(
            f"from ({opts['from']}) must not exceed to ({opts['to']})"
        )
    if opts.get("limit") is not None and opts["limit"] < 1:
        return _invalid_bounds(f"limit must be at least 1, got {opts['limit']}")
    return None


_builtin_list = list  # Phase 2 bodies in this module must use _builtin_list / builtins.list


async def list(thread_ref: ThreadRef, filter: MessageListOptions | None = None) -> OpResult[list[MessageRecord]]:
    options = filter if filter is not None else {}
    invalid = _validate_list_options(options)
    if invalid is not None:
        return OpErr(error=invalid)
    try:
        return await create_db_read_transaction(
            thread_ref,
            lambda transaction: _read_messages_with_derivations(transaction.db, options),
        )
    except Exception as cause:
        from ..shared_tech.errors import storage_failure

        return storage_failure(f"message read-back failed: {cause}")


def _read_messages_with_derivations(
    db: Database, options: MessageListOptions
) -> list[MessageRecord]:
    records = read_messages(db, options)
    derivations = read_message_derivations(
        db, [record.message_id for record in records]
    )
    return [
        replace(record, derivations=derivations.get(record.message_id))
        for record in records
    ]


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
    from ..shared_tech.context import resolve_instance_config
    from ..shared_tech.derivation import HandlerRunContext
    from ..shared_tech.errors import OpOk, storage_failure
    from ..threads import open_thread_database, resolve_thread_ref
    from .internal.derive import derive_message_in_thread

    config = resolve_instance_config()
    if config is None:
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="inference_unavailable",
                reason="messages.derive requires an initialized LHC SDK inference configuration",
            )
        )
    resolved = await resolve_thread_ref(thread_ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not Path(file_path).exists():
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="thread_not_found",
                reason=f"no thread file exists at {file_path}",
            )
        )
    opened = open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    try:
        row = db.prepare(_SQL_SELECT_THREAD_ID).get()
        if row is None:
            return storage_failure(f"thread file at {file_path} lost its metadata row")
        run = HandlerRunContext(
            thread_id=str(row["thread_id"]),
            file_path=file_path,
            open_db=lambda: db,
            inference_callbacks=config.inference_callbacks,
            clock=config.clock,
            config=config,
        )
        results: list[MessageDeriveResult] = []
        for message_id in message_ids:
            results.append(await derive_message_in_thread(run, message_id))
        return OpOk(results)
    except BaseException as cause:
        return storage_failure(f"derive failed: {cause}")
    finally:
        db.close()


# ── mutations ────────────────────────────────────────────────────

# The mutation result contract: what changed in the record, which dependent
# derivations cleared, which dropped (delete only), what replacement work
# queued, and which still-queued old items the cascade tidied away. Shared by
# edit and delete. CascadeClear lives in internal/cascade (TS home).


@dataclass(frozen=True, slots=True)
class MutationChanged:
    message_ids: list[str]
    turn_ids: list[str]


# NOMINAL-TYPING BOUNDARY: same shape as messages.internal.cascade.CascadeQueued, but a distinct class —
# dataclass __eq__ requires identical type, so Phase 2 must convert
# explicitly at this boundary (or tests comparing across it will fail).
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
