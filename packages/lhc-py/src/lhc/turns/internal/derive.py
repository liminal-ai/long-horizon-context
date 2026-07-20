"""Ported from packages/lhc/src/turns/internal/derive.ts. Phase 1 skeleton.

The turns derivation handlers: turn_derivation (deterministic assembly),
detailed_turn_compression (inference over pre_detailed_assembly), and the
two chunk summaries. turn_derivation composes turn_rendering and
pre_detailed_assembly, places the turn from uncompressed assembly tokens,
and enqueues detailed_turn_compression in the same completion transaction.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
import math
from typing import Literal, Union

from ...shared_tech.derivation import (
    BriefTargets,
    CompressionTargets,
    HandlerBlocked,
    HandlerDeferred,
    HandlerFailed,
    HandlerOutcome,
    HandlerRunContext,
    HandlerOk,
    HandlerDerivationWrite,
    DerivationMetadata,
    RenderingPart,
    RenderingPartKind,
    ResolvedSdkConfig,
    WorkHandler,
    WorkItemRef,
)
from ...shared_tech.durable_work import (
    DerivationAttempt,
    DerivationCompletionError,
    DerivationTerminalFailure,
    DurableWorkDispatchBlocked,
    DurableWorkDispatchFailed,
    DurableWorkDispatchResult,
    DurableWorkDispatchSettled,
    apply_derivation_success,
    apply_derivation_terminal_failure,
)
from ...shared_tech.errors import ErrorResult
from ...shared_tech.logging import (
    DerivationLogEntry,
    DerivationLogTarget,
    LogEntry,
    append_derivation_log,
)
from ...shared_tech.storage import Database
from ...shared_tech.token_counting import estimate_tokens
from ...shared_tech.context import resolve_instance_poke
from ...shared_tech.persist import DbReadTransaction, DbWriteTransaction
from ...shared_tech.logging import write_log
from ...shared_tech.work_queue import (
    ClaimTiming,
    EnqueueInput,
    EnqueueDerivationTarget,
    ImmediateClaimInput,
    ImmediateDerivationBoundaryPresent,
    WorkKind,
    WorkSourceRef,
    create_or_claim_immediate_work_item,
    enqueue,
    has_live_item,
)
from ...messages.internal.derive import (
    MessageDerivationFloorRecovery,
    write_message_derivation_floor_in_thread,
)
from .compose import compose_pre_detailed_assembly, compose_rendering_input
from .derivations import (
    chunk_exists,
    read_chunk_summary_derivation,
    read_member_messages,
    read_member_projections,
    read_message_derivation_rows,
    read_turn_derivation_row,
    read_turn_source,
)
from .store import select_open_turn_ids
from .chunks import enqueue_chunk_summaries, place_turn
from datetime import datetime, timezone

_SQL_SELECT_THREAD_ID = """SELECT thread_id FROM thread_metadata WHERE id = 1"""

_SQL_SELECT_CLAIMED_WORK_ITEM = """SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"""

_SQL_DELETE_CLAIMED_WORK_ITEM = """DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"""


def _iso_millis(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"

_SQL_BEGIN_IMMEDIATE = """BEGIN IMMEDIATE;"""

_SQL_COMMIT = """COMMIT;"""

_SQL_ROLLBACK = """ROLLBACK;"""


def _source_damaged(reason: str) -> HandlerBlocked:
    return HandlerBlocked(reason=f"source_damaged: {reason}")


@dataclass(frozen=True, slots=True)
class _InferenceFailedReason:
    """TS: inferenceFailed(result: { reason: string })."""

    reason: str


def _inference_failed(result: _InferenceFailedReason) -> HandlerFailed:
    return HandlerFailed(reason=result.reason)


def _dependency_not_ready(reason: str) -> HandlerFailed:
    return HandlerFailed(reason=reason)


def _rendering_part_label(kind: RenderingPartKind) -> str:
    return {
        "user_prompt": "User prompt",
        "assistant_text": "Assistant response",
        "assistant_thinking": "Assistant thinking",
        "runtime_note": "Runtime note",
        "model_change": "Model change",
        "thinking_level_change": "Thinking level change",
        "tool_call": "Tool call",
        "tool_result": "Tool result",
    }[kind]


def _compose_structured_turn_text(parts: Sequence[RenderingPart]) -> str:
    sections: list[str] = []
    for part in parts:
        annotations: list[str] = []
        if part.fallback:
            annotations.append("fallback")
        if part.outcome is not None:
            annotations.append(f"outcome: {part.outcome}")
        suffix = f" [{'; '.join(annotations)}]" if annotations else ""
        sections.append(f"{_rendering_part_label(part.kind)}{suffix}\n{part.text}")
    return "\n\n".join(sections)


def _compose_detailed_chunk_summary(member_projections: Sequence[str]) -> str:
    return "\n\n".join(member_projections)


@dataclass(frozen=True, slots=True)
class _CompressionTokenTargets:
    input_tokens: int
    target_min_tokens: int
    target_aim_tokens: int
    target_max_tokens: int


def _compression_target_tokens(
    input_tokens: int,
    targets: CompressionTargets | BriefTargets,
) -> _CompressionTokenTargets:
    def js_round(value: float) -> int:
        return math.floor(value + 0.5)

    return _CompressionTokenTargets(
        input_tokens=input_tokens,
        target_min_tokens=max(1, js_round(input_tokens * targets.min_ratio)),
        target_aim_tokens=max(1, js_round(input_tokens * targets.aim_ratio)),
        target_max_tokens=max(1, js_round(input_tokens * targets.max_ratio)),
    )


@dataclass(frozen=True, slots=True)
class _SizeDispositionBounds:
    target_min_tokens: int
    target_max_tokens: int


def _size_disposition(
    output_tokens: int,
    targets: _SizeDispositionBounds,
) -> Literal["under_min", "over_max", "in_range"]:
    if output_tokens < targets.target_min_tokens:
        return "under_min"
    if output_tokens > targets.target_max_tokens:
        return "over_max"
    return "in_range"


def _poke_thread_scheduler(db: Database) -> None:
    row = db.prepare(_SQL_SELECT_THREAD_ID).get()
    if row is not None:
        resolve_instance_poke()(str(row["thread_id"]))


@dataclass(frozen=True, slots=True)
class _LogFallbackEntry:
    derivation_type: str
    subject_id: str
    reason: Literal["not_ready", "failed_floor"]
    floor_used: str


def _log_fallback(run: HandlerRunContext, entry: _LogFallbackEntry) -> None:
    write_log(
        DbReadTransaction(db=run.open_db(), thread_id=run.thread_id, file_path=run.file_path),
        LogEntry(
            level="warning",
            message="derivation fallback used",
            derivation_type=entry.derivation_type,
            subject_id=entry.subject_id,
            reason=entry.reason,
            floor_used=entry.floor_used,
        ),
    )


def _log_compression_inference(
    run: HandlerRunContext,
    turn_id: str,
    event_kind: Literal["inference_failed", "inference_succeeded", "fallback_applied"],
    payload: dict[str, object],
) -> None:
    append_derivation_log(
        DbReadTransaction(
            db=run.open_db(), thread_id=run.thread_id, file_path=run.file_path
        ),
        DerivationLogEntry(
            target=DerivationLogTarget(
                subject_kind="turn",
                subject_id=turn_id,
                derivation_type="detailed_turn_compression",
            ),
            event_kind=event_kind,
            payload=payload,
        ),
    )


async def _turn_derivation_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    source_ref = item.source_ref
    turn_id = source_ref.get("turnId")
    if not isinstance(turn_id, str):
        return _source_damaged("work item carries no turnId")
    db = run.open_db()
    turn = read_turn_source(db, turn_id)
    if turn is None or turn.deleted:
        return _source_damaged(f"turn {turn_id} not found")
    if turn.status != "closed":
        return _source_damaged(f"turn {turn_id} is open under a derivation item")
    open_ids = select_open_turn_ids(db)
    if len(open_ids) > 1:
        return _source_damaged(
            f"turn state corrupt: {len(open_ids)} turns open ({', '.join(open_ids)})"
        )
    messages = read_member_messages(db, turn_id)
    derivations = read_message_derivation_rows(
        db, [message.message_id for message in messages]
    )
    composition = compose_rendering_input(messages, derivations)
    assembly = compose_pre_detailed_assembly(messages, derivations)
    seen_recoveries: set[str] = set()
    merged_recoveries = []
    for recovery in [*composition.recoveries, *assembly.recoveries]:
        key = f"{recovery.subject_id}:{recovery.derivation_type}"
        if key in seen_recoveries:
            continue
        seen_recoveries.add(key)
        merged_recoveries.append(recovery)
    for recovery in merged_recoveries:
        _log_fallback(
            run,
            _LogFallbackEntry(
                derivation_type=recovery.derivation_type,
                subject_id=recovery.subject_id,
                reason=recovery.reason,
                floor_used=recovery.floor_used,
            ),
        )
        write_message_derivation_floor_in_thread(
            run,
            MessageDerivationFloorRecovery(
                message_id=recovery.subject_id,
                derivation_type=recovery.derivation_type,  # type: ignore[arg-type]
                content=recovery.content,
                source_version=recovery.source_version,
            ),
        )
    rendering_text = _compose_structured_turn_text(composition.parts)
    assembly_text = assembly.text
    projected_tokens = estimate_tokens(assembly_text)
    assembly_row = read_turn_derivation_row(
        db, "turn", turn_id, "pre_detailed_assembly"
    )
    compression_source_version = (
        assembly_row.source_version if assembly_row is not None else 1
    )

    def on_applied(transaction: object) -> None:
        tx = transaction
        if not has_live_item(
            tx.db,  # type: ignore[attr-defined]
            "detailed_turn_compression",
            {"turnId": turn_id},
            compression_source_version,
        ):
            class _PostCommit:
                def add(self, operation: Callable[[], None]) -> None:
                    tx.on_commit(operation)  # type: ignore[attr-defined]

            enqueue(
                DbWriteTransaction(
                    db=tx.db,  # type: ignore[attr-defined]
                    thread_id=run.thread_id,
                    file_path=run.file_path,
                    clock=run.clock,
                    post_commit_hook=_PostCommit(),
                    poke=resolve_instance_poke(),
                ),
                EnqueueInput(
                    owner="turns",
                    kind="detailed_turn_compression",
                    source_ref={"turnId": turn_id},
                    source_version=compression_source_version,
                    derivations=[
                        EnqueueDerivationTarget(
                            subject_kind="turn",
                            subject_id=turn_id,
                            derivation_type="detailed_turn_compression",
                        )
                    ],
                ),
            )
        placement = place_turn(
            tx.db, turn_id, projected_tokens, run.config.chunk_policy  # type: ignore[attr-defined,arg-type]
        )
        for chunk_id in placement.closed_chunk_ids:
            class _PostCommit:
                def add(self, operation: Callable[[], None]) -> None:
                    tx.on_commit(operation)  # type: ignore[attr-defined]

            enqueue_chunk_summaries(
                DbWriteTransaction(
                    db=tx.db,  # type: ignore[attr-defined]
                    thread_id=run.thread_id,
                    file_path=run.file_path,
                    clock=run.clock,
                    post_commit_hook=_PostCommit(),
                    poke=resolve_instance_poke(),
                ),
                chunk_id,
            )

    return HandlerOk(
        derivations=[
            HandlerDerivationWrite(
                subject_kind="turn",
                subject_id=turn_id,
                derivation_type="turn_rendering",
                content=rendering_text,
            ),
            HandlerDerivationWrite(
                subject_kind="turn",
                subject_id=turn_id,
                derivation_type="pre_detailed_assembly",
                content=assembly_text,
            ),
        ],
        on_applied=on_applied,
    )


async def _detailed_turn_compression_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    source_ref = item.source_ref
    turn_id = source_ref.get("turnId")
    if not isinstance(turn_id, str):
        return _source_damaged("work item carries no turnId")
    db = run.open_db()
    turn = read_turn_source(db, turn_id)
    if turn is None or turn.deleted:
        return _source_damaged(f"turn {turn_id} not found")
    if turn.status != "closed":
        return _source_damaged(f"turn {turn_id} is open under a derivation item")
    assembly = read_turn_derivation_row(db, "turn", turn_id, "pre_detailed_assembly")
    if assembly is None or assembly.state != "ready" or assembly.content is None:
        state = assembly.state if assembly is not None else "missing"
        return _dependency_not_ready(
            f"pre_detailed_assembly_not_ready: turn {turn_id} pre_detailed_assembly is {state}"
        )
    input_tokens = estimate_tokens(assembly.content)
    targets = _compression_target_tokens(input_tokens, run.config.compression_targets)
    if input_tokens < run.config.guards.detailed_turn_compression.tiny_turn_tokens:
        text = assembly.content
        metadata = None
    else:
        result = await run.inference_callbacks.compress_detailed_turn(
            {
                "dialogueText": assembly.content,
                "inputTokens": targets.input_tokens,
                "targetMinTokens": targets.target_min_tokens,
                "targetAimTokens": targets.target_aim_tokens,
                "targetMaxTokens": targets.target_max_tokens,
            }
        )
        if not result.ok:
            text = assembly.content
            metadata = DerivationMetadata(
                inference_attempted=True,
                inference_succeeded=False,
                fallback_used=True,
                fallback_floor="pre_detailed_assembly",
                last_error=result.reason,
            )
            _log_compression_inference(
                run,
                turn_id,
                "inference_failed",
                {
                    "reason": result.reason,
                    "requestMessages": result.request_messages,
                },
            )
            _log_compression_inference(
                run,
                turn_id,
                "fallback_applied",
                {
                    "reason": result.reason,
                    "fallbackFloor": "pre_detailed_assembly",
                },
            )
            write_log(
                DbReadTransaction(
                    db=run.open_db(),
                    thread_id=run.thread_id,
                    file_path=run.file_path,
                ),
                LogEntry(
                    level="warning",
                    message="turn compression fallback used",
                    derivation_type="detailed_turn_compression",
                    subject_id=turn_id,
                    reason=result.reason,
                    floor_used="pre_detailed_assembly",
                ),
            )
        else:
            text = result.text
            disposition = _size_disposition(
                estimate_tokens(text),
                _SizeDispositionBounds(
                    targets.target_min_tokens, targets.target_max_tokens
                ),
            )
            metadata = DerivationMetadata(
                inference_attempted=True,
                inference_succeeded=True,
                size_disposition=disposition,
                provenance=result.provenance,
            )
            provenance = result.provenance
            _log_compression_inference(
                run,
                turn_id,
                "inference_succeeded",
                {
                    "provenance": (
                        {
                            "provider": provenance.provider,
                            "model": provenance.model,
                            "prompt": provenance.prompt,
                        }
                        if provenance is not None
                        else None
                    ),
                    "requestMessages": result.request_messages,
                    "rawResponse": result.raw_response,
                },
            )
    return HandlerOk(
        derivations=[
            HandlerDerivationWrite(
                subject_kind="turn",
                subject_id=turn_id,
                derivation_type="detailed_turn_compression",
                content=text,
                metadata=metadata,
            )
        ]
    )


# Detailed is deterministic material assembly from stored member compressions.
# Brief is inference-backed and consumes the stored detailed summary for the
# same chunk.
# TS: Extract<HandlerOutcome, { ok: false }> | { ok: true; text; fallbackLogs }
@dataclass(frozen=True, slots=True)
class _DetailedChunkOk:
    text: str
    fallback_logs: list[LogEntry]
    ok: Literal[True] = True


_DetailedChunkComposition = Union[
    HandlerBlocked,
    HandlerFailed,
    HandlerDeferred,
    _DetailedChunkOk,
]


def _compose_detailed_chunk_from_members(db: Database, chunk_id: str) -> _DetailedChunkComposition:
    members = read_member_projections(db, chunk_id)
    member_projections: list[str] = []
    fallback_logs: list[LogEntry] = []
    for member in members:
        if member.source_corruption_reason is not None:
            return _source_damaged(member.source_corruption_reason)
        if member.state == "ready" and member.content is not None:
            member_projections.append(member.content)
            continue
        if member.state == "blocked":
            return _source_damaged(
                f"member {member.turn_id} detailed_turn_compression blocked "
                "while deriving chunk_summary_detailed"
            )
        if (
            member.state == "failed"
            and member.assembly_state == "ready"
            and member.assembly_content is not None
        ):
            member_projections.append(member.assembly_content)
            fallback_logs.append(
                LogEntry(
                    level="warning",
                    message="derivation fallback used",
                    derivation_type="chunk_summary_detailed",
                    subject_id=chunk_id,
                    reason="failed_floor",
                    floor_used=member.turn_id,
                )
            )
            continue
        return _dependency_not_ready(
            "member_projection_not_ready: member "
            f"{member.turn_id} detailed_turn_compression is "
            f"{member.state if member.state is not None else 'missing'}"
        )
    return _DetailedChunkOk(
        text=_compose_detailed_chunk_summary(member_projections),
        fallback_logs=fallback_logs,
    )


# TS: function chunkDetailedHandler(): WorkHandler — zero-arg factory.
def _chunk_detailed_handler() -> WorkHandler:
    return _chunk_summary_detailed_handler


# TS: function chunkBriefHandler(): WorkHandler — zero-arg factory.
def _chunk_brief_handler() -> WorkHandler:
    return _chunk_summary_brief_handler


# WorkHandler stubs bound into turn_work_handlers. TS initializes those slots
# by calling the factories above; Phase 1 cannot call the factories at import
# time (bodies raise), so these stubs stand in for the returned handlers.
async def _chunk_summary_detailed_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    source_ref = item.source_ref
    chunk_id = source_ref.get("chunkId")
    if not isinstance(chunk_id, str):
        return _source_damaged("work item carries no chunkId")
    db = run.open_db()
    if not chunk_exists(db, chunk_id):
        return _source_damaged(f"chunk {chunk_id} not found")
    composition = _compose_detailed_chunk_from_members(db, chunk_id)
    if not composition.ok:
        return composition

    fallback_logs = composition.fallback_logs

    def on_applied(transaction: object) -> None:
        if len(fallback_logs) == 0:
            return

        class _PostCommit:
            def add(self, operation: Callable[[], None]) -> None:
                transaction.on_commit(operation)  # type: ignore[attr-defined]

        log_transaction = DbWriteTransaction(
            db=transaction.db,  # type: ignore[attr-defined]
            clock=run.clock,
            thread_id=run.thread_id,
            file_path=run.file_path,
            post_commit_hook=_PostCommit(),
            poke=resolve_instance_poke(),
        )
        for entry in fallback_logs:
            write_log(log_transaction, entry)

    return HandlerOk(
        derivations=[
            HandlerDerivationWrite(
                subject_kind="chunk",
                subject_id=chunk_id,
                derivation_type="chunk_summary_detailed",
                content=composition.text,
            )
        ],
        on_applied=on_applied if len(fallback_logs) > 0 else None,
    )


async def _chunk_summary_brief_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    source_ref = item.source_ref
    chunk_id = source_ref.get("chunkId")
    if not isinstance(chunk_id, str):
        return _source_damaged("work item carries no chunkId")

    db = run.open_db()
    if not chunk_exists(db, chunk_id):
        return _source_damaged(f"chunk {chunk_id} not found")

    detailed = read_chunk_summary_derivation(
        db, chunk_id, "chunk_summary_detailed"
    )
    brief = read_chunk_summary_derivation(db, chunk_id, "chunk_summary_brief")
    if detailed is None or detailed.state == "pending":
        source_version = (
            detailed.source_version
            if detailed is not None
            else brief.source_version if brief is not None else None
        )
        if source_version is None:
            return _source_damaged(
                f"chunk {chunk_id} has no chunk_summary_detailed or "
                "chunk_summary_brief derivation row"
            )

        def on_deferred(transaction: object) -> None:
            tx = transaction

            class _PostCommit:
                def add(self, operation: Callable[[], None]) -> None:
                    tx.on_commit(operation)  # type: ignore[attr-defined]

            enqueue_tx = DbWriteTransaction(
                db=tx.db,  # type: ignore[attr-defined]
                thread_id=run.thread_id,
                file_path=run.file_path,
                clock=run.clock,
                post_commit_hook=_PostCommit(),
                poke=resolve_instance_poke(),
            )
            if not has_live_item(
                tx.db,  # type: ignore[attr-defined]
                "chunk_summary_detailed",
                {"chunkId": chunk_id},
                source_version,
            ):
                enqueue(
                    enqueue_tx,
                    EnqueueInput(
                        owner="turns",
                        kind="chunk_summary_detailed",
                        source_ref={"chunkId": chunk_id},
                        source_version=source_version,
                        derivations=[
                            EnqueueDerivationTarget(
                                subject_kind="chunk",
                                subject_id=chunk_id,
                                derivation_type="chunk_summary_detailed",
                            )
                        ],
                    ),
                )
            enqueue(
                enqueue_tx,
                EnqueueInput(
                    owner="turns",
                    kind="chunk_summary_brief",
                    source_ref={"chunkId": chunk_id},
                    source_version=source_version,
                    derivations=[
                        EnqueueDerivationTarget(
                            subject_kind="chunk",
                            subject_id=chunk_id,
                            derivation_type="chunk_summary_brief",
                        )
                    ],
                ),
            )

        state = detailed.state if detailed is not None else "missing"
        return HandlerDeferred(
            reason=(
                "chunk_summary_detailed_not_ready: "
                f"chunk {chunk_id} chunk_summary_detailed is {state}"
            ),
            on_deferred=on_deferred,
        )

    if detailed.state in ("blocked", "failed"):
        return _source_damaged(
            f"chunk {chunk_id} chunk_summary_detailed is {detailed.state}: "
            f"{detailed.reason if detailed.reason is not None else 'no reason'}"
        )
    if detailed.content is None:
        return _dependency_not_ready(
            f"chunk_summary_detailed_not_ready: chunk {chunk_id} has no detailed content"
        )

    targets = _compression_target_tokens(
        estimate_tokens(detailed.content), run.config.brief_targets
    )
    result = await run.inference_callbacks.summarize_chunk_brief(
        {
            "text": detailed.content,
            "inputTokens": targets.input_tokens,
            "targetMinTokens": targets.target_min_tokens,
            "targetAimTokens": targets.target_aim_tokens,
            "targetMaxTokens": targets.target_max_tokens,
        }
    )
    log_target = DerivationLogTarget(
        subject_kind="chunk",
        subject_id=chunk_id,
        derivation_type="chunk_summary_brief",
    )
    if not result.ok:
        payload: dict[str, object] = {"reason": result.reason}
        if result.request_messages is not None:
            payload["requestMessages"] = result.request_messages
        append_derivation_log(
            DbReadTransaction(
                db=db, thread_id=run.thread_id, file_path=run.file_path
            ),
            DerivationLogEntry(
                target=log_target,
                event_kind="inference_failed",
                payload=payload,
            ),
        )
        return _inference_failed(_InferenceFailedReason(reason=result.reason))

    success_payload: dict[str, object] = {}
    if result.provenance is not None:
        success_payload["provenance"] = {
            "provider": result.provenance.provider,
            "model": result.provenance.model,
            "prompt": result.provenance.prompt,
        }
    if result.request_messages is not None:
        success_payload["requestMessages"] = result.request_messages
    if result.raw_response is not None:
        success_payload["rawResponse"] = result.raw_response
    append_derivation_log(
        DbReadTransaction(db=db, thread_id=run.thread_id, file_path=run.file_path),
        DerivationLogEntry(
            target=log_target,
            event_kind="inference_succeeded",
            payload=success_payload,
        ),
    )
    metadata = DerivationMetadata(
        inference_attempted=True,
        inference_succeeded=True,
        size_disposition=_size_disposition(
            estimate_tokens(result.text),
            _SizeDispositionBounds(
                targets.target_min_tokens, targets.target_max_tokens
            ),
        ),
        provenance=result.provenance,
    )
    return HandlerOk(
        derivations=[
            HandlerDerivationWrite(
                subject_kind="chunk",
                subject_id=chunk_id,
                derivation_type="chunk_summary_brief",
                content=result.text,
                metadata=metadata,
            )
        ]
    )


# The domain's handler table, merged into the SDK dispatch map at construction.
# TS: chunk_summary_detailed/brief ← chunkDetailedHandler() / chunkBriefHandler().
turn_work_handlers: dict[WorkKind, WorkHandler] = {
    "turn_derivation": _turn_derivation_handler,
    "detailed_turn_compression": _detailed_turn_compression_handler,
    "chunk_summary_detailed": _chunk_detailed_handler(),
    "chunk_summary_brief": _chunk_brief_handler(),
}


@dataclass(frozen=True, slots=True)
class _DeferClaimedItem:
    work_item_id: str


@dataclass(frozen=True, slots=True)
class _DeferTransaction:
    db: Database
    on_commit: Callable[[Callable[[], None]], None]


def _defer_claimed_turn_work(
    db: Database,
    item: _DeferClaimedItem,
    on_deferred: Callable[[_DeferTransaction], None],
) -> bool:
    from ...shared_tech.persist import create_post_commit_hook_set

    post_commit_hook = create_post_commit_hook_set()
    db.exec("BEGIN IMMEDIATE;")
    try:
        owned = db.prepare(
            "SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
        ).get(item.work_item_id)
        if owned is None:
            db.exec("COMMIT;")
            return False
        db.prepare(
            "DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
        ).run(item.work_item_id)
        on_deferred(_DeferTransaction(db=db, on_commit=post_commit_hook.add))
        db.exec("COMMIT;")
        post_commit_hook.flush()
        return True
    except BaseException:
        db.exec("ROLLBACK;")
        raise


@dataclass(frozen=True, slots=True)
class _DerivationRowForVersion:
    state: str
    source_version: int


def _source_version_for_derive(rows: Sequence[_DerivationRowForVersion]) -> int:
    maximum = max(row.source_version for row in rows)
    return maximum if any(row.state == "pending" for row in rows) else maximum + 1


@dataclass(frozen=True, slots=True)
class TurnOwnedDerived:
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class TurnOwnedDeriveFailed:
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


TurnOwnedDeriveResult = Union[TurnOwnedDerived, TurnOwnedDeriveFailed]


def _failed(error: ErrorResult) -> TurnOwnedDeriveFailed:
    return TurnOwnedDeriveFailed(error=error)


def _source_ref_id(source_ref: WorkSourceRef) -> str:
    if "turnId" in source_ref:
        return source_ref["turnId"]
    if "chunkId" in source_ref:
        return source_ref["chunkId"]
    return source_ref["messageId"]


def _work_in_flight(
    kind: WorkKind,
    source_ref: WorkSourceRef,
    source_version: int,
) -> TurnOwnedDeriveFailed:
    source_id = _source_ref_id(source_ref)
    return _failed(
        ErrorResult(
            error_class="caller_error",
            code="derivation_work_in_flight",
            reason=(
                f"{kind} work for {source_id} at sourceVersion {source_version} "
                "is already live"
            ),
        )
    )


@dataclass(frozen=True, slots=True)
class DeriveTurnOwnedOpts:
    source_version: int | None = None


async def derive_turn_owned_in_open_db(
    db: Database,
    config: ResolvedSdkConfig,
    kind: WorkKind,
    source_ref: WorkSourceRef,
    derivations: Sequence[EnqueueDerivationTarget],
    opts: DeriveTurnOwnedOpts | None = None,
) -> TurnOwnedDeriveResult:
    from ...shared_tech.derivation import CompletionTx
    from ...shared_tech.durable_work import RunWorkHandlerItem, run_work_handler

    rows = [
        read_turn_derivation_row(
            db,
            target.subject_kind,  # type: ignore[arg-type]
            target.subject_id,
            target.derivation_type,
        )
        for target in derivations
    ]
    missing_index = next(
        (index for index, row in enumerate(rows) if row is None),
        None,
    )
    if missing_index is not None:
        target = derivations[missing_index]
        return _failed(
            ErrorResult(
                error_class="caller_error",
                code="turn_not_found",
                reason=(
                    f"no derived derivation {target.derivation_type} exists for "
                    f"{target.subject_kind} {target.subject_id}"
                ),
            )
        )
    blocked = next((row for row in rows if row is not None and row.state == "blocked"), None)
    if blocked is not None:
        return _failed(
            ErrorResult(
                error_class="state_corruption",
                code="source_damaged",
                reason=blocked.reason or "turn-owned derivation is blocked",
            )
        )
    checked_rows = [row for row in rows if row is not None]
    source_version = (
        opts.source_version
        if opts is not None and opts.source_version is not None
        else _source_version_for_derive(checked_rows)  # type: ignore[arg-type]
    )
    expected_derivations = [
        ImmediateDerivationBoundaryPresent(
            subject_kind=target.subject_kind,
            subject_id=target.subject_id,
            derivation_type=target.derivation_type,
            state=row.state,
            source_version=row.source_version,
        )
        for target, row in zip(derivations, checked_rows, strict=True)
    ]
    handler = turn_work_handlers.get(kind)
    if handler is None:
        return _failed(
            ErrorResult(
                error_class="state_corruption",
                code="unknown_work_kind",
                reason=f'no handler registered for work kind "{kind}"',
            )
        )
    claim = create_or_claim_immediate_work_item(
        db,
        ImmediateClaimInput(
            owner="turns",
            kind=kind,
            source_ref=source_ref,
            source_version=source_version,
            derivations=derivations,
            expected_derivations=expected_derivations,
        ),
        ClaimTiming(
            now=_iso_millis(config.clock()),
            lease_duration_ms=config.lease.duration_ms,
        ),
    )
    if claim.outcome != "claimed":
        if claim.outcome == "expired":
            apply_derivation_terminal_failure(
                db,
                DerivationAttempt(
                    source_version=source_version,
                    derivations=derivations,
                    work_item_id=claim.item.work_item_id,
                ),
                DerivationTerminalFailure(
                    reason="claim_expired",
                    state="failed",
                    now=_iso_millis(config.clock()),
                ),
            )
            _poke_thread_scheduler(db)
            return _failed(
                ErrorResult(
                    error_class="system_error",
                    code="provider_failure",
                    reason="claim_expired",
                )
            )
        if claim.outcome == "queued":
            _poke_thread_scheduler(db)
        return _work_in_flight(kind, source_ref, source_version)
    outcome = await run_work_handler(
        db,
        config,
        handler,  # type: ignore[arg-type]
        RunWorkHandlerItem(
            work_item_id=claim.item.work_item_id,
            kind=kind,
            source_ref=source_ref,
        ),
    )
    attempt = DerivationAttempt(
        source_version=source_version,
        derivations=derivations,
        work_item_id=claim.item.work_item_id,
    )
    if outcome.ok:
        try:
            disposition = apply_derivation_success(
                db,
                attempt,
                outcome.derivations or [],
                _iso_millis(config.clock()),
                outcome.on_applied,
            )
            if disposition != "done":
                return _work_in_flight(kind, source_ref, source_version)
        except DerivationCompletionError as cause:
            return _failed(
                ErrorResult(
                    error_class=cause.error_class,
                    code=cause.code,
                    reason=str(cause),
                )
            )
        return TurnOwnedDerived(source_version=source_version)
    if isinstance(outcome, HandlerDeferred) or getattr(outcome, "deferred", False):
        def _on_deferred(tx: _DeferTransaction) -> None:
            outcome.on_deferred(CompletionTx(db=tx.db, on_commit=tx.on_commit))  # type: ignore[union-attr]

        deferred = _defer_claimed_turn_work(
            db,
            _DeferClaimedItem(work_item_id=claim.item.work_item_id),
            _on_deferred,
        )
        if not deferred:
            return _work_in_flight(kind, source_ref, source_version)
        _poke_thread_scheduler(db)
        return _work_in_flight(kind, source_ref, source_version)
    try:
        disposition = apply_derivation_terminal_failure(
            db,
            attempt,
            DerivationTerminalFailure(
                reason=outcome.reason,
                state=(
                    "blocked"
                    if isinstance(outcome, HandlerBlocked)
                    or getattr(outcome, "blocked", False)
                    else "failed"
                ),
                now=_iso_millis(config.clock()),
            ),
        )
        if disposition == "lost_lease":
            return _work_in_flight(kind, source_ref, source_version)
    except DerivationCompletionError as cause:
        return _failed(
            ErrorResult(
                error_class=cause.error_class,
                code=cause.code,
                reason=str(cause),
            )
        )
    return _failed(
        ErrorResult(
            error_class="system_error",
            code="provider_failure",
            reason=outcome.reason,
        )
    )


@dataclass(frozen=True, slots=True)
class DispatchTurnOwnedWorkItem:
    work_item_id: str
    kind: WorkKind
    source_ref: WorkSourceRef
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]


async def dispatch_turn_owned_work(
    run: HandlerRunContext,
    item: DispatchTurnOwnedWorkItem,
) -> DurableWorkDispatchResult:
    from ...shared_tech.derivation import HandlerBlocked, HandlerDeferred, HandlerFailed
    from ...shared_tech.durable_work import (
        HandlerRunIdentity,
        RunWorkHandlerItem,
        run_work_handler,
    )

    db = run.open_db()
    handler = turn_work_handlers.get(item.kind)
    if handler is None:
        return DurableWorkDispatchFailed(reason="unknown_work_kind")
    outcome = await run_work_handler(
        db,
        run.config,
        handler,  # type: ignore[arg-type]
        RunWorkHandlerItem(
            work_item_id=item.work_item_id,
            kind=item.kind,
            source_ref=item.source_ref,
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
        def _on_deferred(tx: _DeferTransaction) -> None:
            from ...shared_tech.derivation import CompletionTx

            outcome.on_deferred(CompletionTx(db=tx.db, on_commit=tx.on_commit))  # type: ignore[union-attr]

        deferred = _defer_claimed_turn_work(
            db,
            _DeferClaimedItem(work_item_id=item.work_item_id),
            _on_deferred,
        )
        return (
            DurableWorkDispatchSettled(disposition="done")
            if deferred
            else DurableWorkDispatchSettled(disposition="lost_lease")
        )
    if isinstance(outcome, HandlerBlocked) or getattr(outcome, "blocked", False):
        return DurableWorkDispatchBlocked(reason=outcome.reason)
    if isinstance(outcome, HandlerFailed):
        return DurableWorkDispatchFailed(reason=outcome.reason)
    return DurableWorkDispatchFailed(reason=getattr(outcome, "reason", "handler_failed"))
