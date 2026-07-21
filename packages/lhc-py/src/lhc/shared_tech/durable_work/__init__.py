"""Ported from packages/lhc/src/shared-tech/durable-work/index.ts.

Durable work dispatch: operation intents, derivation completion transactions,
and the handler runner used by domain dispatchers.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, is_dataclass
from typing import Literal, Union

from ..derivation import (
    CompletionTx,
    HandlerDerivationWrite,
    HandlerFailed,
    HandlerOutcome,
    HandlerRunContext,
    InferenceErr,
    InferenceOk,
    ProviderProvenance,
    ResolvedSdkConfig,
    SubjectKind,
)
from ..storage import Database
from ..work_queue import EnqueueDerivationTarget, WorkKind, WorkSourceRef


@dataclass(frozen=True, slots=True)
class MessagesDeriveOperation:
    message_id: str
    operation: Literal["messages.derive"] = "messages.derive"


@dataclass(frozen=True, slots=True)
class TurnsDeriveTurnOperation:
    turn_id: str
    operation: Literal["turns.deriveTurn"] = "turns.deriveTurn"


@dataclass(frozen=True, slots=True)
class TurnsDeriveDetailedTurnCompressionOperation:
    turn_id: str
    operation: Literal["turns.deriveDetailedTurnCompression"] = "turns.deriveDetailedTurnCompression"


@dataclass(frozen=True, slots=True)
class TurnsDeriveDetailedChunkOperation:
    chunk_id: str
    operation: Literal["turns.deriveDetailedChunk"] = "turns.deriveDetailedChunk"


@dataclass(frozen=True, slots=True)
class TurnsDeriveBriefChunkOperation:
    chunk_id: str
    operation: Literal["turns.deriveBriefChunk"] = "turns.deriveBriefChunk"


DurableWorkOperation = Union[
    MessagesDeriveOperation,
    TurnsDeriveTurnOperation,
    TurnsDeriveDetailedTurnCompressionOperation,
    TurnsDeriveDetailedChunkOperation,
    TurnsDeriveBriefChunkOperation,
]

DurableWorkOperationName = Literal[
    "messages.derive",
    "turns.deriveTurn",
    "turns.deriveDetailedTurnCompression",
    "turns.deriveDetailedChunk",
    "turns.deriveBriefChunk",
]


@dataclass(frozen=True, slots=True)
class DerivationAttempt:
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]
    work_item_id: str | None = None


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchSettled:
    disposition: Literal["done", "stale_discarded", "lost_lease"]


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchFailed:
    reason: str
    disposition: Literal["failed"] = "failed"


@dataclass(frozen=True, slots=True)
class DurableWorkDispatchBlocked:
    reason: str
    disposition: Literal["blocked"] = "blocked"


DurableWorkDispatchResult = Union[
    DurableWorkDispatchSettled,
    DurableWorkDispatchFailed,
    DurableWorkDispatchBlocked,
]


@dataclass(frozen=True, slots=True)
class DurableWorkDispatcherItem:
    work_item_id: str
    kind: str
    source_ref: WorkSourceRef
    source_version: int
    derivations: Sequence[EnqueueDerivationTarget]
    operation: DurableWorkOperation


DurableWorkDispatcher = Callable[
    [HandlerRunContext, DurableWorkDispatcherItem],
    Awaitable[DurableWorkDispatchResult],
]

# TS: Partial<Record<DurableWorkOperation["operation"], DurableWorkDispatcher>>
DurableWorkDispatcherMap = dict[DurableWorkOperationName, DurableWorkDispatcher]


class DerivationCompletionError(Exception):
    error_class: Literal["state_corruption"] = "state_corruption"
    code: Literal["derivation_completion_mismatch"] = "derivation_completion_mismatch"

    def __init__(self, detail: str) -> None:
        super().__init__(f"derivation_completion_mismatch: {detail}")


def _target_key(
    target: EnqueueDerivationTarget | HandlerDerivationWrite,
) -> str:
    return f"{target.subject_kind}/{target.subject_id}/{target.derivation_type}"


def assert_exact_derivation_writes(
    expected: Sequence[EnqueueDerivationTarget],
    writes: Sequence[HandlerDerivationWrite],
) -> None:
    expected_keys = [_target_key(target) for target in expected]
    write_keys = [_target_key(write) for write in writes]
    duplicate_expected = next(
        (key for index, key in enumerate(expected_keys) if key in expected_keys[:index]),
        None,
    )
    if duplicate_expected is not None:
        raise DerivationCompletionError(
            f"derivation completion target duplicated: {duplicate_expected}"
        )
    duplicate_write = next(
        (key for index, key in enumerate(write_keys) if key in write_keys[:index]),
        None,
    )
    if duplicate_write is not None:
        raise DerivationCompletionError(
            f"derivation completion write duplicated: {duplicate_write}"
        )
    expected_set = set(expected_keys)
    write_set = set(write_keys)
    missing = [key for key in expected_keys if key not in write_set]
    extra = [key for key in write_keys if key not in expected_set]
    if missing or extra:
        raise DerivationCompletionError(
            "derivation completion target mismatch: "
            f"missing [{', '.join(missing)}], extra [{', '.join(extra)}]"
        )


def operation_intent(kind: WorkKind, source_ref: WorkSourceRef) -> DurableWorkOperation:
    if kind in ("prompt_smoothing", "tool_result_summary"):
        if "messageId" not in source_ref:
            raise RuntimeError(f"{kind} work requires a messageId source")
        return MessagesDeriveOperation(message_id=source_ref["messageId"])
    if kind == "turn_derivation":
        if "turnId" not in source_ref:
            raise RuntimeError("turn_derivation work requires a turnId source")
        return TurnsDeriveTurnOperation(turn_id=source_ref["turnId"])
    if kind == "detailed_turn_compression":
        if "turnId" not in source_ref:
            raise RuntimeError("detailed_turn_compression work requires a turnId source")
        return TurnsDeriveDetailedTurnCompressionOperation(turn_id=source_ref["turnId"])
    if kind == "chunk_summary_detailed":
        if "chunkId" not in source_ref:
            raise RuntimeError("chunk_summary_detailed work requires a chunkId source")
        return TurnsDeriveDetailedChunkOperation(chunk_id=source_ref["chunkId"])
    if "chunkId" not in source_ref:
        raise RuntimeError("chunk_summary_brief work requires a chunkId source")
    return TurnsDeriveBriefChunkOperation(chunk_id=source_ref["chunkId"])


def write_pending_derivations(
    db: Database,
    derivations: Sequence[EnqueueDerivationTarget],
    source_version: int,
) -> None:
    db.exec("BEGIN IMMEDIATE;")
    try:
        upsert = db.prepare(
            """INSERT INTO derivation
                 (subject_kind, subject_id, derivation_type, state, source_version)
               VALUES (?, ?, ?, 'pending', ?)
               ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
                 state = 'pending', content = NULL, reason = NULL, metadata = NULL,
                 gaps = NULL, derived_at = NULL, source_version = excluded.source_version"""
        )
        for target in derivations:
            upsert.run(
                target.subject_kind,
                target.subject_id,
                target.derivation_type,
                source_version,
            )
        db.exec("COMMIT;")
    except BaseException:
        db.exec("ROLLBACK;")
        raise


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


def apply_derivation_success(
    db: Database,
    attempt: DerivationAttempt,
    writes: Sequence[HandlerDerivationWrite],
    derived_at: str,
    on_applied: Callable[[CompletionTx], None] | None = None,
) -> Literal["done", "stale_discarded", "lost_lease"]:
    from ..persist import create_post_commit_hook_set

    post_commit_hook = create_post_commit_hook_set()
    db.exec("BEGIN IMMEDIATE;")
    try:
        if attempt.work_item_id is not None:
            owned = db.prepare(
                "SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
            ).get(attempt.work_item_id)
            if owned is None:
                db.exec("COMMIT;")
                return "lost_lease"
        assert_exact_derivation_writes(attempt.derivations, writes)
        hits = 0
        misses = 0
        update = db.prepare(
            """UPDATE derivation
               SET state = 'ready', content = ?, reason = NULL, metadata = ?,
                   gaps = ?, derived_at = ?
               WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?
                 AND source_version = ?"""
        )
        for write in writes:
            changed = update.run(
                write.content,
                None if write.metadata is None else _json(write.metadata),
                None if write.gaps is None else _json(write.gaps),
                derived_at,
                write.subject_kind,
                write.subject_id,
                write.derivation_type,
                attempt.source_version,
            )
            count = int(getattr(changed, "changes"))
            if count == 0:
                misses += 1
            if count > 1:
                raise DerivationCompletionError(
                    f"derivation completion write hit {count} rows for {_target_key(write)} "
                    f"at sourceVersion {attempt.source_version}"
                )
            hits += count
        stale = len(writes) > 0 and hits == 0
        if not stale and misses > 0:
            raise DerivationCompletionError(
                f"derivation completion partially hit {hits} of {len(writes)} rows "
                f"at sourceVersion {attempt.source_version}"
            )
        if not stale and on_applied is not None:
            on_applied(CompletionTx(db=db, on_commit=post_commit_hook.add))
        if attempt.work_item_id is not None:
            db.prepare(
                "DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
            ).run(attempt.work_item_id)
        db.exec("COMMIT;")
        post_commit_hook.flush()
        return "stale_discarded" if stale else "done"
    except BaseException:
        db.exec("ROLLBACK;")
        raise


@dataclass(frozen=True, slots=True)
class DerivationTerminalFailure:
    reason: str
    state: Literal["failed", "blocked"]
    now: str


def apply_derivation_terminal_failure(
    db: Database,
    attempt: DerivationAttempt,
    failure: DerivationTerminalFailure,
) -> Literal["done", "lost_lease"]:
    db.exec("BEGIN IMMEDIATE;")
    try:
        if attempt.work_item_id is not None:
            owned = db.prepare(
                "SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
            ).get(attempt.work_item_id)
            if owned is None:
                db.exec("COMMIT;")
                return "lost_lease"
        update = db.prepare(
            """UPDATE derivation
               SET state = ?, content = NULL, reason = ?, metadata = NULL,
                   gaps = NULL, derived_at = ?
               WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?
                 AND source_version = ?"""
        )
        hits = 0
        misses = 0
        for target in attempt.derivations:
            changed = update.run(
                failure.state,
                failure.reason,
                failure.now,
                target.subject_kind,
                target.subject_id,
                target.derivation_type,
                attempt.source_version,
            )
            count = int(getattr(changed, "changes"))
            if count == 0:
                misses += 1
            if count > 1:
                raise DerivationCompletionError(
                    f"derivation completion terminal hit {count} rows for "
                    f"{_target_key(target)} at sourceVersion {attempt.source_version}"
                )
            hits += count
        stale = len(attempt.derivations) > 0 and hits == 0
        if not stale and misses > 0:
            raise DerivationCompletionError(
                f"derivation completion terminal partially hit {hits} of "
                f"{len(attempt.derivations)} rows at sourceVersion {attempt.source_version}"
            )
        if attempt.work_item_id is not None:
            db.prepare(
                "DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"
            ).run(attempt.work_item_id)
        db.exec("COMMIT;")
        return "done"
    except BaseException:
        db.exec("ROLLBACK;")
        raise


@dataclass(frozen=True, slots=True)
class RunWorkHandlerCallItem:
    work_item_id: str
    kind: str
    source_ref: dict[str, str]


@dataclass(frozen=True, slots=True)
class RunWorkHandlerItem:
    work_item_id: str
    kind: str
    source_ref: WorkSourceRef


@dataclass(frozen=True, slots=True)
class HandlerRunIdentity:
    thread_id: str
    file_path: str


def _coerce_inference_result(result: object) -> object:
    if not isinstance(result, dict):
        return result
    if not result.get("ok"):
        return InferenceErr(
            reason=str(result.get("reason", "inference failed")),
            request_messages=result.get("requestMessages", result.get("request_messages")),  # type: ignore[arg-type]
        )
    provenance_value = result.get("provenance")
    provenance = (
        ProviderProvenance(
            provider=str(provenance_value["provider"]),
            model=str(provenance_value["model"]),
            prompt=str(provenance_value["prompt"]),
        )
        if isinstance(provenance_value, dict)
        and all(key in provenance_value for key in ("provider", "model", "prompt"))
        else None
    )
    return InferenceOk(
        text=str(result.get("text", "")),
        provenance=provenance,
        request_messages=result.get("requestMessages", result.get("request_messages")),  # type: ignore[arg-type]
        raw_response=result.get("rawResponse", result.get("raw_response")),  # type: ignore[arg-type]
    )


class _CoercingInferenceCallbacks:
    def __init__(self, callbacks: object) -> None:
        self._callbacks = callbacks

    async def smooth_prompt(self, input: object) -> object:
        return _coerce_inference_result(await self._callbacks.smooth_prompt(input))  # type: ignore[attr-defined]

    async def summarize_tool_result(self, input: object) -> object:
        return _coerce_inference_result(await self._callbacks.summarize_tool_result(input))  # type: ignore[attr-defined]

    async def compress_detailed_turn(self, input: object) -> object:
        return _coerce_inference_result(await self._callbacks.compress_detailed_turn(input))  # type: ignore[attr-defined]

    async def summarize_chunk_brief(self, input: object) -> object:
        return _coerce_inference_result(await self._callbacks.summarize_chunk_brief(input))  # type: ignore[attr-defined]


async def run_work_handler(
    db: Database,
    config: ResolvedSdkConfig,
    handler: Callable[
        [HandlerRunContext, RunWorkHandlerCallItem],
        Awaitable[HandlerOutcome],
    ],
    item: RunWorkHandlerItem,
    identity: HandlerRunIdentity | None = None,
) -> HandlerOutcome:
    from ..storage import database_path_for

    try:
        if identity is not None:
            thread_id = identity.thread_id
        else:
            row = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get()
            thread_id = str(row["thread_id"]) if row is not None else ""
        run = HandlerRunContext(
            thread_id=thread_id,
            file_path=(
                identity.file_path
                if identity is not None
                else (database_path_for(db) or "")
            ),
            open_db=lambda: db,
            inference_callbacks=_CoercingInferenceCallbacks(config.inference_callbacks),  # type: ignore[arg-type]
            clock=config.clock,
            config=config,
        )
        return await handler(
            run,
            RunWorkHandlerCallItem(
                work_item_id=item.work_item_id,
                kind=item.kind,
                source_ref=dict(item.source_ref),
            ),
        )
    except BaseException as cause:
        return HandlerFailed(reason=f"handler threw: {cause}")


def derivation_target(
    subject_kind: SubjectKind,
    subject_id: str,
    derivation_type: str,
) -> EnqueueDerivationTarget:
    return EnqueueDerivationTarget(
        subject_kind=subject_kind,
        subject_id=subject_id,
        derivation_type=derivation_type,
    )
