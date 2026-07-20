"""Ported from packages/lhc/src/inspect/internal/overview.ts. Phase 1 skeleton.

Overview composition is one read-only call assembling thread identity, record
counts, derivation states, view summary, and visibility from other public
surfaces. Every thread shape falls out of this one composition path: absent
pieces normalize to zeros/nulls, no shape-specific branch.
"""

from __future__ import annotations

from collections.abc import Sequence

from ...shared_tech.derivation import DerivationReportEntry
from ...shared_tech.errors import OpResult
from ...shared_tech.inspect import InspectOverview, InspectOverviewDerivation
from ...threads import ThreadRef


# One report entry's operational bucket. Unlike ViewStatus, overview counts
# ready too.
def bucket_entries(
    entries: Sequence[DerivationReportEntry],
    counts: InspectOverviewDerivation,
) -> None:
    raise NotImplementedError


async def compose_overview(ref: ThreadRef) -> OpResult[InspectOverview]:
    raise NotImplementedError
