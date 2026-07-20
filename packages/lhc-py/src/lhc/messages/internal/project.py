"""Ported from packages/lhc/src/messages/internal/project.ts. Phase 1 skeleton.

Event to message + typed blocks. Verbatim means payload fields are copied
into block content untouched: nothing here trims, normalizes, splits, or
summarizes.
"""

from __future__ import annotations

from dataclasses import dataclass
# Runtime import (not TYPE_CHECKING): Phase 2 bodies construct these records.
# Safe because the parent __init__ defines them BEFORE importing this module
# (see the IMPORT-ORDER CONSTRAINT note there).
from .. import Block, RecordedEvent


@dataclass(frozen=True, slots=True)
class ProjectedMessage:
    blocks: list[Block]
    token_estimate: int


# turn_end is recorded in the event order but produces no message.
def project_event(event: RecordedEvent) -> ProjectedMessage | None:
    raise NotImplementedError
