"""Ported from packages/lhc/src/shared-tech/report.ts. Phase 1 skeleton.

The report row mapper shared by owner report queries. Each domain owns its
one-query join and derivation_type→kind mapping; the raw-row →
DerivationReportEntry mapping is owner-blind and lives here so owners cannot
drift on how state, metadata, gaps, and queue detail read back.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .derivation import (
    DependencyGap,
    DerivationReportEntry,
    DerivationReportQueue,
    SubjectKind,
    decode_derivation_metadata,
)


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
    gaps = None
    if row.gaps is not None:
        gaps = [
            DependencyGap(
                subject_kind=gap["subjectKind"],
                subject_id=gap["subjectId"],
                derivation_type=gap["derivationType"],
            )
            for gap in json.loads(row.gaps)
        ]
    queue = None
    if row.queue_status is not None:
        queue = DerivationReportQueue(status=str(row.queue_status))  # type: ignore[arg-type]
    return DerivationReportEntry(
        subject_kind=subject_kind,
        subject_id=row.subject_id,
        derivation_type=row.derivation_type,
        state=str(row.state),  # type: ignore[arg-type]
        source_version=int(row.source_version),
        content=row.content,
        reason=row.reason,
        gaps=gaps,
        metadata=(
            decode_derivation_metadata(json.loads(row.metadata))
            if row.metadata is not None
            else None
        ),
        derived_at=row.derived_at,
        queue=queue,
    )
