"""Ported from packages/lhc/src/turns/index.ts. Phase 1 — PARTIAL (Wave 1/2 import seam).

Wave 1 tests import turns.list_turns. Wave 2 adds the derive_turn /
derive_brief_chunk / derive_detailed_chunk import seam (work-execution.test.ts
calls sdk.turns.deriveTurn / deriveBriefChunk). Full turns surface lands in
Wave 5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union

from ..shared_tech.errors import ErrorResult, OpResult
from ..threads import ThreadRef


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn_id: str
    status: Literal["open", "closed"]
    member_message_ids: list[str]


async def list_turns(thread_ref: ThreadRef) -> OpResult[list[TurnRecord]]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class TurnDerived:
    turn_id: str
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class TurnDeriveFailed:
    turn_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


TurnDeriveResult = Union[TurnDerived, TurnDeriveFailed]


@dataclass(frozen=True, slots=True)
class ChunkDerived:
    chunk_id: str
    derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"]
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class ChunkDeriveFailed:
    chunk_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


ChunkDeriveResult = Union[ChunkDerived, ChunkDeriveFailed]


# Turn-owned synchronous derivation (Wave 5 completes the body): assembles
# turn_rendering + pre_detailed_assembly, then detailed_turn_compression.
async def derive_turn(thread_ref: ThreadRef, turn_id: str) -> OpResult[TurnDeriveResult]:
    raise NotImplementedError


async def derive_detailed_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError


async def derive_brief_chunk(thread_ref: ThreadRef, chunk_id: str) -> OpResult[ChunkDeriveResult]:
    raise NotImplementedError
