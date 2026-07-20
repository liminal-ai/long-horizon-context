"""Ported from packages/lhc/src/thread-view/index.ts. Phase 1 skeleton.

thread-view surface: model context, status, compact, materialize, and
describe. Hot-path reads use local deterministic assembly only: no inference,
no network, no queue interaction, and no writes. Profile resolution consumed
by initLhc is re-exported at the bottom.

Wave 6 owns the full thread-view surface. Wave 4/5 forward stubs
(CompactAbortSignal, CompactOpts, status, compact, get_llm_request_context)
are extended — not reshaped.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from ..messages import report as messages_report
from ..shared_tech.context import resolve_instance_view_config
from ..shared_tech.derivation import DerivationReportEntry
from ..shared_tech.errors import OpErr, OpResult
from ..shared_tech.persist import DbReadTransaction, DbWriteTransaction
from ..shared_tech.storage import Database
from ..shared_tech.view import (
    Band,
    CompactReceipt,
    CompactRenderedBand,
    LlmRequestContext,
    PreviewCompactOutcome,
    PruneReceipt,
    ResolvedViewConfig,
    SessionThreadView,
    StoredView,
    ViewCompactParams,
    ViewProfile,
    ViewStatus,
    ViewStatusDerivation,
)
from ..threads import ThreadRef, open_thread_database, resolve_thread_ref
from ..turns import report as turns_report
from .internal.assemble import assemble_view
from .internal.boundary import read_boundary_position, visibility_zone_tokens
from .internal.compact_compute import ComputeArrangementOpts, compact_stopped, compute_arrangement
from .internal.materialize import MaterializeResult, write_pi_session_file
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
    read_stored_view,
    read_thread_metadata,
    read_view_snapshot,
    replace_view_snapshot,
    tail_token_sum,
)

# Closed over by Phase 2 bodies; named for TS import fidelity.
_ = (
    messages_report,
    turns_report,
    resolve_instance_view_config,
    assemble_view,
    read_boundary_position,
    visibility_zone_tokens,
    compact_stopped,
    compute_arrangement,
    ComputeArrangementOpts,
    write_pi_session_file,
    profile_violation,
    assemble_band_text,
    fire_view_injection,
    build_session_thread_view,
    read_stored_view,
    read_thread_metadata,
    read_view_snapshot,
    replace_view_snapshot,
    tail_token_sum,
    open_thread_database,
    resolve_thread_ref,
)

# Config resolution for the operation in hand: the SDK instance's resolved
# view config rides the per-instance seam; below-SDK direct domain calls fall
# back to the built-in defaults through the same one resolution path initLhc
# uses.
# NOTE (Phase 2): TS assigns `resolveViewConfig()` at module load. Constructed
# here from the same real constants so import does not call the skeleton.
_DEFAULT_VIEW_CONFIG: ResolvedViewConfig = ResolvedViewConfig(
    profiles={profile.name: profile for profile in BUILT_IN_PROFILES},
    visibility=DEFAULT_VISIBILITY,
    compact_threshold=DEFAULT_COMPACT_THRESHOLD,
)


def _view_config() -> ResolvedViewConfig:
    raise NotImplementedError


def _thread_not_found(file_path: str) -> OpErr:
    raise NotImplementedError


def _detail(cause: object) -> str:
    raise NotImplementedError


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
    raise NotImplementedError


# SessionManager-friendly materialization from canonical record data: compacted
# bands as user context lines, tail messages regrouped into user / assistant /
# toolResult shapes. Reads-only, touch-suppressed like getLlmRequestContext.
async def get_session_thread_view(ref: ThreadRef) -> OpResult[SessionThreadView]:
    raise NotImplementedError


# ── status ───────────────────────────────────────────────────────


# Derivation counts bucket from one report entry. Ready derivations are healthy
# and not an operational situation.
def _bucket_derivation(entries: Sequence[DerivationReportEntry], counts: ViewStatusDerivation) -> None:
    raise NotImplementedError


# Reads only, callable any time, no side effects: tail size against the
# configured trigger threshold with a compact recommendation, derivation
# counts by state, the active view's health or null pre-compact, and the
# visibility zone's sum against its max.
async def status(ref: ThreadRef) -> OpResult[ViewStatus]:
    raise NotImplementedError


# ── describe ─────────────────────────────────────────────────────


# The stored active view row, exposed read-only so inspect never reads
# thread-view tables directly. Everything is the snapshot verbatim:
# arrangement, gaps, config, source-state provenance, per-band stored token
# counts; nothing is recomputed, repaired, or read from the record. Absent
# view means ok with null, mirroring status's never-compacted behavior. Like the
# other reads, the whole operation runs touch-suppressed: a background SDK's
# describe can never schedule a catch-up drain.
async def describe(ref: ThreadRef) -> OpResult[StoredView | None]:
    raise NotImplementedError


# ── prune ────────────────────────────────────────────────────────


def _prune_caller_error(code: Literal["invalid_target_tokens"], reason: str) -> OpErr:
    raise NotImplementedError


def _validate_prune_target(target_tokens: int | float | None) -> OpResult[int]:
    raise NotImplementedError


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
    raise NotImplementedError


def _tokens_behind_boundary(db: Database, boundary: int, compact_point: int) -> int:
    raise NotImplementedError


def _count_pruned_tool_results(
    db: Database,
    previous_boundary: int,
    new_boundary: int,
    compact_point: int,
) -> int:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _BuildPruneReceiptInput:
    previous_boundary: int
    new_boundary: int
    compact_point: int
    target_tokens: int
    zone_tokens_before: int
    no_op: bool


def _build_prune_receipt(db: Database, input: _BuildPruneReceiptInput) -> PruneReceipt:
    raise NotImplementedError


def _compute_prune_boundary(
    rows: Sequence[_ToolResultZoneRow],
    target_tokens: int,
    previous_boundary: int,
) -> int:
    raise NotImplementedError


def _prune_in_transaction(transaction: DbWriteTransaction, target_tokens: int) -> PruneReceipt:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class PruneParams:
    """TS `params?: { targetTokens?: number }` — input is JS number (int|float)."""

    target_tokens: int | float | None = None


# Advance the visibility boundary forward so older tool results in the
# visibility zone render short. Deterministic, no inference, one write
# transaction. Explicit commands always execute and report — a zone already
# under target returns a no-op receipt, never an error.
async def prune(ref: ThreadRef, params: PruneParams | None = None) -> OpResult[PruneReceipt]:
    raise NotImplementedError


# ── compact ──────────────────────────────────────────────────────

# The default base when no profile is named: the first built-in, matching
# the PI continuation harness. Explicit params override the base field-wise.
_DEFAULT_PROFILE_NAME = "continuation"

_CallerErrorCode = Literal["unknown_profile", "invalid_view_config", "compact_stopped"]


def _caller_error(code: _CallerErrorCode, reason: str) -> OpErr:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _ResolvedCompactCall:
    merged: ViewProfile
    profile_name: str | None


def _resolve_compact_call(opts: CompactOpts) -> OpResult[_ResolvedCompactCall]:
    raise NotImplementedError


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
    raise NotImplementedError


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
    raise NotImplementedError


# Read-only compact preflight: same selection path as compact, no snapshot write.
# Runs touch-suppressed like getLlmRequestContext so background mode never
# schedules catch-up drain from a preview read.
async def preview_compact(ref: ThreadRef, opts: CompactOpts) -> OpResult[PreviewCompactOutcome]:
    raise NotImplementedError


# Compact runs only when invoked through this surface; no core path calls it.
# Assembly is entirely from stored artifacts: nothing here can reach
# inference or schedule repair work.
async def compact(ref: ThreadRef, opts: CompactOpts) -> OpResult[CompactReceipt]:
    raise NotImplementedError


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
    raise NotImplementedError


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
