"""Ported from packages/lhc/src/thread-view/index.ts. Phase 1 skeleton.

Wave 6 owns the full thread-view surface. Wave 4 needs `status`; Wave 5
chunk-compact-recovery needs `compact` + `get_llm_request_context` as
forward stubs so collection stays clean. Extend — do not reshape.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..shared_tech.errors import OpResult
from ..shared_tech.view import CompactReceipt, LlmRequestContext, ViewCompactParams, ViewStatus
from ..threads import ThreadRef


@dataclass(frozen=True, slots=True)
class CompactAbortSignal:
    """TS compact opts.signal — dot-accessed `{ aborted: boolean }`."""

    aborted: bool


@dataclass(frozen=True, slots=True)
class CompactOpts:
    """Opts bag for compact / previewCompact — mirrors the TS inline object."""

    profile: str | None = None
    params: ViewCompactParams | None = None
    signal: CompactAbortSignal | None = None


# Reads only, callable any time, no side effects: tail size against the
# configured trigger threshold with a compact recommendation, derivation
# counts by state, the active view's health or null pre-compact, and the
# visibility zone's sum against its max.
async def status(ref: ThreadRef) -> OpResult[ViewStatus]:
    raise NotImplementedError


# Compact runs only when invoked through this surface; no core path calls it.
# Assembly is entirely from stored artifacts: nothing here can reach
# inference or schedule repair work.
async def compact(ref: ThreadRef, opts: CompactOpts) -> OpResult[CompactReceipt]:
    raise NotImplementedError


# Session-facing LLM request context from the stored view (or empty pre-compact).
async def get_llm_request_context(ref: ThreadRef) -> OpResult[LlmRequestContext]:
    raise NotImplementedError


__all__ = [
    "CompactAbortSignal",
    "CompactOpts",
    "compact",
    "get_llm_request_context",
    "status",
]
