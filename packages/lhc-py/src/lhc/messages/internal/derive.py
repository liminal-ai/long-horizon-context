"""Ported from packages/lhc/src/messages/internal/derive.ts.

Synchronous message-owned derivation and durable-work dispatch for the
messages domain.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal, Union

from ...shared_tech.derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerRunContext,
)
from ...shared_tech.durable_work import (
    DerivationAttempt,
    DurableWorkDispatchBlocked,
    DurableWorkDispatchFailed,
    DurableWorkDispatchResult,
    DurableWorkDispatchSettled,
    apply_derivation_success,
)
from ...shared_tech.errors import ErrorResult
from ...shared_tech.persist import create_post_commit_hook_set
from ...shared_tech.work_queue import (
    EnqueueDerivationTarget,
    WorkKind,
    has_live_item,
)
from .derivations import read_message_derivation_row

if TYPE_CHECKING:
    from .. import MessageKind

_SQL_INSERT_DERIVATION_READY = (
    """INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, content, metadata, gaps, source_version, derived_at)
           VALUES ('message', ?, ?, 'ready', ?, ?, ?, ?, ?)"""
)

_SQL_UPDATE_DERIVATION_READY = (
    """UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, metadata = ?,
               gaps = ?, derived_at = ?, source_version = ?
           WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?
             AND state = ? AND source_version = ?"""
)


def _iso_millis(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _camel_key(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def _json_value(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    if isinstance(value, dict):
        return {
            _camel_key(str(key)): _json_value(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _json(value: object) -> str:
    return json.dumps(_json_value(value), separators=(",", ":"), ensure_ascii=False)


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


def _failed_derive(message_id: str, error: ErrorResult) -> MessageDeriveResult:
    return MessageDeriveFailed(message_id=message_id, error=error)


@dataclass(frozen=True, slots=True)
class _DerivationForKind:
    work_kind: WorkKind
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]


def _derivation_for_kind(kind: MessageKind) -> _DerivationForKind | None:
    from .work import MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS

    work_kind = MESSAGE_WORK_KINDS.get(kind)  # type: ignore[arg-type]
    if work_kind is None:
        return None
    derivation_type = MESSAGE_WORK_DERIVATIONS.get(work_kind)
    if derivation_type is None:
        raise RuntimeError(f"no derived derivation mapped for message work kind {work_kind}")
    return _DerivationForKind(work_kind=work_kind, derivation_type=derivation_type)


@dataclass(frozen=True, slots=True)
class _DerivationRowForVersion:
    source_version: int
    state: str


def _source_version_for_derive(row: _DerivationRowForVersion | None) -> int:
    if row is None:
        return 1
    return row.source_version if row.state == "pending" else row.source_version + 1


def _provider_failure(message_id: str, reason: str) -> MessageDeriveResult:
    return _failed_derive(
        message_id,
        ErrorResult(
            error_class="system_error",
            code="provider_failure",
            reason=reason,
        ),
    )


def _work_in_flight(message_id: str, work_kind: WorkKind, source_version: int) -> MessageDeriveResult:
    return _failed_derive(
        message_id,
        ErrorResult(
            error_class="caller_error",
            code="derivation_work_in_flight",
            reason=(
                f"{work_kind} work for message {message_id} at sourceVersion "
                f"{source_version} is already live"
            ),
        ),
    )


@dataclass(frozen=True, slots=True)
class _AppliedRecoveredWrite:
    applied: bool
    live_work: bool


def _apply_recovered_message_write(
    run: HandlerRunContext,
    work_kind: WorkKind,
    message_id: str,
    expected: _DerivationRowForVersion | None,
    source_version: int,
    write: HandlerDerivationWrite,
    on_applied: Callable[[CompletionTx], None] | None = None,
) -> _AppliedRecoveredWrite:
    db = run.open_db()
    post_commit_hook = create_post_commit_hook_set()
    db.exec("BEGIN IMMEDIATE;")
    try:
        if has_live_item(
            db, work_kind, {"messageId": message_id}, source_version
        ):
            db.exec("COMMIT;")
            return _AppliedRecoveredWrite(applied=False, live_work=True)

        metadata = None if write.metadata is None else _json(write.metadata)
        gaps = None if write.gaps is None else _json(write.gaps)
        derived_at = _iso_millis(run.clock())
        applied = False
        wrote = False
        if expected is None:
            inserted = db.prepare(_SQL_INSERT_DERIVATION_READY).run(
                message_id,
                write.derivation_type,
                write.content,
                metadata,
                gaps,
                source_version,
                derived_at,
            )
            applied = int(getattr(inserted, "changes")) > 0
            wrote = applied
        elif expected.state not in ("pending", "failed"):
            applied = (
                expected.state == "ready"
                and expected.source_version == source_version
            )
        else:
            changed = db.prepare(_SQL_UPDATE_DERIVATION_READY).run(
                write.content,
                metadata,
                gaps,
                derived_at,
                source_version,
                message_id,
                write.derivation_type,
                expected.state,
                expected.source_version,
            )
            applied = int(getattr(changed, "changes")) > 0
            wrote = applied
        if not applied:
            current = read_message_derivation_row(
                db, message_id, write.derivation_type
            )
            applied = (
                current is not None
                and current.state == "ready"
                and current.source_version == source_version
            )
        if wrote and on_applied is not None:
            on_applied(CompletionTx(db=db, on_commit=post_commit_hook.add))
        db.exec("COMMIT;")
        if wrote:
            post_commit_hook.flush()
        return _AppliedRecoveredWrite(applied=applied, live_work=False)
    except BaseException:
        db.exec("ROLLBACK;")
        raise


@dataclass(frozen=True, slots=True)
class DeriveMessageInThreadOpts:
    source_version: int | None = None


async def derive_message_in_thread(
    run: HandlerRunContext,
    message_id: str,
    opts: DeriveMessageInThreadOpts | None = None,
) -> MessageDeriveResult:
    from ...shared_tech.derivation import HandlerBlocked, HandlerDeferred
    from ...shared_tech.durable_work import (
        HandlerRunIdentity,
        RunWorkHandlerItem,
        run_work_handler,
    )
    from .handlers import message_work_handlers
    from .store import read_message_by_id

    db = run.open_db()
    record = read_message_by_id(db, message_id)
    if record is None or record.deleted is True:
        return _failed_derive(
            message_id,
            ErrorResult(
                error_class="caller_error",
                code="message_not_found",
                reason=f"no message {message_id} exists in this thread",
            ),
        )
    mapped = _derivation_for_kind(record.kind)
    if mapped is None:
        return MessageNotDerivable(message_id=message_id)
    row = read_message_derivation_row(db, message_id, mapped.derivation_type)
    if row is not None and row.state == "blocked":
        return _failed_derive(
            message_id,
            ErrorResult(
                error_class="state_corruption",
                code="source_damaged",
                reason=(
                    row.reason
                    or f"derivation {mapped.derivation_type} for message {message_id} is blocked"
                ),
            ),
        )
    source_version = (
        opts.source_version
        if opts is not None and opts.source_version is not None
        else _source_version_for_derive(row)  # type: ignore[arg-type]
    )
    if has_live_item(db, mapped.work_kind, {"messageId": message_id}, source_version):
        return _work_in_flight(message_id, mapped.work_kind, source_version)
    handler = message_work_handlers.get(mapped.work_kind)
    if handler is None:
        return _failed_derive(
            message_id,
            ErrorResult(
                error_class="state_corruption",
                code="unknown_work_kind",
                reason=f'no handler registered for work kind "{mapped.work_kind}"',
            ),
        )
    outcome = await run_work_handler(
        db,
        run.config,
        handler,  # type: ignore[arg-type]
        RunWorkHandlerItem(
            work_item_id=f"inline-{message_id}-{mapped.work_kind}",
            kind=mapped.work_kind,
            source_ref={"messageId": message_id},
        ),
        HandlerRunIdentity(thread_id=run.thread_id, file_path=run.file_path),
    )
    if not outcome.ok:
        if isinstance(outcome, HandlerDeferred) or getattr(outcome, "deferred", False):
            return _failed_derive(
                message_id,
                ErrorResult(
                    error_class="state_corruption",
                    code="unknown_work_kind",
                    reason="message derivation handler returned unsupported deferred outcome",
                ),
            )
        if isinstance(outcome, HandlerBlocked) or getattr(outcome, "blocked", False):
            return _failed_derive(
                message_id,
                ErrorResult(
                    error_class="state_corruption",
                    code="source_damaged",
                    reason=outcome.reason,
                ),
            )
        return _provider_failure(message_id, outcome.reason)
    write = outcome.derivations[0] if outcome.derivations else None
    if write is None:
        return _provider_failure(message_id, "message handler returned no derivation write")
    persisted = _apply_recovered_message_write(
        run,
        mapped.work_kind,
        message_id,
        row,  # type: ignore[arg-type]
        source_version,
        write,
        outcome.on_applied,
    )
    if not persisted.applied:
        if persisted.live_work:
            return _work_in_flight(message_id, mapped.work_kind, source_version)
        current = read_message_derivation_row(db, message_id, mapped.derivation_type)
        if (
            current is None
            or current.state != "ready"
            or current.source_version != source_version
        ):
            return _work_in_flight(message_id, mapped.work_kind, source_version)
    return MessageDerived(
        message_id=message_id,
        derivation_type=mapped.derivation_type,
        source_version=source_version,
    )


@dataclass(frozen=True, slots=True)
class MessageDerivationFloorRecovery:
    message_id: str
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]
    content: str
    source_version: int


@dataclass(frozen=True, slots=True)
class MessageDerivationFloorResult:
    persisted: bool


def write_message_derivation_floor_in_thread(
    run: HandlerRunContext,
    recovery: MessageDerivationFloorRecovery,
) -> MessageDerivationFloorResult:
    work_kind: WorkKind = (
        "prompt_smoothing"
        if recovery.derivation_type == "smoothed_prompt"
        else "tool_result_summary"
    )
    row = read_message_derivation_row(
        run.open_db(), recovery.message_id, recovery.derivation_type
    )
    persisted = _apply_recovered_message_write(
        run,
        work_kind,
        recovery.message_id,
        row,  # type: ignore[arg-type]
        recovery.source_version,
        HandlerDerivationWrite(
            subject_kind="message",
            subject_id=recovery.message_id,
            derivation_type=recovery.derivation_type,
            content=recovery.content,
        ),
    )
    return MessageDerivationFloorResult(persisted=persisted.applied)


@dataclass(frozen=True, slots=True)
class DispatchMessageDeriveWorkItem:
    work_item_id: str
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]


async def dispatch_message_derive_work(
    run: HandlerRunContext,
    item: DispatchMessageDeriveWorkItem,
) -> DurableWorkDispatchResult:
    from ...shared_tech.derivation import HandlerBlocked, HandlerDeferred, HandlerFailed
    from ...shared_tech.durable_work import (
        HandlerRunIdentity,
        RunWorkHandlerItem,
        run_work_handler,
    )
    from .handlers import message_work_handlers
    from .store import read_message_by_id

    db = run.open_db()
    target = item.derivations[0] if item.derivations else None
    if target is None:
        return DurableWorkDispatchFailed(reason="missing_derivation_target")
    record = read_message_by_id(db, target.subject_id)
    if record is None or record.deleted is True:
        return DurableWorkDispatchBlocked(
            reason=f"source_damaged: message {target.subject_id} not found"
        )
    mapped = _derivation_for_kind(record.kind)
    if mapped is None:
        return DurableWorkDispatchFailed(reason="not_derivable")
    handler = message_work_handlers.get(mapped.work_kind)
    if handler is None:
        return DurableWorkDispatchFailed(reason="unknown_work_kind")
    outcome = await run_work_handler(
        db,
        run.config,
        handler,  # type: ignore[arg-type]
        RunWorkHandlerItem(
            work_item_id=item.work_item_id,
            kind=mapped.work_kind,
            source_ref={"messageId": target.subject_id},
        ),
        HandlerRunIdentity(thread_id=run.thread_id, file_path=run.file_path),
    )
    if outcome.ok:
        disposition = apply_derivation_success(
            db,
            DerivationAttempt(
                source_version=item.source_version,
                derivations=item.derivations,
                work_item_id=item.work_item_id,
            ),
            outcome.derivations or [],
            _iso_millis(run.clock()),
            outcome.on_applied,
        )
        return DurableWorkDispatchSettled(disposition=disposition)
    if isinstance(outcome, HandlerDeferred) or getattr(outcome, "deferred", False):
        return DurableWorkDispatchFailed(
            reason="unsupported_deferred_message_derivation"
        )
    if isinstance(outcome, HandlerBlocked) or getattr(outcome, "blocked", False):
        return DurableWorkDispatchBlocked(reason=outcome.reason)
    if isinstance(outcome, HandlerFailed):
        return DurableWorkDispatchFailed(reason=outcome.reason)
    return DurableWorkDispatchFailed(reason=getattr(outcome, "reason", "handler_failed"))
