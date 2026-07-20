"""Ported from packages/lhc/src/inspect/internal/health.ts. Phase 1 skeleton.

Health composition joins owners' report surfaces into state counts,
actionable failure detail, a repair preview, and live queue visibility.
Message/turn derivation health comes from DerivationReportEntry rows; capture
gaps come from durable source-event markers recorded by capture.
"""

from __future__ import annotations

from typing import Literal

from ...intake_stream import EventRecord
from ...shared_tech.derivation import DerivationReportEntry
from ...shared_tech.errors import OpResult
from ...shared_tech.inspect import HealthFailure, HealthOwnerCounts, HealthReport
from ...threads import ThreadRef

_Owner = Literal["capture", "messages", "turns"]


def _empty_counts() -> HealthOwnerCounts:
    raise NotImplementedError


def _capture_gap_text(event: EventRecord) -> str | None:
    raise NotImplementedError


def _failure_of(owner: _Owner, entry: DerivationReportEntry) -> HealthFailure:
    raise NotImplementedError


async def compose_health(ref: ThreadRef) -> OpResult[HealthReport]:
    raise NotImplementedError
