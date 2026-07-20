"""Ported from packages/lhc/src/thread-view/internal/assemble.ts. Phase 1 skeleton.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...shared_tech.storage import Database
from .render import AssembledContextMessage
from .snapshot import ViewSnapshot


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
    raise NotImplementedError
