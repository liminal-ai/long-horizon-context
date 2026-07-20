"""Ported from packages/lhc/src/shared-tech/report.ts. Phase 1 skeleton.

The report row mapper shared by owner report queries. Each domain owns its
one-query join and derivation_type→kind mapping; the raw-row →
DerivationReportEntry mapping is owner-blind and lives here so owners cannot
drift on how state, metadata, gaps, and queue detail read back.
"""

from __future__ import annotations

from dataclasses import dataclass

from .derivation import DerivationReportEntry, SubjectKind


@dataclass(frozen=True, slots=True)
class RawReportRow:
    subject_id: str
    derivation_type: str
    state: str
    content: str | None
    reason: str | None
    metadata: str | None
    source_version: int  # TS: number | bigint — coerce in Phase 2
    gaps: str | None
    derived_at: str | None
    queue_status: str | None


def report_entry_from_row(subject_kind: SubjectKind, row: RawReportRow) -> DerivationReportEntry:
    raise NotImplementedError
