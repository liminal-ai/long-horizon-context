"""Ported from packages/lhc/test/fixtures/threads.ts. Phase 1 skeleton.

Thread builders for Epic 02 (test plan §Test Substrate). Types/constants are
real; SDK-calling and below-SDK DB helpers are skeletons.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

from lhc.intake_stream import MessageEventInput
from lhc.sdk import Lhc
from lhc.shared_tech.derivation import (
    Derivation,
    DerivationMetadata,
    DerivationState,
    SubjectKind,
)
from .inference_callbacks_double import InferenceCallbacksDouble
from .model_call import DerivationType

if TYPE_CHECKING:
    from . import TempStore


class ChunkRow(TypedDict):
    chunkId: str
    chunkOrder: int
    status: Literal["open", "closed"]
    accumulatedProjectedTokens: int


class ChunkMemberRow(TypedDict):
    chunkId: str
    turnId: str
    memberIdx: int


class ChunkSnapshot(TypedDict):
    chunks: list[ChunkRow]
    members: list[ChunkMemberRow]


class FormStateTarget(TypedDict):
    subjectKind: SubjectKind
    subjectId: str
    derivationType: DerivationType


class FormStateUpdate(TypedDict):
    state: DerivationState
    content: NotRequired[str]
    reason: NotRequired[str]
    metadata: NotRequired[DerivationMetadata]
    derivedAt: NotRequired[str]


class MultiStateClaim(TypedDict):
    subjectKind: SubjectKind
    subjectId: str
    derivationType: DerivationType
    state: DerivationState


class ThreadWithClosedTurnsResult(TypedDict):
    filePath: str
    turnIds: list[str]


class ThreadWithToolRunResult(TypedDict):
    filePath: str
    turnId: str


class MultiStateThreadResult(TypedDict):
    filePath: str
    expected: list[MultiStateClaim]


class DamagedSourceThreadResult(TypedDict):
    filePath: str
    turnId: str


class GappedRenderingThreadResult(TypedDict):
    filePath: str
    messageId: str
    turnId: str


class ToolRunOpts(TypedDict, total=False):
    isError: bool
    missingResult: bool
    resultContent: str


# TC-3.2's fallback-rendering state as one shared builder (coverage.md
# cross-story debt: TC-4.4 consumes this exact scenario; don't rebuild it by
# hand). Expects a manual-mode SDK:
# scripts the prompt's smoothing to fail, then drains — the smoothing lands
# failed (its work row deleted) and the
# turn rendering lands ready from the raw floor.
GAPPED_SMOOTHING_REASON = "provider_failure: scripted smoothing failure"


async def _new_thread_file(store: TempStore) -> str:
    raise NotImplementedError


async def _send(file_path: str, batch: list[MessageEventInput] | tuple[MessageEventInput, ...]) -> None:
    raise NotImplementedError


async def thread_with_closed_turns(
    store: TempStore,
    n: int,
) -> ThreadWithClosedTurnsResult:
    raise NotImplementedError


async def thread_with_tool_run(
    store: TempStore,
    opts: ToolRunOpts | None = None,
) -> ThreadWithToolRunResult:
    raise NotImplementedError


# ── chunk read-back (Story 3): raw rows for boundary assertions ──


def read_chunks(file_path: str) -> ChunkSnapshot:
    raise NotImplementedError


# ── derivation read-back and the sanctioned state writer ───────


def read_derived_forms(file_path: str) -> list[Derivation]:
    raise NotImplementedError


# Below-SDK state writer, sanctioned like corrupt.ts: ready/failed/blocked
# are unreachable through the SDK until the drain (Story 1) and handlers
# (Stories 2–3) land. UPDATE-only on purpose — the pending row exists from
# enqueue, mirroring the production completion contract.
def set_form_state(
    file_path: str,
    target: FormStateTarget,
    update: FormStateUpdate,
) -> None:
    raise NotImplementedError


# ── multi-state thread: every form state in one file ─────────────


async def multi_state_thread(store: TempStore) -> MultiStateThreadResult:
    raise NotImplementedError


# ── damaged-source thread (Epic 01 corruption definition) ────────


async def damaged_source_thread(store: TempStore) -> DamagedSourceThreadResult:
    raise NotImplementedError


# ── fallback-rendering thread (TC-3.2's state, shared) ─────────────


async def gapped_rendering_thread(
    store: TempStore,
    sdk: Lhc,
    double: InferenceCallbacksDouble,
) -> GappedRenderingThreadResult:
    raise NotImplementedError


__all__ = [
    "ChunkSnapshot",
    "DamagedSourceThreadResult",
    "GAPPED_SMOOTHING_REASON",
    "GappedRenderingThreadResult",
    "MultiStateClaim",
    "MultiStateThreadResult",
    "ThreadWithClosedTurnsResult",
    "ThreadWithToolRunResult",
    "damaged_source_thread",
    "gapped_rendering_thread",
    "multi_state_thread",
    "read_chunks",
    "read_derived_forms",
    "set_form_state",
    "thread_with_closed_turns",
    "thread_with_tool_run",
]
