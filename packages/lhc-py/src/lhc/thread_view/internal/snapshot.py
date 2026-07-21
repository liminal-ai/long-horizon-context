"""Ported from packages/lhc/src/thread-view/internal/snapshot.ts. Phase 1 skeleton.

Stored view snapshot reads and the one atomic compact writer. This module
reads the snapshot header and bands, the live tail messages after the compact
point, and the tail token sum. Direct record/derivation reads are contained
to thread-view internals; status derivation counting still goes through the
owners' report surfaces in index.ts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, cast

from ...shared_tech.derivation import RenderingPartKind
from ...shared_tech.storage import Database
from ...shared_tech.view import (
    Band,
    StoredView,
    StoredViewArrangementEntry,
    StoredViewBand,
    StoredViewConfig,
    StoredViewGap,
    StoredViewSourceState,
)

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


def _parse_stored_config(raw: object) -> StoredViewConfig:
    assert isinstance(raw, dict)
    percentages_raw = raw["percentages"]
    assert isinstance(percentages_raw, dict)
    # Verbatim JSON numbers (TS `number`) — never int()-truncate floats.
    return StoredViewConfig(
        lower_bound=raw["lowerBound"],  # type: ignore[arg-type]
        percentages={str(k): v for k, v in percentages_raw.items()},  # type: ignore[misc]
    )


def _parse_stored_arrangement(raw: object) -> list[StoredViewArrangementEntry]:
    assert isinstance(raw, list)
    entries: list[StoredViewArrangementEntry] = []
    for entry in raw:
        assert isinstance(entry, dict)
        entries.append(
            StoredViewArrangementEntry(
                band=cast(Band, str(entry["band"])),
                subject_kind=cast(Literal["chunk", "turn"], str(entry["subjectKind"])),
                subject_id=str(entry["subjectId"]),
                derivation_used=str(entry["derivationUsed"]),
                degraded=entry["degraded"] is True,
            )
        )
    return entries


def _parse_stored_gaps(raw: object) -> list[StoredViewGap]:
    assert isinstance(raw, list)
    gaps: list[StoredViewGap] = []
    for entry in raw:
        assert isinstance(entry, dict)
        gaps.append(
            StoredViewGap(
                band=cast(Band, str(entry["band"])),
                subject_id=str(entry["subjectId"]),
                reason=str(entry["reason"]),
            )
        )
    return gaps


def _parse_stored_source_state(raw: object) -> StoredViewSourceState:
    assert isinstance(raw, dict)
    counts_raw = raw["derivationCounts"]
    assert isinstance(counts_raw, dict)
    # Nested type → state → count, persisted verbatim from SelectionInputs.
    derivation_counts: dict[str, dict[str, int]] = {}
    for key, value in counts_raw.items():
        assert isinstance(value, dict)
        derivation_counts[str(key)] = {str(sk): int(sv) for sk, sv in value.items()}
    return StoredViewSourceState(
        max_event_order=int(raw["maxEventOrder"]),
        derivation_counts=derivation_counts,
    )


# null means no view exists (never compacted): the whole record renders as tail
# from event 1 through the same serving assembly path, snapshot-absent rather
# than a separate branch.
def read_view_snapshot(db: Database) -> ViewSnapshot | None:
    header = db.prepare(_SQL_READ_VIEW_SNAPSHOT).get()
    if header is None:
        return None

    arrangement = json.loads(str(header["arrangement_json"]))
    gaps = json.loads(str(header["gaps_json"]))
    assert isinstance(arrangement, list)
    assert isinstance(gaps, list)

    band_rows = db.prepare(_SQL_READ_VIEW_BANDS).all(header["view_id"])
    by_band = {str(row["band"]): row for row in band_rows}

    bands: list[ViewSnapshotBand] = []
    for band in _BAND_GRADIENT_ORDER:
        row = by_band.get(band)
        if row is None:
            continue
        bands.append(
            ViewSnapshotBand(
                band=band,
                rendered_text=str(row["rendered_text"]),
                token_count=int(row["token_count"]),
            )
        )

    degraded_count = sum(
        1 for entry in arrangement if isinstance(entry, dict) and entry.get("degraded") is True
    )

    return ViewSnapshot(
        view_id=str(header["view_id"]),
        created_at=str(header["created_at"]),
        compact_point=int(header["compact_point"]),
        covered_from=int(header["covered_from"]),
        gap_count=len(gaps),
        degraded_count=degraded_count,
        bands=bands,
    )


# The full stored row for `describe`: everything compact wrote, parsed
# verbatim. Arrangement, gaps, config, source-state provenance, and per-band
# stored token counts are read from the snapshot, never recomputed.
def read_stored_view(db: Database) -> StoredView | None:
    header = db.prepare(_SQL_READ_STORED_VIEW).get()
    if header is None:
        return None

    band_rows = db.prepare(_SQL_READ_STORED_VIEW_BANDS).all(header["view_id"])
    by_band = {str(row["band"]): row for row in band_rows}

    bands: list[StoredViewBand] = []
    for band in _BAND_GRADIENT_ORDER:
        row = by_band.get(band)
        if row is None:
            continue
        bands.append(StoredViewBand(band=band, stored_tokens=int(row["token_count"])))

    profile_name_raw = header["profile_name"]
    return StoredView(
        view_id=str(header["view_id"]),
        created_at=str(header["created_at"]),
        compact_point=int(header["compact_point"]),
        covered_from=int(header["covered_from"]),
        profile_name=None if profile_name_raw is None else str(profile_name_raw),
        config=_parse_stored_config(json.loads(str(header["config_json"]))),
        arrangement=_parse_stored_arrangement(json.loads(str(header["arrangement_json"]))),
        gaps=_parse_stored_gaps(json.loads(str(header["gaps_json"]))),
        source_state=_parse_stored_source_state(json.loads(str(header["source_state_json"]))),
        bands=bands,
    )


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
    message_rows = db.prepare(_SQL_READ_TAIL_MESSAGES).all(compact_point)
    block_rows = db.prepare(_SQL_READ_TAIL_BLOCKS).all(compact_point)
    blocks_by_message: dict[str, list[TailMessageBlock]] = {}
    for row in block_rows:
        message_id = str(row["message_id"])
        parsed = json.loads(str(row["content"]))
        assert isinstance(parsed, dict)
        blocks = blocks_by_message.get(message_id)
        if blocks is None:
            blocks = []
            blocks_by_message[message_id] = blocks
        blocks.append(
            TailMessageBlock(
                block_type=str(row["block_type"]),
                content=parsed,
            )
        )

    result: list[TailMessageRow] = []
    for row in message_rows:
        message_id = str(row["message_id"])
        idempotency_key_raw = row["idempotency_key"]
        result.append(
            TailMessageRow(
                message_id=message_id,
                source_event_order=int(row["source_event_order"]),
                idempotency_key=(
                    None if idempotency_key_raw is None else str(idempotency_key_raw)
                ),
                kind=cast(RenderingPartKind, str(row["kind"])),
                recorded_at=str(row["recorded_at"]),
                blocks=blocks_by_message.get(message_id, []),
            )
        )
    return result


@dataclass(frozen=True, slots=True)
class ThreadMetadata:
    thread_id: str
    created_at: str


# The thread's identity row: materialize's header source. The header id derives
# from thread id + view created-at; a never-compacted thread's header uses the
# thread's created-at.
def read_thread_metadata(db: Database) -> ThreadMetadata:
    row = db.prepare(_SQL_READ_THREAD_METADATA).get()
    if row is None:
        raise RuntimeError("thread_metadata singleton row missing (creation writes it)")
    return ThreadMetadata(
        thread_id=str(row["thread_id"]),
        created_at=str(row["created_at"]),
    )


# The tail's token sum for status: every live message after the compact point,
# all kinds. This is the same population the serving assembly renders as tail.
def tail_token_sum(db: Database, compact_point: int) -> int:
    row = db.prepare(_SQL_TAIL_TOKEN_SUM).get(compact_point)
    assert row is not None
    return int(row["total"])


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
    db.exec("BEGIN IMMEDIATE;")
    try:
        db.prepare(_SQL_DELETE_THREAD_VIEW).run()
        db.prepare(_SQL_INSERT_THREAD_VIEW).run(
            input.view_id,
            input.created_at,
            input.compact_point,
            input.covered_from,
            input.profile_name,
            input.config_json,
            input.arrangement_json,
            input.gaps_json,
            input.source_state_json,
        )
        insert_band = db.prepare(_SQL_INSERT_THREAD_VIEW_BAND)
        for band in input.bands:
            insert_band.run(
                input.view_id,
                band.band,
                band.rendered_text,
                band.token_count,
            )
        db.prepare(_SQL_RESET_BOUNDARY).run(input.compact_point, input.created_at)
        db.exec("COMMIT;")
    except BaseException:
        db.exec("ROLLBACK;")
        raise
