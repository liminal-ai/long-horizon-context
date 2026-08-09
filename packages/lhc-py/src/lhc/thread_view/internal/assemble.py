"""Ported from packages/lhc/src/thread-view/internal/assemble.ts.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...shared_tech.storage import Database
from .boundary import read_boundary_position
from .render import (
    AssembledContextMessage,
    TailRenderContext,
    has_thinking_text,
    is_empty_thinking_husk,
    render_band_message,
    render_tail_message,
    tool_names_by_call_id,
)
from .snapshot import ViewSnapshot, read_tail_messages, read_view_snapshot


@dataclass(frozen=True, slots=True)
class AssembledViewEntry:
    message: AssembledContextMessage
    entry_id: str
    timestamp: str


@dataclass(frozen=True, slots=True)
class AssembledView:
    entries: list[AssembledViewEntry]
    snapshot: ViewSnapshot | None


def assemble_view(db: Database) -> AssembledView:
    snapshot = read_view_snapshot(db)
    compact_point = 0 if snapshot is None else snapshot.compact_point
    boundary_position = read_boundary_position(db)
    tail_rows = read_tail_messages(db, compact_point)
    render_ctx = TailRenderContext(
        boundary_position=boundary_position,
        tool_name_by_call_id=tool_names_by_call_id(tail_rows),
    )

    entries: list[AssembledViewEntry] = []
    if snapshot is not None:
        for band in snapshot.bands:
            entries.append(
                AssembledViewEntry(
                    message=render_band_message(band.band, band.rendered_text),
                    entry_id=f"{snapshot.view_id}-{band.band}",
                    timestamp=snapshot.created_at,
                )
            )
    for row in tail_rows:
        # Skip true husks always; skip signature-only thinking here because the
        # text LLM path cannot carry the opaque token (session-view still serves it).
        if is_empty_thinking_husk(row):
            continue
        if row.kind == "assistant_thinking" and not has_thinking_text(row):
            continue
        entries.append(
            AssembledViewEntry(
                message=render_tail_message(row, render_ctx),
                entry_id=row.message_id,
                timestamp=row.recorded_at,
            )
        )

    return AssembledView(
        entries=entries,
        snapshot=snapshot,
    )
