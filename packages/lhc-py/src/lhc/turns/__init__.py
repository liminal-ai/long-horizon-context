"""Ported from packages/lhc/src/turns/index.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Wave 1 tests import turns.list_turns. Full turns surface lands in Wave 5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..shared_tech.errors import OpResult
from ..threads import ThreadRef


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn_id: str
    status: Literal["open", "closed"]
    member_message_ids: list[str]


async def list_turns(thread_ref: ThreadRef) -> OpResult[list[TurnRecord]]:
    raise NotImplementedError
