"""Ported from packages/lhc/src/retrieval/index.ts (pin 81cd48c).

Retrieval: deterministic drill-down from band labels to full content.
``get_turns`` serves rendered turns by turn id (``t…``); ``get_messages``
serves verbatim message content by message id (``m…``). Both enforce a
per-call token budget with in-order serving. Oversized content is served as
an exact token slice with a ``slice`` receipt for ``from_token`` continuation;
later ids past a spent budget get explicit ``budget`` receipts. Every
requested id writes one impression row. Retrieval never mutates record
content; the only write is the impression log.

Public options are snake_case (Fable ruling). Historical-envelope formatting
lives in :mod:`lhc.retrieval.format` (SDK-owned; pin wording from pi-lhc
serving tools, assembly placement per SDK/Rust R6).
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass, replace
from typing import Generic, Literal, Sequence, TypeVar

from ..shared_tech._jsstr import js_json_dumps, js_json_dumps_pretty, js_len, js_slice
from ..shared_tech.errors import OpResult, storage_failure
from ..shared_tech.persist import create_db_read_transaction, create_db_write_transaction
from ..shared_tech.storage import Database
from ..shared_tech.token_counting import (
    estimate_tokens,
    slice_tokens,
    slice_tokens_byte_capped,
)
from ..threads import ThreadRef
from ..turns.internal.compose import labeled_or_recomposed_turn_rendering
from ..turns.internal.derivations import (
    read_member_messages,
    read_message_derivation_rows,
    read_turn_source,
)

# Whole-item budget for one retrieval call. Callers may override per call.
DEFAULT_RETRIEVAL_TOKEN_BUDGET = 8_000

# A partial serve only starts when at least this much budget remains — a
# smaller sliver teaches nothing. Explicit from_token continuations are
# exempt: the caller asked for exactly that window.
RETRIEVAL_SLICE_FLOOR = 256

# Hard cap on deduped ids per retrieval call. Bodies are token-budgeted,
# but per-id receipts are not — this bounds the whole model-visible result.
MAX_RETRIEVAL_IDS_PER_CALL = 32

# Documented worst case for one call's whole model-visible result.
# Documentation, not runtime enforcement. Pinned at 22_000 (Fable ruling).
MAX_RETRIEVAL_OUTPUT_TOKENS = 22_000

# Valid retrieval id shape: t or m followed by 1–12 *ASCII* digits.
# JS ``\d`` is ASCII-only; Python ``\d`` is Unicode-aware unless restricted.
RETRIEVAL_ID_PATTERN = re.compile(r"^[tm][0-9]{1,12}$")

UnservedReason = Literal["not_found", "deleted", "budget", "invalid"]
RetrievedTurnSource = Literal["stored", "composed"]


@dataclass(frozen=True, slots=True)
class RetrievalOptions:
    """Per-call retrieval options (snake_case public API)."""

    token_budget: float | int | None = None
    byte_budget: float | int | None = None
    from_token: float | int | None = None
    surface: str | None = None


@dataclass(frozen=True, slots=True)
class SliceReceipt:
    from_token: int
    to_token: int
    total_tokens: int


@dataclass(frozen=True, slots=True)
class UnservedEntity:
    id: str
    reason: UnservedReason
    tokens: int | None = None


@dataclass(frozen=True, slots=True)
class RetrievedTurn:
    turn_id: str
    text: str
    tokens: int
    source: RetrievedTurnSource
    slice: SliceReceipt | None = None


@dataclass(frozen=True, slots=True)
class RetrievedMessage:
    message_id: str
    turn_id: str
    kind: str
    text: str
    tokens: int
    slice: SliceReceipt | None = None


TServed = TypeVar("TServed")


@dataclass(frozen=True, slots=True)
class RetrievalReceipt(Generic[TServed]):
    call_id: str
    served: list[TServed]
    unserved: list[UnservedEntity]
    total_tokens: int
    # Float-preserving: TS ``Math.min`` keeps fractional budgets (0.5, 7999.9).
    token_budget: float


@dataclass(frozen=True, slots=True)
class ImpressionRecord:
    call_id: str
    surface: str
    entity_kind: Literal["turn", "message"]
    entity_id: str
    request_idx: int
    served: bool
    reason: str | None
    tokens: int | None
    recorded_at: str


@dataclass(frozen=True, slots=True)
class _ImpressionRow:
    entity_kind: Literal["turn", "message"]
    entity_id: str
    request_idx: int
    served: bool
    reason: UnservedReason | None = None
    tokens: int | None = None


def _replace_lone_surrogates(text: str) -> str:
    """Match Node/SQLite storage of mid-pair UTF-16 slices.

    JS ``id.slice(0, 32)`` can leave a lone surrogate when the 32-unit boundary
    splits an astral character. Node's SQLite binding stores U+FFFD for that
    unit; Python's sqlite3 refuses to encode surrogates at all. Replace them
    so the impression write succeeds and the durable echo matches Node.
    """
    return "".join(
        "\uFFFD" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in text
    )


def clamp_id_echo(id_: str) -> str:
    """Echo bound for invalid ids in receipts/impressions (UTF-16 parity).

    Counts UTF-16 code units so non-ASCII echoes match TS ``id.slice(0, 32)``.
    Lone surrogates from a mid-pair cut are replaced with U+FFFD so the echo
    is SQLite-storable and matches Node/SQLite stored form.
    """
    if js_len(id_) <= 32:
        raw = id_
    else:
        raw = f"{js_slice(id_, 0, 32)}…"
    return _replace_lone_surrogates(raw)


def _is_valid_retrieval_id(id_: str) -> bool:
    return RETRIEVAL_ID_PATTERN.fullmatch(id_) is not None


def _dedupe(ids: Sequence[str]) -> list[str]:
    """First occurrence wins; duplicate requests collapse to one serve/impression."""
    seen: set[str] = set()
    out: list[str] = []
    for id_ in ids:
        if id_ in seen:
            continue
        seen.add(id_)
        out.append(id_)
    return out


def _write_impressions(
    db: Database, call_id: str, surface: str, rows: Sequence[_ImpressionRow]
) -> None:
    insert = db.prepare(
        """INSERT INTO retrieval_impression
             (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)"""
    )
    for row in rows:
        insert.run(
            call_id,
            surface,
            row.entity_kind,
            row.entity_id,
            row.request_idx,
            1 if row.served else 0,
            row.reason,
            row.tokens,
        )


def _utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def _to_finite_js_number(value: int | float) -> float | None:
    """Convert a Python int/float to a finite IEEE-754 value, or ``None``.

    TS ``number`` is always a finite-or-special double. Python ints past
    ``Number.MAX_VALUE`` raise ``OverflowError`` on ``float()`` — treat those
    as outside the JS Number domain rather than letting the exception escape.
    """
    try:
        as_float = float(value)
    except OverflowError:
        return None
    if not math.isfinite(as_float):
        return None
    return as_float


def _is_js_number_integer(value: object) -> bool:
    """Match TS ``Number.isInteger`` for values that can be finite JS numbers.

    ``Number.isInteger(x)`` requires ``typeof x === "number"``, finite, and
    ``Math.floor(x) === x``. Python ``bool`` is excluded (TS boolean is not a
    number). Arbitrary-precision ints that cannot convert to a finite double
    are outside the domain and rejected.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer()
    as_float = _to_finite_js_number(value)
    return as_float is not None and as_float.is_integer()


def _resolve_budget(options: RetrievalOptions | None) -> float:
    budget = (
        DEFAULT_RETRIEVAL_TOKEN_BUDGET
        if options is None or options.token_budget is None
        else options.token_budget
    )
    if isinstance(budget, bool) or not isinstance(budget, (int, float)):
        raise ValueError(f"retrieval tokenBudget must be a positive number, got {budget!s}")
    as_float = _to_finite_js_number(budget)
    if as_float is None or as_float <= 0:
        raise ValueError(f"retrieval tokenBudget must be a positive number, got {budget!s}")
    # Default is also the ceiling: callers cannot raise the model-visible bound.
    # Preserve fractional values (TS ``Math.min``) — do not truncate with int().
    return min(as_float, float(DEFAULT_RETRIEVAL_TOKEN_BUDGET))


def _resolve_byte_budget(options: RetrievalOptions | None) -> float:
    if options is None or options.byte_budget is None:
        return math.inf
    budget = options.byte_budget
    if isinstance(budget, bool) or not isinstance(budget, (int, float)):
        raise ValueError(f"retrieval byteBudget must be a positive number, got {budget!s}")
    # TS: Number.isNaN(budget) || budget <= 0 — +Infinity is allowed (default).
    # Huge Python ints outside the float domain are not valid JS numbers.
    try:
        as_float = float(budget)
    except OverflowError:
        raise ValueError(
            f"retrieval byteBudget must be a positive number, got {budget!s}"
        ) from None
    if math.isnan(as_float) or as_float <= 0:
        raise ValueError(f"retrieval byteBudget must be a positive number, got {budget!s}")
    return as_float


def _resolve_from_token(options: RetrievalOptions | None) -> int:
    from_token = 0 if options is None or options.from_token is None else options.from_token
    # TS: Number.isInteger(from) && from >= 0 — finite Number domain only.
    if not _is_js_number_integer(from_token) or from_token < 0:  # type: ignore[operator]
        raise ValueError(
            f"retrieval fromToken must be a non-negative integer, got {from_token!s}"
        )
    return int(from_token)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class _Servable(Generic[TServed]):
    kind: Literal["servable"]
    item: TServed
    tokens: int


@dataclass(frozen=True, slots=True)
class _Unservable:
    kind: Literal["unservable"]
    reason: UnservedReason


@dataclass(frozen=True, slots=True)
class _Candidate(Generic[TServed]):
    id: str
    outcome: _Servable[TServed] | _Unservable


def _budget_walk(
    candidates: Sequence[_Candidate[TServed]],
    entity_kind: Literal["turn", "message"],
    token_budget: float,
    byte_budget: float,
    from_token: int,
) -> tuple[list[TServed], list[UnservedEntity], int, list[_ImpressionRow]]:
    """In-order budget walk shared by both ops (TS budgetWalk)."""
    served: list[TServed] = []
    unserved: list[UnservedEntity] = []
    impressions: list[_ImpressionRow] = []
    total_tokens = 0
    total_bytes = 0
    for request_idx, candidate in enumerate(candidates):
        if candidate.outcome.kind == "unservable":
            reason = candidate.outcome.reason
            unserved.append(UnservedEntity(id=candidate.id, reason=reason))
            impressions.append(
                _ImpressionRow(
                    entity_kind=entity_kind,
                    entity_id=candidate.id,
                    request_idx=request_idx,
                    served=False,
                    reason=reason,
                )
            )
            continue

        item = candidate.outcome.item
        tokens = candidate.outcome.tokens
        remaining = token_budget - total_tokens
        remaining_bytes = byte_budget - total_bytes
        item_text = item.text  # type: ignore[attr-defined]
        item_bytes = _utf8_bytes(item_text)

        # Whole serve: no offset and full text fits both budgets.
        if from_token == 0 and tokens <= remaining and item_bytes <= remaining_bytes:
            served.append(item)
            total_tokens += tokens
            total_bytes += item_bytes
            impressions.append(
                _ImpressionRow(
                    entity_kind=entity_kind,
                    entity_id=candidate.id,
                    request_idx=request_idx,
                    served=True,
                    tokens=tokens,
                )
            )
            continue

        # Partial serve: explicit continuation always slices; budget-crossing
        # items slice only when enough budget remains to be worth reading.
        # Slice helpers floor max_tokens (TS Math.floor); remaining may be float.
        if from_token > 0 or remaining >= RETRIEVAL_SLICE_FLOOR:
            # TS passes remaining (possibly fractional); slice helpers Math.floor.
            slice_max = remaining if remaining >= 0 else 0
            if math.isfinite(byte_budget):
                # Pass remaining bytes as float (TS compares <= maxBytes directly).
                window = slice_tokens_byte_capped(
                    item_text, from_token, slice_max, remaining_bytes
                )
            else:
                window = slice_tokens(item_text, from_token, slice_max)
            served_tokens = window.to_token - window.from_token
            token_window = min(remaining, max(0, window.total_tokens - window.from_token))
            byte_bound = math.isfinite(byte_budget) and served_tokens < token_window
            sliver = (
                not byte_bound
                and from_token == 0
                and served_tokens < min(RETRIEVAL_SLICE_FLOOR, tokens)
            )
            if sliver:
                unserved.append(
                    UnservedEntity(id=candidate.id, reason="budget", tokens=tokens)
                )
                impressions.append(
                    _ImpressionRow(
                        entity_kind=entity_kind,
                        entity_id=candidate.id,
                        request_idx=request_idx,
                        served=False,
                        reason="budget",
                        tokens=tokens,
                    )
                )
                continue
            receipt = SliceReceipt(
                from_token=window.from_token,
                to_token=window.to_token,
                total_tokens=window.total_tokens,
            )
            sliced = replace(  # type: ignore[type-var]
                item, text=window.text, tokens=served_tokens, slice=receipt
            )
            served.append(sliced)
            total_tokens += served_tokens
            total_bytes += _utf8_bytes(window.text)
            impressions.append(
                _ImpressionRow(
                    entity_kind=entity_kind,
                    entity_id=candidate.id,
                    request_idx=request_idx,
                    served=True,
                    tokens=served_tokens,
                )
            )
            continue

        unserved.append(UnservedEntity(id=candidate.id, reason="budget", tokens=tokens))
        impressions.append(
            _ImpressionRow(
                entity_kind=entity_kind,
                entity_id=candidate.id,
                request_idx=request_idx,
                served=False,
                reason="budget",
                tokens=tokens,
            )
        )
    return served, unserved, total_tokens, impressions


def _turn_candidate(db: Database, turn_id: str) -> _Candidate[RetrievedTurn]:
    source = read_turn_source(db, turn_id)
    if source is None:
        return _Candidate(id=turn_id, outcome=_Unservable(kind="unservable", reason="not_found"))
    if source.deleted:
        return _Candidate(id=turn_id, outcome=_Unservable(kind="unservable", reason="deleted"))

    stored = db.prepare(
        """SELECT state, content FROM derivation
           WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'"""
    ).get(turn_id)
    stored_content: str | None = None
    if stored is not None and stored.get("state") == "ready" and isinstance(stored.get("content"), str):
        stored_content = str(stored["content"])

    members = read_member_messages(db, turn_id)
    message_ids = [m.message_id for m in members]
    derivations = read_message_derivation_rows(db, message_ids)
    # R3 helper: labeled pass-through or live recompose (legacy unlabeled ready).
    text = labeled_or_recomposed_turn_rendering(
        turn_id, stored_content, members, derivations
    )
    from ..turns.internal.compose import stored_rendering_has_turn_label

    source_kind: RetrievedTurnSource = (
        "stored"
        if isinstance(stored_content, str)
        and stored_rendering_has_turn_label(stored_content, turn_id)
        else "composed"
    )
    tokens = estimate_tokens(text)
    return _Candidate(
        id=turn_id,
        outcome=_Servable(
            kind="servable",
            item=RetrievedTurn(
                turn_id=turn_id, text=text, tokens=tokens, source=source_kind
            ),
            tokens=tokens,
        ),
    )


def _verbatim_text(blocks: Sequence[dict[str, object]]) -> str:
    """Verbatim historical content from stored blocks (not a summary)."""
    parts: list[str] = []
    for block in blocks:
        block_type = str(block["block_type"])
        raw = block["content"]
        content: dict[str, object]
        if isinstance(raw, str):
            content = json.loads(raw)
        elif isinstance(raw, dict):
            content = raw
        else:
            content = {}
        if block_type in ("text", "user_steer"):
            text_val = content.get("text")
            parts.append(
                text_val if isinstance(text_val, str) else js_json_dumps(content)
            )
        elif block_type == "tool_call":
            name = content.get("toolName") if isinstance(content.get("toolName"), str) else "tool"
            call_id = content.get("toolCallId") if isinstance(content.get("toolCallId"), str) else ""
            id_part = f" {call_id}" if call_id else ""
            # TS: JSON.stringify(content["arguments"], null, 2) — ECMAScript
            # number spelling (1.0 → "1", 1e-7 → "1e-7"), not Python json.dumps.
            args_pretty = js_json_dumps_pretty(content.get("arguments"))
            parts.append(f"[tool_call {name}{id_part}]\n{args_pretty}")
        elif block_type == "tool_result":
            call_id = content.get("toolCallId") if isinstance(content.get("toolCallId"), str) else ""
            is_error = content.get("isError") is True
            body_val = content.get("content")
            body = body_val if isinstance(body_val, str) else js_json_dumps(body_val)
            id_part = f" {call_id}" if call_id else ""
            err_part = " ERROR" if is_error else ""
            parts.append(f"[tool_result{id_part}{err_part}]\n{body}")
        else:
            # model_change / thinking_level_change (and any other stored type):
            # TS default arm uses JSON.stringify(content, null, 2).
            parts.append(f"[{block_type}]\n{js_json_dumps_pretty(content)}")
    return "\n".join(parts)


def _message_candidate(db: Database, message_id: str) -> _Candidate[RetrievedMessage]:
    row = db.prepare(
        "SELECT message_id, turn_id, kind, deleted_at FROM message WHERE message_id = ?"
    ).get(message_id)
    if row is None:
        return _Candidate(
            id=message_id, outcome=_Unservable(kind="unservable", reason="not_found")
        )
    if row.get("deleted_at") is not None:
        return _Candidate(
            id=message_id, outcome=_Unservable(kind="unservable", reason="deleted")
        )
    blocks = db.prepare(
        "SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index"
    ).all(message_id)
    text = _verbatim_text(blocks)
    tokens = estimate_tokens(text)
    return _Candidate(
        id=message_id,
        outcome=_Servable(
            kind="servable",
            item=RetrievedMessage(
                message_id=message_id,
                turn_id=str(row["turn_id"]),
                kind=str(row["kind"]),
                text=text,
                tokens=tokens,
            ),
            tokens=tokens,
        ),
    )


async def get_turns(
    ref: ThreadRef,
    turn_ids: Sequence[str],
    options: RetrievalOptions | None = None,
) -> OpResult[RetrievalReceipt[RetrievedTurn]]:
    """Rendered turns by turn id, in request order, under a whole-item budget."""
    return await _retrieve(ref, turn_ids, options, "get_turns", "turn", _turn_candidate)


async def get_messages(
    ref: ThreadRef,
    message_ids: Sequence[str],
    options: RetrievalOptions | None = None,
) -> OpResult[RetrievalReceipt[RetrievedMessage]]:
    """Verbatim messages by message id, in request order, under a whole-item budget."""
    return await _retrieve(
        ref, message_ids, options, "get_messages", "message", _message_candidate
    )


async def _retrieve(
    ref: ThreadRef,
    ids: Sequence[str],
    options: RetrievalOptions | None,
    default_surface: str,
    entity_kind: Literal["turn", "message"],
    candidate_of,
) -> OpResult[RetrievalReceipt]:
    try:
        token_budget = _resolve_budget(options)
        byte_budget = _resolve_byte_budget(options)
        from_token = _resolve_from_token(options)
    except ValueError as cause:
        return storage_failure(str(cause))

    if len(ids) == 0:
        return storage_failure(f"{default_surface}: at least one id is required")

    deduped = _dedupe(ids)
    if len(deduped) > MAX_RETRIEVAL_IDS_PER_CALL:
        return storage_failure(
            f"{default_surface}: too many ids — {len(deduped)} requested, "
            f"cap is {MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request"
        )

    surface = (
        options.surface
        if options is not None and options.surface is not None
        else default_surface
    )
    call_id = str(uuid.uuid4())

    try:
        # Write transaction: the serve itself is a read, but every call logs
        # impressions — the durable usage record is part of the contract.
        def _body(transaction) -> RetrievalReceipt:
            candidates: list[_Candidate] = []
            for id_ in deduped:
                if _is_valid_retrieval_id(id_):
                    candidates.append(candidate_of(transaction.db, id_))
                else:
                    candidates.append(
                        _Candidate(
                            id=clamp_id_echo(id_),
                            outcome=_Unservable(kind="unservable", reason="invalid"),
                        )
                    )
            walk_served, walk_unserved, total_tokens, impressions = _budget_walk(
                candidates, entity_kind, token_budget, byte_budget, from_token
            )
            _write_impressions(transaction.db, call_id, surface, impressions)
            return RetrievalReceipt(
                call_id=call_id,
                served=walk_served,
                unserved=walk_unserved,
                total_tokens=total_tokens,
                token_budget=token_budget,
            )

        return await create_db_write_transaction(ref, _body)
    except Exception as cause:  # noqa: BLE001 — mirrors TS catch
        reason = str(cause)
        return storage_failure(f"{default_surface} failed: {reason}")


async def list_impressions(ref: ThreadRef) -> OpResult[list[ImpressionRecord]]:
    """Impression read-back (inspection/test seam; ranking work reads this later)."""
    try:

        def _body(transaction) -> list[ImpressionRecord]:
            rows = transaction.db.prepare(
                """SELECT call_id, surface, entity_kind, entity_id, request_idx,
                          served, reason, tokens, recorded_at
                   FROM retrieval_impression ORDER BY impression_id"""
            ).all()
            return [
                ImpressionRecord(
                    call_id=str(row["call_id"]),
                    surface=str(row["surface"]),
                    entity_kind=str(row["entity_kind"]),  # type: ignore[arg-type]
                    entity_id=str(row["entity_id"]),
                    request_idx=int(row["request_idx"]),  # type: ignore[arg-type]
                    served=int(row["served"]) == 1,  # type: ignore[arg-type]
                    reason=str(row["reason"]) if row["reason"] is not None else None,
                    tokens=int(row["tokens"]) if row["tokens"] is not None else None,
                    recorded_at=str(row["recorded_at"]),
                )
                for row in rows
            ]

        return await create_db_read_transaction(ref, _body)
    except Exception as cause:  # noqa: BLE001 — mirrors TS catch
        reason = str(cause)
        return storage_failure(f"impression read-back failed: {reason}")


from .format import (  # noqa: E402 — after types; format TYPE_CHECKING-imports us
    PULL_TOKEN_BUDGET,
    assemble_result,
    format_get_messages_result,
    format_get_turns_result,
    message_section,
    recall_close,
    recall_open,
    section_footer,
    slice_footer,
    turn_section,
    unserved_line,
)

__all__ = [
    "DEFAULT_RETRIEVAL_TOKEN_BUDGET",
    "MAX_RETRIEVAL_IDS_PER_CALL",
    "MAX_RETRIEVAL_OUTPUT_TOKENS",
    "PULL_TOKEN_BUDGET",
    "RETRIEVAL_ID_PATTERN",
    "RETRIEVAL_SLICE_FLOOR",
    "ImpressionRecord",
    "RetrievalOptions",
    "RetrievalReceipt",
    "RetrievedMessage",
    "RetrievedTurn",
    "RetrievedTurnSource",
    "SliceReceipt",
    "UnservedEntity",
    "UnservedReason",
    "assemble_result",
    "clamp_id_echo",
    "format_get_messages_result",
    "format_get_turns_result",
    "get_messages",
    "get_turns",
    "list_impressions",
    "message_section",
    "recall_close",
    "recall_open",
    "section_footer",
    "slice_footer",
    "turn_section",
    "unserved_line",
]
