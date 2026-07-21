"""Ported from packages/lhc/src/inspect/index.ts. Phase 1 skeleton.

Inspect is a pure consumer of other public surfaces: it imports no internals,
owns no tables, calls no inference, and writes nothing. It reports repair
targets without executing repair; mutations stay on the owning surfaces.

`view` reports the stored snapshot from `threadView.describe` plus the
serving cost measured from thread-view serving assembly, matching what agents
receive by construction.

Reads-only is structural: every operation runs in the touch-suppressed scope,
so open announcements fired by composed surfaces cannot let background
scheduling hang catch-up work or inference off an inspect read.
"""

from __future__ import annotations

from ..shared_tech.errors import OpResult
from ..shared_tech.inspect import HealthReport, InspectOverview, ViewContentsReport
from ..threads import ThreadRef
from .internal.health import compose_health
from .internal.overview import compose_overview
from .internal.view_report import compose_view_report

__all__ = [
    "HealthReport",
    "InspectOverview",
    "ViewContentsReport",
    "health",
    "overview",
    "view",
]


async def overview(ref: ThreadRef) -> OpResult[InspectOverview]:
    return await compose_overview(ref)


async def health(ref: ThreadRef) -> OpResult[HealthReport]:
    return await compose_health(ref)


async def view(ref: ThreadRef) -> OpResult[ViewContentsReport]:
    return await compose_view_report(ref)
