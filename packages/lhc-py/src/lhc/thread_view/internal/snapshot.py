"""Ported from packages/lhc/src/thread-view/internal/snapshot.ts. Phase 1 skeleton.

Stored view snapshot reads and the one atomic compact writer. This module
reads the snapshot header and bands, the live tail messages after the compact
point, and the tail token sum. Direct record/derivation reads are contained
to thread-view internals; status derivation counting still goes through the
owners' report surfaces in index.ts.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...shared_tech.derivation import RenderingPartKind
from ...shared_tech.storage import Database
from ...shared_tech.view import Band, StoredView

# ── view snapshot (header + bands) ────────────────────────────────


@dataclass(frozen=True, slots=True)
class ViewSnapshotBand:
    band: Band
    rendered_text: str
    token_count: int


@dataclass(frozen=True, slots=True)
class ViewSnapshot:
    view_id: str
    created_at: str
    compact_point: int
    covered_from: int
    gap_count: int
    degraded_count: int
    # Non-empty bands in gradient order (brief → detailed → smooth), the order
    # the serving assembly prepends them in.
    bands: list[ViewSnapshotBand]


@dataclass(frozen=True, slots=True)
class _RawViewRow:
    view_id: str
    created_at: str
    compact_point: int
    covered_from: int
    arrangement_json: str
    gaps_json: str


_BAND_GRADIENT_ORDER: tuple[Band, ...] = ("brief", "detailed", "smooth")

_SQL_READ_VIEW_SNAPSHOT = (
    """SELECT view_id, created_at, compact_point, covered_from, arrangement_json, gaps_json
       FROM thread_view WHERE singleton = 1"""
)

_SQL_READ_VIEW_BANDS = """SELECT band, rendered_text, token_count FROM thread_view_band WHERE view_id = ?"""

_SQL_READ_STORED_VIEW = (
    """SELECT view_id, created_at, compact_point, covered_from, profile_name,
              config_json, arrangement_json, gaps_json, source_state_json
       FROM thread_view WHERE singleton = 1"""
)

_SQL_READ_STORED_VIEW_BANDS = """SELECT band, token_count FROM thread_view_band WHERE view_id = ?"""

_SQL_READ_TAIL_MESSAGES = (
    """SELECT m.message_id, m.source_event_order, m.kind, e.recorded_at, e.idempotency_key FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order"""
)

_SQL_READ_TAIL_BLOCKS = (
    """SELECT mb.message_id, mb.block_type, mb.content
       FROM message_block mb JOIN message m ON m.message_id = mb.message_id
       WHERE m.deleted_at IS NULL AND m.source_event_order > ?
       ORDER BY m.source_event_order, mb.block_index"""
)

_SQL_READ_THREAD_METADATA = """SELECT thread_id, created_at FROM thread_metadata WHERE id = 1"""

_SQL_TAIL_TOKEN_SUM = (
    """SELECT COALESCE(SUM(token_estimate), 0) AS total FROM message
       WHERE deleted_at IS NULL AND source_event_order > ?"""
)

_SQL_DELETE_THREAD_VIEW = """DELETE FROM thread_view WHERE singleton = 1"""

_SQL_INSERT_THREAD_VIEW = (
    """INSERT INTO thread_view (singleton, view_id, created_at, compact_point, covered_from,
         profile_name, config_json, arrangement_json, gaps_json, source_state_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
)

_SQL_INSERT_THREAD_VIEW_BAND = (
    """INSERT INTO thread_view_band (view_id, band, rendered_text, token_count)
       VALUES (?, ?, ?, ?)"""
)

_SQL_RESET_BOUNDARY = """UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1"""


# null means no view exists (never compacted): the whole record renders as tail
# from event 1 through the same serving assembly path, snapshot-absent rather
# than a separate branch.
def read_view_snapshot(db: Database) -> ViewSnapshot | None:
    raise NotImplementedError


# The full stored row for `describe`: everything compact wrote, parsed
# verbatim. Arrangement, gaps, config, source-state provenance, and per-band
# stored token counts are read from the snapshot, never recomputed.
def read_stored_view(db: Database) -> StoredView | None:
    raise NotImplementedError


# ── tail record reads ─────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TailMessageBlock:
    block_type: str
    content: dict[str, object]


@dataclass(frozen=True, slots=True)
class TailMessageRow:
    message_id: str
    source_event_order: int
    idempotency_key: str | None
    kind: RenderingPartKind
    # The source event's recorded_at: materialize's entry timestamp. Generated
    # fields derive from record times, never write-time clocks.
    recorded_at: str
    blocks: list[TailMessageBlock]


# Live messages after the compact point in record order, with their projected
# blocks. The deleted-read filter is applied here so a deleted message never
# reaches rendering.
def read_tail_messages(db: Database, compact_point: int) -> list[TailMessageRow]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class ThreadMetadata:
    thread_id: str
    created_at: str


# The thread's identity row: materialize's header source. The header id derives
# from thread id + view created-at; a never-compacted thread's header uses the
# thread's created-at.
def read_thread_metadata(db: Database) -> ThreadMetadata:
    raise NotImplementedError


# The tail's token sum for status: every live message after the compact point,
# all kinds. This is the same population the serving assembly renders as tail.
def tail_token_sum(db: Database, compact_point: int) -> int:
    raise NotImplementedError


# ── the atomic replace ───────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ViewReplaceBand:
    band: Band
    rendered_text: str
    token_count: int


@dataclass(frozen=True, slots=True)
class ViewReplaceInput:
    view_id: str
    created_at: str
    compact_point: int
    covered_from: int
    profile_name: str | None
    config_json: str
    arrangement_json: str
    gaps_json: str
    source_state_json: str
    bands: list[ViewReplaceBand]


# Compact's one transaction: delete the singleton view row (the FK cascade
# drops its bands), insert the new header and bands, and reset the boundary
# to the compact point. All inside one BEGIN IMMEDIATE, so a crash anywhere
# rolls the whole replace back and the previous view keeps serving. Compact is
# the writer of view rows and the boundary reset on compact.
def replace_view_snapshot(db: Database, input: ViewReplaceInput) -> None:
    raise NotImplementedError
