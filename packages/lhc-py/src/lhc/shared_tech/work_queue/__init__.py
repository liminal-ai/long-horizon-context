"""Ported from packages/lhc/src/shared-tech/work-queue/index.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Wave 1 tests need count_live_items / DrainReport / WorkKind. Full work-queue
surface lands in Wave 2; extend this module — do not reshape these exports.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict, Union

from ..derivation import SubjectKind, WorkHandler
from ..storage import Database

WorkOwner = Literal["messages", "turns"]

WorkKind = Literal[
    "prompt_smoothing",
    "tool_result_summary",
    "turn_derivation",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
]


class WorkSourceRefMessage(TypedDict):
    messageId: str


class WorkSourceRefTurn(TypedDict):
    turnId: str


class WorkSourceRefChunk(TypedDict):
    chunkId: str


WorkSourceRef = Union[WorkSourceRefMessage, WorkSourceRefTurn, WorkSourceRefChunk]


@dataclass(frozen=True, slots=True)
class EnqueueDerivationTarget:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str

WorkHandlerMap = dict[WorkKind, WorkHandler]


@dataclass(frozen=True, slots=True)
class DrainRanEntry:
    work_item_id: str
    kind: WorkKind
    source_ref: WorkSourceRef
    disposition: Literal["done", "failed_terminal", "stale_discarded", "lost_lease"]
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class DrainReport:
    ran: list[DrainRanEntry]
    stopped_because: Literal["empty", "in_flight", "max_items"]
    remaining: int
    claim_expires_at: str | None = None


def count_live_items(db: Database) -> int:
    raise NotImplementedError
