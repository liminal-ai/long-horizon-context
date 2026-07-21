"""Ported from packages/lhc/src/thread-view/internal/boundary.ts. Phase 1 skeleton.

Visibility boundary. The boundary is a source event order shared with the
compact point's coordinate system; tool results at-or-behind it render short.
Compact resets it inside compact's own transaction.
"""

from __future__ import annotations

from ...shared_tech.storage import Database

# The singleton row is seeded at thread creation (position 0, everything full).
# A missing row is a damaged thread file, surfaced as a throw for the
# operation boundary's storage_failure wrap.
_SQL_READ_BOUNDARY_POSITION = """SELECT position FROM view_boundary WHERE thread_singleton = 1"""

_SQL_VISIBILITY_ZONE_TOKENS = (
    """SELECT COALESCE(SUM(token_estimate), 0) AS zone FROM message
       WHERE kind = 'tool_result' AND deleted_at IS NULL
         AND source_event_order > ? AND source_event_order > ?"""
)


def read_boundary_position(db: Database) -> int:
    row = db.prepare(_SQL_READ_BOUNDARY_POSITION).get()
    if row is None:
        raise RuntimeError(
            "view_boundary singleton row missing (thread creation seeds it)"
        )
    return int(row["position"])


# The visibility zone's token sum: live (deleted-filtered) tool results ahead
# of both the boundary position and the compact point, one indexed query.
def visibility_zone_tokens(db: Database, position: int, compact_point: int) -> int:
    row = db.prepare(_SQL_VISIBILITY_ZONE_TOKENS).get(position, compact_point)
    # COALESCE always yields a row under node:sqlite / our adapter.
    return int(row["zone"]) if row is not None else 0
