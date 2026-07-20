"""Ported from packages/lhc/src/messages/internal/project.ts. Phase 1 skeleton.

Event to message + typed blocks. Verbatim means payload fields are copied
into block content untouched: nothing here trims, normalizes, splits, or
summarizes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .. import Block, RecordedEvent


@dataclass(frozen=True, slots=True)
class ProjectedMessage:
    blocks: list[Block]
    token_estimate: int


# turn_end is recorded in the event order but produces no message.
def project_event(event: RecordedEvent) -> ProjectedMessage | None:
    raise NotImplementedError
