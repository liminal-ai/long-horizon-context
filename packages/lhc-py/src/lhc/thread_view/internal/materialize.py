"""Ported from packages/lhc/src/thread-view/internal/materialize.ts. Phase 1 skeleton.

PI session JSONL writer: the pure mapping from assembled entries to the
pinned PI session file format, plus the file write. This module never sees a
database handle; it renders what the serving assembly hands it, keeping
materialize/model-context parity structural.

Format pin from repo-ref/pi/packages/coding-agent/src/core/session-manager.ts:
JSONL. Line 1 is the header `{ type: "session", version, id, timestamp,
cwd }`; each subsequent line is `{ type: "message", id, parentId, timestamp,
message: { role, content } }` with parentId chaining each entry to the
previous. Content is encoded as PI text blocks: user content may be a bare
string in PI, but assistant content must be a block array, so both roles use
the one block encoding.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .render import AssembledContextMessage

# CURRENT_SESSION_VERSION at the pin (PI coding agent 0.79.1) — see
# test/fixtures/pi-session-structure.provenance.md.
PI_SESSION_VERSION = 3


# One assembled entry with the metadata the file's generated fields derive from:
# the entry id (message id for tail entries, viewId-band for band entries)
# and the record-time timestamp (event recorded_at for tail entries, view
# created-at for band entries). Never a write-time clock anywhere.
@dataclass(frozen=True, slots=True)
class MaterializeEntry:
    message: AssembledContextMessage
    entry_id: str
    timestamp: str


@dataclass(frozen=True, slots=True)
class MaterializeInput:
    thread_id: str
    # The view's created-at, or the thread's created-at when never compacted
    # (viewId null; the tail-only file still carries a valid header).
    header_timestamp: str
    cwd: str
    entries: Sequence[MaterializeEntry]


@dataclass(frozen=True, slots=True)
class MaterializeResult:
    """TS writePiSessionFile return `{ writtenPath: string }` — also materialize's value."""

    written_path: str


def render_pi_session_lines(input: MaterializeInput) -> list[str]:
    raise NotImplementedError


def write_pi_session_file(input: MaterializeInput, path: str) -> MaterializeResult:
    raise NotImplementedError
