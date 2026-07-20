"""Ported from packages/lhc/src/thread-view/internal/session-view.ts. Phase 1 skeleton.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ...shared_tech.storage import Database
from ...shared_tech.view import (
    Band,
    SessionAssistantPart,
    SessionThreadView,
    SessionThreadViewEntry,
    SessionThreadViewEntrySource,
)
from .render import TailRenderContext
from .snapshot import TailMessageRow


def _block_content(message: TailMessageRow) -> dict[str, object]:
    raise NotImplementedError


def _text_of(message: TailMessageRow) -> str:
    raise NotImplementedError


def _entry_source(message: TailMessageRow) -> SessionThreadViewEntrySource:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _ParsedModelRef:
    provider: str
    model_id: str


def _parse_model_ref(model: str) -> _ParsedModelRef | None:
    raise NotImplementedError


def _band_user_message(band: Band, rendered_text: str) -> SessionThreadViewEntry:
    raise NotImplementedError


def _assistant_part_of(message: TailMessageRow) -> SessionAssistantPart:
    raise NotImplementedError


def _tool_result_of(message: TailMessageRow, ctx: TailRenderContext) -> SessionThreadViewEntry:
    raise NotImplementedError


def _model_change_of(message: TailMessageRow) -> SessionThreadViewEntry | None:
    raise NotImplementedError


def _thinking_level_change_of(message: TailMessageRow) -> SessionThreadViewEntry:
    raise NotImplementedError


def _tail_entries_of(rows: Sequence[TailMessageRow], boundary_position: int) -> list[SessionThreadViewEntry]:
    raise NotImplementedError


def build_session_thread_view(db: Database) -> SessionThreadView:
    raise NotImplementedError
