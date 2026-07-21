"""Ported from packages/lhc/src/thread-view/index.ts.

thread-view surface: model context, status, compact, materialize, and
describe. Hot-path reads use local deterministic assembly only: no inference,
no network, no queue interaction, and no writes. Profile resolution consumed
by initLhc is re-exported at the bottom.

Wave 6 owns the full thread-view surface. Wave 4/5 forward stubs
(CompactAbortSignal, CompactOpts, status, compact, get_llm_request_context)
are extended — not reshaped.
"""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from ..messages import report as messages_report
from ..shared_tech._jsstr import js_repr as _js_repr
from ..shared_tech.context import resolve_instance_view_config
from ..shared_tech.derivation import DerivationReportEntry
from ..shared_tech.errors import ErrorResult, OpErr, OpOk, OpResult, storage_failure
from ..shared_tech.logging import LogEntry, write_log
from ..shared_tech.persist import (
    DbReadTransaction,
    DbWriteTransaction,
    create_db_read_transaction,
    create_db_write_transaction,
)
from ..shared_tech.storage import Database
from ..shared_tech.token_counting import estimate_tokens
from ..shared_tech.view import (
    Band,
    CompactBandStats,
    CompactDegradedEntry,
    CompactGapEntry,
    CompactReceipt,
    CompactReceiptConfig,
    CompactRenderedBand,
    CompactWarning,
    LlmRequestContext,
    LlmRequestContextMessage,
    LlmRequestContextPart,
    PreviewCompactErr,
    PreviewCompactOk,
    PreviewCompactOutcome,
    PreviewCompactResult,
    PruneReceipt,
    ResolvedViewConfig,
    SessionThreadView,
    StoredView,
    ViewCompactParams,
    ViewProfile,
    ViewProfilePercentages,
    ViewStatus,
    ViewStatusDerivation,
    ViewStatusView,
    ViewStatusVisibility,
)
from ..threads import ThreadRef, open_thread_database, resolve_thread_ref
from ..turns import report as turns_report
from .internal.assemble import assemble_view
from .internal.boundary import read_boundary_position, visibility_zone_tokens
from .internal.compact_compute import ComputeArrangementOpts, compact_stopped, compute_arrangement
from .internal.materialize import MaterializeEntry, MaterializeInput, MaterializeResult, write_pi_session_file
from .internal.profiles import (
    BUILT_IN_PROFILES,
    DEFAULT_COMPACT_THRESHOLD,
    DEFAULT_VISIBILITY,
    profile_violation,
    resolve_view_config,
)
from .internal.render import assemble_band_text
from .internal.seam import fire_view_injection
from .internal.select import ArrangementEntry
from .internal.session_view import build_session_thread_view
from .internal.snapshot import (
    ViewReplaceBand,
    ViewReplaceInput,
    read_stored_view,
    read_thread_metadata,
    read_view_snapshot,
    replace_view_snapshot,
    tail_token_sum,
)

# Config resolution for the operation in hand: the SDK instance's resolved
# view config rides the per-instance seam; below-SDK direct domain calls fall
# back to the built-in defaults through the same one resolution path initLhc
# uses.
_DEFAULT_VIEW_CONFIG: ResolvedViewConfig = resolve_view_config()


def _view_config() -> ResolvedViewConfig:
    # None-check (TS `??`), not truthiness — an empty resolved config must win.
    resolved = resolve_instance_view_config()
    if resolved is not None:
        return resolved
    return _DEFAULT_VIEW_CONFIG


def _thread_not_found(file_path: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code="thread_not_found",
            reason=f"no thread file exists at {file_path}",
        )
    )


def _detail(cause: object) -> str:
    if isinstance(cause, BaseException):
        return str(cause)
    return str(cause)


def _iso_millis(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _iso_millis_now() -> str:
    return _iso_millis(datetime.now(timezone.utc))


def _json_compact(value: object) -> str:
    from ..shared_tech._jsstr import js_json_dumps

    return js_json_dumps(value)


@dataclass(frozen=True, slots=True)
class CompactAbortSignal:
    """TS compact opts.signal — dot-accessed `{ aborted: boolean }`."""

    aborted: bool


@dataclass(frozen=True, slots=True)
class CompactOpts:
    """Opts bag for compact / previewCompact — mirrors the TS inline object."""

    profile: str | None = None
    params: ViewCompactParams | None = None
    signal: CompactAbortSignal | None = None


# ── model context ────────────────────────────────────────────────

# The hot-path read: view header + bands (if any), tail messages after the
# compact point (deleted-filtered, record order), boundary position; then
# format — band messages first, tail per the mapping table, tool results
# at-or-behind the boundary in short form. No view row ⇒ the whole record is
# tail from event 1 through this same code path with the compact point at its
# zero origin: snapshot-absent, never a separate branch.
#
# Reads-only is structural, not disciplined: the whole operation runs in the
# touch-suppressed scope, so the open announcement that would let a
# background SDK's scheduler hang a first-touch catch-up drain off this read
# (openThreadDatabase → fireThreadTouch → scheduler.touch) never fires.
async def get_llm_request_context(ref: ThreadRef) -> OpResult[LlmRequestContext]:
    try:
        return await create_db_read_transaction(
            ref,
            lambda transaction: LlmRequestContext(
                thread_id=read_thread_metadata(transaction.db).thread_id,
                messages=[
                    LlmRequestContextMessage(
                        role=entry.message.role,
                        content=[LlmRequestContextPart(type="text", text=entry.message.content)],
                    )
                    for entry in assemble_view(transaction.db).entries
                ],
            ),
        )
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view getLlmRequestContext failed: {_detail(cause)}")


# SessionManager-friendly materialization from canonical record data: compacted
# bands as user context lines, tail messages regrouped into user / assistant /
# toolResult shapes. Reads-only, touch-suppressed like getLlmRequestContext.
async def get_session_thread_view(ref: ThreadRef) -> OpResult[SessionThreadView]:
    try:
        return await create_db_read_transaction(
            ref,
            lambda transaction: build_session_thread_view(transaction.db),
        )
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view getSessionThreadView failed: {_detail(cause)}")


# ── status ───────────────────────────────────────────────────────


# Derivation counts bucket from one report entry. Ready derivations are healthy
# and not an operational situation.
def _bucket_derivation(entries: Sequence[DerivationReportEntry], counts: ViewStatusDerivation) -> None:
    for entry in entries:
        if entry.state == "pending":
            counts.pending += 1
        elif entry.state == "failed":
            counts.failed += 1
        elif entry.state == "blocked":
            counts.blocked += 1
        elif entry.state == "ready":
            pass


# Reads only, callable any time, no side effects: tail size against the
# configured trigger threshold with a compact recommendation, derivation
# counts by state, the active view's health or null pre-compact, and the
# visibility zone's sum against its max.
async def status(ref: ThreadRef) -> OpResult[ViewStatus]:
    resolved = await resolve_thread_ref(ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not os.path.exists(file_path):
        return _thread_not_found(file_path)

    config = _view_config()

    @dataclass(frozen=True, slots=True)
    class _StatusRead:
        tail_tokens: int
        boundary_position: int
        zone_tokens: int
        view: ViewStatusView | None

    try:

        def _read(transaction: DbReadTransaction) -> _StatusRead:
            snapshot = read_view_snapshot(transaction.db)
            compact_point = 0 if snapshot is None else snapshot.compact_point
            boundary_position = read_boundary_position(transaction.db)
            return _StatusRead(
                tail_tokens=tail_token_sum(transaction.db, compact_point),
                boundary_position=boundary_position,
                zone_tokens=visibility_zone_tokens(transaction.db, boundary_position, compact_point),
                view=(
                    None
                    if snapshot is None
                    else ViewStatusView(
                        degraded=snapshot.degraded_count,
                        gaps=snapshot.gap_count,
                        built_at=snapshot.created_at,
                    )
                ),
            )

        read = await create_db_read_transaction({"filePath": file_path}, _read)
        if not read.ok:
            return read
        tail_tokens = read.value.tail_tokens
        boundary_position = read.value.boundary_position
        zone_tokens = read.value.zone_tokens
        view = read.value.view
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view status failed: {_detail(cause)}")

    # The owners' report surfaces open their own handles; ours is closed first
    # so the status read never holds two handles on one thread file.
    message_report = await messages_report({"filePath": file_path})
    if not message_report.ok:
        return message_report
    turn_report = await turns_report({"filePath": file_path})
    if not turn_report.ok:
        return turn_report
    derivation = ViewStatusDerivation(pending=0, failed=0, blocked=0)
    _bucket_derivation(message_report.value, derivation)
    _bucket_derivation(turn_report.value, derivation)

    return OpOk(
        ViewStatus(
            tail_tokens=tail_tokens,
            threshold=config.compact_threshold,
            compact_recommended=tail_tokens > config.compact_threshold,
            derivation=derivation,
            view=view,
            visibility=ViewStatusVisibility(
                boundary_position=boundary_position,
                zone_tokens=zone_tokens,
                max_tokens=config.visibility.max_tokens,
            ),
        )
    )


# ── describe ─────────────────────────────────────────────────────


# The stored active view row, exposed read-only so inspect never reads
# thread-view tables directly. Everything is the snapshot verbatim:
# arrangement, gaps, config, source-state provenance, per-band stored token
# counts; nothing is recomputed, repaired, or read from the record. Absent
# view means ok with null, mirroring status's never-compacted behavior. Like the
# other reads, the whole operation runs touch-suppressed: a background SDK's
# describe can never schedule a catch-up drain.
async def describe(ref: ThreadRef) -> OpResult[StoredView | None]:
    try:
        return await create_db_read_transaction(
            ref,
            lambda transaction: read_stored_view(transaction.db),
        )
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view describe failed: {_detail(cause)}")


# ── prune ────────────────────────────────────────────────────────


def _prune_caller_error(code: Literal["invalid_target_tokens"], reason: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code=code,
            reason=reason,
        )
    )


def _validate_prune_target(target_tokens: int | float | None) -> OpResult[int]:
    if target_tokens is None:
        return OpOk(_view_config().visibility.target_tokens)
    if (
        isinstance(target_tokens, bool)
        or not isinstance(target_tokens, (int, float))
        or not math.isfinite(target_tokens)
        or int(target_tokens) != target_tokens
        or target_tokens < 0
    ):
        return _prune_caller_error(
            "invalid_target_tokens",
            (
                "targetTokens must be a non-negative finite integer; received "
                f"{_js_repr(target_tokens)}"
            ),
        )
    return OpOk(int(target_tokens))


@dataclass(frozen=True, slots=True)
class _ToolResultZoneRow:
    source_event_order: int
    token_estimate: int


_SQL_READ_ZONE_TOOL_RESULTS = (
    """SELECT source_event_order, token_estimate FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL AND source_event_order > ?
       ORDER BY source_event_order DESC"""
)

_SQL_TOKENS_BEHIND_BOUNDARY = (
    """SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?"""
)

_SQL_COUNT_PRUNED_TOOL_RESULTS = (
    """SELECT COUNT(*) AS n FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order <= ?"""
)

_SQL_UPDATE_BOUNDARY = """UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1"""


def _read_zone_tool_results(db: Database, effective_start: int) -> list[_ToolResultZoneRow]:
    rows = db.prepare(_SQL_READ_ZONE_TOOL_RESULTS).all(effective_start)
    return [
        _ToolResultZoneRow(
            source_event_order=int(row["source_event_order"]),  # type: ignore[arg-type]
            token_estimate=int(row["token_estimate"]),  # type: ignore[arg-type]
        )
        for row in rows
    ]


def _tokens_behind_boundary(db: Database, boundary: int, compact_point: int) -> int:
    row = db.prepare(_SQL_TOKENS_BEHIND_BOUNDARY).get(compact_point, boundary)
    assert row is not None
    return int(row["total"])  # type: ignore[arg-type]


def _count_pruned_tool_results(
    db: Database,
    previous_boundary: int,
    new_boundary: int,
    compact_point: int,
) -> int:
    row = db.prepare(_SQL_COUNT_PRUNED_TOOL_RESULTS).get(
        max(previous_boundary, compact_point),
        new_boundary,
    )
    assert row is not None
    return int(row["n"])  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class _BuildPruneReceiptInput:
    previous_boundary: int
    new_boundary: int
    compact_point: int
    target_tokens: int
    zone_tokens_before: int
    no_op: bool


def _build_prune_receipt(db: Database, input: _BuildPruneReceiptInput) -> PruneReceipt:
    zone_tokens_after = visibility_zone_tokens(db, input.new_boundary, input.compact_point)
    return PruneReceipt(
        previous_boundary=input.previous_boundary,
        new_boundary=input.new_boundary,
        compact_point=input.compact_point,
        target_tokens=input.target_tokens,
        tool_results_pruned=(
            0
            if input.no_op
            else _count_pruned_tool_results(
                db, input.previous_boundary, input.new_boundary, input.compact_point
            )
        ),
        tokens_behind_boundary=_tokens_behind_boundary(db, input.new_boundary, input.compact_point),
        zone_tokens_before=input.zone_tokens_before,
        zone_tokens_after=zone_tokens_after,
        no_op=input.no_op,
    )


def _compute_prune_boundary(
    rows: Sequence[_ToolResultZoneRow],
    target_tokens: int,
    previous_boundary: int,
) -> int:
    accumulated = 0
    for row in rows:
        if accumulated + row.token_estimate <= target_tokens:
            accumulated += row.token_estimate
            continue
        return row.source_event_order
    return previous_boundary


def _prune_in_transaction(transaction: DbWriteTransaction, target_tokens: int) -> PruneReceipt:
    db = transaction.db
    snapshot = read_view_snapshot(db)
    compact_point = 0 if snapshot is None else snapshot.compact_point
    previous_boundary = read_boundary_position(db)
    effective_start = max(previous_boundary, compact_point)
    zone_tokens_before = visibility_zone_tokens(db, previous_boundary, compact_point)

    if zone_tokens_before <= target_tokens:
        return _build_prune_receipt(
            db,
            _BuildPruneReceiptInput(
                previous_boundary=previous_boundary,
                new_boundary=previous_boundary,
                compact_point=compact_point,
                target_tokens=target_tokens,
                zone_tokens_before=zone_tokens_before,
                no_op=True,
            ),
        )

    rows = _read_zone_tool_results(db, effective_start)
    computed_boundary = _compute_prune_boundary(rows, target_tokens, previous_boundary)

    if computed_boundary <= previous_boundary:
        return _build_prune_receipt(
            db,
            _BuildPruneReceiptInput(
                previous_boundary=previous_boundary,
                new_boundary=previous_boundary,
                compact_point=compact_point,
                target_tokens=target_tokens,
                zone_tokens_before=zone_tokens_before,
                no_op=True,
            ),
        )

    if computed_boundary <= compact_point:
        raise RuntimeError(
            f"prune boundary {computed_boundary} would land behind compact point {compact_point}"
        )

    updated_at = _iso_millis(transaction.clock())
    db.prepare(_SQL_UPDATE_BOUNDARY).run(computed_boundary, updated_at)

    return _build_prune_receipt(
        db,
        _BuildPruneReceiptInput(
            previous_boundary=previous_boundary,
            new_boundary=computed_boundary,
            compact_point=compact_point,
            target_tokens=target_tokens,
            zone_tokens_before=zone_tokens_before,
            no_op=False,
        ),
    )


@dataclass(frozen=True, slots=True)
class PruneParams:
    """TS `params?: { targetTokens?: number }` — input is JS number (int|float)."""

    target_tokens: int | float | None = None


# Advance the visibility boundary forward so older tool results in the
# visibility zone render short. Deterministic, no inference, one write
# transaction. Explicit commands always execute and report — a zone already
# under target returns a no-op receipt, never an error.
async def prune(ref: ThreadRef, params: PruneParams | None = None) -> OpResult[PruneReceipt]:
    resolved = await resolve_thread_ref(ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not os.path.exists(file_path):
        return _thread_not_found(file_path)

    target = _validate_prune_target(None if params is None else params.target_tokens)
    if not target.ok:
        return target

    try:
        return await create_db_write_transaction(
            ref,
            lambda transaction: _prune_in_transaction(transaction, target.value),
        )
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view prune failed: {_detail(cause)}")


# ── compact ──────────────────────────────────────────────────────

# The default base when no profile is named: the first built-in, matching
# the PI continuation harness. Explicit params override the base field-wise.
_DEFAULT_PROFILE_NAME = "continuation"

_CallerErrorCode = Literal["unknown_profile", "invalid_view_config", "compact_stopped"]


def _caller_error(code: _CallerErrorCode, reason: str) -> OpErr:
    return OpErr(
        error=ErrorResult(
            error_class="caller_error",
            code=code,
            reason=reason,
        )
    )


@dataclass(frozen=True, slots=True)
class _ResolvedCompactCall:
    merged: ViewProfile
    profile_name: str | None


def _merge_percentages(
    base: ViewProfilePercentages,
    override: ViewProfilePercentages | object | None,
) -> ViewProfilePercentages:
    if override is None:
        return base
    # PartialViewProfilePercentages: only non-None fields override (TS object spread).
    full = getattr(override, "full", None)
    smooth = getattr(override, "smooth", None)
    detailed = getattr(override, "detailed", None)
    brief = getattr(override, "brief", None)
    return ViewProfilePercentages(
        full=base.full if full is None else full,
        smooth=base.smooth if smooth is None else smooth,
        detailed=base.detailed if detailed is None else detailed,
        brief=base.brief if brief is None else brief,
    )


def _resolve_compact_call(opts: CompactOpts) -> OpResult[_ResolvedCompactCall]:
    config = _view_config()
    base_name = _DEFAULT_PROFILE_NAME if opts.profile is None else opts.profile
    base = config.profiles.get(base_name)
    if base is None:
        named = ", ".join(f'"{name}"' for name in config.profiles)
        return _caller_error(
            "unknown_profile",
            f'unknown profile "{base_name}"; configured profiles are {named}',
        )
    params = opts.params
    lower_bound = base.lower_bound if params is None or params.lower_bound is None else params.lower_bound
    percentages = _merge_percentages(
        base.percentages,
        None if params is None else params.percentages,
    )
    merged = ViewProfile(name=base.name, lower_bound=lower_bound, percentages=percentages)
    violation = profile_violation(merged)
    if violation is not None:
        return _caller_error("invalid_view_config", violation)
    profile_name = base_name if params is None else None
    return OpOk(_ResolvedCompactCall(merged=merged, profile_name=profile_name))


_BAND_ORDER: tuple[Band, ...] = ("brief", "detailed", "smooth")


@dataclass(frozen=True, slots=True)
class _StoredBandRow:
    band: Band
    rendered_text: str
    token_count: int


@dataclass(frozen=True, slots=True)
class _BandSelection:
    """TS `selection: { entries: ArrangementEntry[] }` for buildRenderedBands."""

    entries: Sequence[ArrangementEntry]


def _build_rendered_bands(
    selection: _BandSelection,
    bands: Sequence[_StoredBandRow],
) -> list[CompactRenderedBand]:
    result: list[CompactRenderedBand] = []
    for band in _BAND_ORDER:
        entries = [entry for entry in selection.entries if entry.band == band]
        if len(entries) == 0:
            continue
        stored = next((row for row in bands if row.band == band), None)
        text = (
            stored.rendered_text
            if stored is not None
            else assemble_band_text([entry.text for entry in entries])
        )
        result.append(CompactRenderedBand(band=band, text=text))
    return result


@dataclass(frozen=True, slots=True)
class _WouldWriteSelection:
    """TS `selection: { compactPoint; entries }` for selectionWouldWriteSnapshot."""

    compact_point: int
    entries: Sequence[ArrangementEntry]


# Preview helper for wouldProduceBands: true when compact would write a
# non-empty banded snapshot that differs from the stored view (or is the first
# write). A different compact point in either direction counts as a write —
# including regression, which compact always accepts. Same-point still
# compares arrangement/gaps so repair previews report true when the stored
# snapshot is incomplete.
def _selection_would_write_snapshot(
    transaction: DbReadTransaction,
    selection: _WouldWriteSelection,
) -> bool:
    if selection.compact_point <= 0:
        return False
    stored = read_stored_view(transaction.db)
    if stored is None:
        return True
    if selection.compact_point != stored.compact_point:
        return True

    arrangement = [
        {
            "band": entry.band,
            "subjectKind": entry.subject_kind,
            "subjectId": entry.subject_id,
            "derivationUsed": entry.derivation_used,
            "degraded": entry.degraded,
        }
        for entry in selection.entries
    ]
    gaps = [
        {
            "band": entry.band,
            "subjectId": entry.subject_id,
            "reason": "unknown" if entry.reason is None else entry.reason,
        }
        for entry in selection.entries
        if entry.gap
    ]
    stored_arrangement = [
        {
            "band": entry.band,
            "subjectKind": entry.subject_kind,
            "subjectId": entry.subject_id,
            "derivationUsed": entry.derivation_used,
            "degraded": entry.degraded,
        }
        for entry in stored.arrangement
    ]
    stored_gaps = [
        {
            "band": entry.band,
            "subjectId": entry.subject_id,
            "reason": entry.reason,
        }
        for entry in stored.gaps
    ]
    return _json_compact(arrangement) != _json_compact(stored_arrangement) or _json_compact(
        gaps
    ) != _json_compact(stored_gaps)


# Read-only compact preflight: same selection path as compact, no snapshot write.
# Runs touch-suppressed like getLlmRequestContext so background mode never
# schedules catch-up drain from a preview read.
async def preview_compact(ref: ThreadRef, opts: CompactOpts) -> OpResult[PreviewCompactOutcome]:
    call = _resolve_compact_call(opts)
    if not call.ok:
        return call

    try:

        def _read(transaction: DbReadTransaction) -> PreviewCompactOutcome:
            # Duck-type signal: read `.aborted` via compact_stopped / compute path,
            # never capture a bool (tests may pass a live getter object).
            computed = compute_arrangement(
                transaction.db,
                transaction,
                call.value.merged,
                ComputeArrangementOpts(
                    include_chunk_materials=False,
                    signal=opts.signal,  # type: ignore[arg-type]
                ),
            )
            if not computed.ok:
                return PreviewCompactErr(reason=computed.error.reason)

            selection = computed.value.selection
            tail_tokens = tail_token_sum(transaction.db, selection.compact_point)
            return PreviewCompactOk(
                preview=PreviewCompactResult(
                    compact_point=selection.compact_point,
                    would_produce_bands=_selection_would_write_snapshot(
                        transaction,
                        _WouldWriteSelection(
                            compact_point=selection.compact_point,
                            entries=selection.entries,
                        ),
                    ),
                    tail_tokens=tail_tokens,
                    first_kept_message_id=computed.value.first_kept_message_id,
                )
            )

        return await create_db_read_transaction(ref, _read)
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view previewCompact failed: {_detail(cause)}")


# Compact runs only when invoked through this surface; no core path calls it.
# Assembly is entirely from stored artifacts: nothing here can reach
# inference or schedule repair work.
async def compact(ref: ThreadRef, opts: CompactOpts) -> OpResult[CompactReceipt]:
    resolved = await resolve_thread_ref(ref)
    if not resolved.ok:
        return resolved
    file_path = resolved.value.file_path
    if not os.path.exists(file_path):
        return _thread_not_found(file_path)

    call = _resolve_compact_call(opts)
    if not call.ok:
        return call
    merged = call.value.merged
    profile_name = call.value.profile_name

    opened = open_thread_database(file_path)
    if not opened.ok:
        return opened
    db = opened.value
    try:
        thread_id = read_thread_metadata(db).thread_id
        transaction = DbReadTransaction(db=db, file_path=file_path, thread_id=thread_id)
        computed = compute_arrangement(
            db,
            transaction,
            merged,
            ComputeArrangementOpts(
                include_chunk_materials=True,
                signal=opts.signal,  # type: ignore[arg-type]
            ),
        )
        if not computed.ok:
            return computed

        selection = computed.value.selection
        inputs = computed.value.inputs
        view_id = computed.value.view_id
        first_kept_message_id = computed.value.first_kept_message_id

        warnings: list[CompactWarning] = [
            CompactWarning(
                band=entry.band,
                subject_id=entry.subject_id,
                derivation_type=(
                    "chunk_summary_brief" if entry.band == "brief" else "chunk_summary_detailed"
                ),
                reason="not_ready" if entry.reason is None else entry.reason,
            )
            for entry in selection.entries
            if entry.derivation_used == "stored_member_concat"
        ]
        for warning in warnings:
            write_log(
                transaction,
                LogEntry(
                    level="warning",
                    message="compact chunk fallback used",
                    derivation_type=warning.derivation_type,
                    subject_id=warning.subject_id,
                    reason=warning.reason,
                    floor_used="stored_member_concat",
                ),
            )

        def entries_by_band(band: Band) -> list[ArrangementEntry]:
            return [entry for entry in selection.entries if entry.band == band]

        bands: list[_StoredBandRow] = []
        for band in _BAND_ORDER:
            entries = entries_by_band(band)
            if len(entries) == 0:
                continue
            rendered_text = assemble_band_text([entry.text for entry in entries])
            bands.append(
                _StoredBandRow(
                    band=band,
                    rendered_text=rendered_text,
                    token_count=estimate_tokens(rendered_text),
                )
            )

        created_at = _iso_millis_now()

        fire_view_injection("compact-write")

        # Re-read `.aborted` here (property), never a captured bool — abort
        # hooks flip the flag between fire_view_injection and this check.
        if compact_stopped(opts.signal):  # type: ignore[arg-type]
            return _caller_error("compact_stopped", "compact stopped before snapshot write")

        replace_view_snapshot(
            db,
            ViewReplaceInput(
                view_id=view_id,
                created_at=created_at,
                compact_point=selection.compact_point,
                covered_from=selection.covered_from,
                profile_name=profile_name,
                config_json=_json_compact(
                    {
                        "lowerBound": merged.lower_bound,
                        "percentages": {
                            "full": merged.percentages.full,
                            "smooth": merged.percentages.smooth,
                            "detailed": merged.percentages.detailed,
                            "brief": merged.percentages.brief,
                        },
                    }
                ),
                arrangement_json=_json_compact(
                    [
                        {
                            "band": entry.band,
                            "subjectKind": entry.subject_kind,
                            "subjectId": entry.subject_id,
                            "derivationUsed": entry.derivation_used,
                            "degraded": entry.degraded,
                        }
                        for entry in selection.entries
                    ]
                ),
                gaps_json=_json_compact(
                    [
                        {
                            "band": entry.band,
                            "subjectId": entry.subject_id,
                            "reason": "unknown" if entry.reason is None else entry.reason,
                        }
                        for entry in selection.entries
                        if entry.gap
                    ]
                ),
                source_state_json=_json_compact(
                    {
                        "maxEventOrder": inputs.max_event_order,
                        # Nested SelectionInputs map persisted verbatim (TS runtime).
                        "derivationCounts": inputs.derivation_counts,
                    }
                ),
                bands=[
                    ViewReplaceBand(
                        band=row.band,
                        rendered_text=row.rendered_text,
                        token_count=row.token_count,
                    )
                    for row in bands
                ],
            ),
        )

        band_report: dict[Band, CompactBandStats] = {}
        for band in _BAND_ORDER:
            stored = next((row for row in bands if row.band == band), None)
            band_report[band] = CompactBandStats(
                entries=len(entries_by_band(band)),
                tokens=0 if stored is None else stored.token_count,
            )
        tail_tokens = tail_token_sum(db, selection.compact_point)
        rendered_bands = _build_rendered_bands(_BandSelection(entries=selection.entries), bands)
        return OpOk(
            CompactReceipt(
                view_id=view_id,
                profile=profile_name,
                config=CompactReceiptConfig(
                    full=merged.percentages.full,
                    smooth=merged.percentages.smooth,
                    detailed=merged.percentages.detailed,
                    brief=merged.percentages.brief,
                    lower_bound=merged.lower_bound,
                ),
                bands=band_report,
                tail_tokens=tail_tokens,
                total_tokens=(
                    band_report["brief"].tokens
                    + band_report["detailed"].tokens
                    + band_report["smooth"].tokens
                    + tail_tokens
                ),
                covered_from=selection.covered_from,
                compact_point=selection.compact_point,
                degraded=[
                    CompactDegradedEntry(
                        band=entry.band,
                        subject_id=entry.subject_id,
                        used_derivation=entry.derivation_used,
                    )
                    for entry in selection.entries
                    if entry.degraded
                ],
                gaps=[
                    CompactGapEntry(
                        band=entry.band,
                        subject_id=entry.subject_id,
                        reason="unknown" if entry.reason is None else entry.reason,
                    )
                    for entry in selection.entries
                    if entry.gap
                ],
                warnings=warnings,
                rendered_bands=rendered_bands,
                first_kept_message_id=first_kept_message_id,
            )
        )
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view compact failed: {_detail(cause)}")
    finally:
        db.close()


# ── materialize ──────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MaterializeOpts:
    """TS `{ path: string; format?: "pi-session" }`."""

    path: str
    format: Literal["pi-session"] | None = None


# PI session-file materialization: run the serving assembly internally, hand
# the same entry array to the JSONL writer, return the written path. No
# thread state changes (reads + a file write outside the thread file), and
# every generated field derives from view/record metadata, never write-time
# clocks — repeating after no thread changes produces a byte-identical file.
# Canonical result type lives with the writer (TS returns writePiSessionFile's
# `{ writtenPath }` directly).
async def materialize(ref: ThreadRef, opts: MaterializeOpts) -> OpResult[MaterializeResult]:
    format_name = "pi-session" if opts.format is None else opts.format
    if format_name != "pi-session":
        return OpErr(
            error=ErrorResult(
                error_class="caller_error",
                code="unknown_format",
                reason=(
                    f'unknown materialize format "{format_name}"; '
                    'accepted formats are "pi-session"'
                ),
            )
        )

    try:

        def _read(transaction: DbReadTransaction) -> MaterializeInput:
            assembled = assemble_view(transaction.db)
            thread_meta = read_thread_metadata(transaction.db)
            return MaterializeInput(
                thread_id=thread_meta.thread_id,
                header_timestamp=(
                    assembled.snapshot.created_at
                    if assembled.snapshot is not None
                    else thread_meta.created_at
                ),
                # Deterministic per thread file — never the writing process's cwd.
                cwd=str(Path(transaction.file_path).resolve().parent),
                entries=[
                    MaterializeEntry(
                        message=entry.message,
                        entry_id=entry.entry_id,
                        timestamp=entry.timestamp,
                    )
                    for entry in assembled.entries
                ],
            )

        read = await create_db_read_transaction(ref, _read)
        if not read.ok:
            return read
        input_data = read.value
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view materialize failed: {_detail(cause)}")

    try:
        return OpOk(write_pi_session_file(input_data, opts.path))
    except Exception as cause:
        if isinstance(cause, NotImplementedError):
            raise
        return storage_failure(f"view materialize could not write {opts.path}: {_detail(cause)}")


# ── initLhc substrate ────────────────────────────────────────────
# Re-exported from internal/profiles (TS re-exports).

__all__ = [
    "BUILT_IN_PROFILES",
    "CompactAbortSignal",
    "CompactOpts",
    "DEFAULT_COMPACT_THRESHOLD",
    "DEFAULT_VISIBILITY",
    "MaterializeOpts",
    "MaterializeResult",
    "PruneParams",
    "compact",
    "describe",
    "get_llm_request_context",
    "get_session_thread_view",
    "materialize",
    "preview_compact",
    "prune",
    "resolve_view_config",
    "status",
]
