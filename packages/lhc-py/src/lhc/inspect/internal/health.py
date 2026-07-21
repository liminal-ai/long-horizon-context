"""Ported from packages/lhc/src/inspect/internal/health.ts. Phase 1 skeleton.

Health composition joins owners' report surfaces into state counts,
actionable failure detail, a repair preview, and live queue visibility.
Message/turn derivation health comes from DerivationReportEntry rows; capture
gaps come from durable source-event markers recorded by capture.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

from ... import intake_stream, messages, turns
from ...intake_stream import EventRecord
from ...shared_tech.derivation import DerivationReportEntry
from ...shared_tech.errors import OpOk, OpResult
from ...shared_tech.inspect import (
    HealthFailure,
    HealthOwnerCounts,
    HealthOwnerEntry,
    HealthQueue,
    HealthRepairPreview,
    HealthReport,
)
from ...threads import ThreadRef

_Owner = Literal["capture", "messages", "turns"]


def _empty_counts() -> HealthOwnerCounts:
    return HealthOwnerCounts(ready=0, pending=0, failed=0, blocked=0)


def _capture_gap_text(event: EventRecord) -> str | None:
    if event["eventKind"] != "runtime_note":
        return None
    text = event["payload"]["text"]
    return text if text.startswith("capture gap:") else None


def _failure_of(owner: _Owner, entry: DerivationReportEntry) -> HealthFailure:
    return HealthFailure(
        owner=owner,
        subject_kind=entry.subject_kind,
        subject_id=entry.subject_id,
        derivation_type=entry.derivation_type,
        # TS: entry.reason ?? ""
        reason="" if entry.reason is None else entry.reason,
    )


@dataclass
class _OwnerAccum:
    owner: _Owner
    kind: str
    counts: HealthOwnerCounts


async def compose_health(ref: ThreadRef) -> OpResult[HealthReport]:
    message_report = await messages.report(ref)
    if not message_report.ok:
        return message_report
    turn_report = await turns.report(ref)
    if not turn_report.ok:
        return turn_report
    events = await intake_stream.list_events(ref)
    if not events.ok:
        return events

    sources: list[tuple[_Owner, list[DerivationReportEntry]]] = [
        ("messages", list(message_report.value)),
        ("turns", list(turn_report.value)),
    ]

    counts_by_owner_kind: dict[str, _OwnerAccum] = {}
    failures: list[HealthFailure] = []
    repair_preview: list[HealthRepairPreview] = []
    queue = HealthQueue(queued=0, claimed=0)

    capture_gaps: list[tuple[EventRecord, str]] = []
    for event in events.value:
        text = _capture_gap_text(event)
        if text is not None:
            capture_gaps.append((event, text))
    if len(capture_gaps) > 0:
        counts_by_owner_kind["capture:capture_gap"] = _OwnerAccum(
            owner="capture",
            kind="capture_gap",
            counts=replace(_empty_counts(), failed=len(capture_gaps)),
        )
        for event, text in capture_gaps:
            failures.append(
                HealthFailure(
                    owner="capture",
                    subject_kind="event",
                    subject_id=str(event["eventOrder"]),
                    derivation_type="capture_gap",
                    reason=text,
                )
            )

    for owner, entries in sources:
        for entry in entries:
            key = f"{owner}:{entry.derivation_type}"
            row = counts_by_owner_kind.get(key)
            if row is None:
                row = _OwnerAccum(
                    owner=owner,
                    kind=entry.derivation_type,
                    counts=_empty_counts(),
                )
                counts_by_owner_kind[key] = row
            if entry.state == "ready":
                row.counts = replace(row.counts, ready=row.counts.ready + 1)
            elif entry.state == "pending":
                row.counts = replace(row.counts, pending=row.counts.pending + 1)
            elif entry.state == "failed":
                row.counts = replace(row.counts, failed=row.counts.failed + 1)
                failures.append(_failure_of(owner, entry))
                # The preview is exactly the failed-and-not-blocked set: blocked is
                # a distinct state, so failed entries ARE the requeue targets.
                repair_preview.append(
                    HealthRepairPreview(
                        owner=owner,
                        subject_kind=entry.subject_kind,
                        subject_id=entry.subject_id,
                        derivation_type=entry.derivation_type,
                    )
                )
            elif entry.state == "blocked":
                row.counts = replace(row.counts, blocked=row.counts.blocked + 1)
                failures.append(_failure_of(owner, entry))
            # Live queue visibility, per report entry: every pending entry rides a
            # live item, so queued + claimed here equals pending above by
            # construction. Counts are per derivation-report entry:
            # one work item may back multiple entries, so a raw work-item count would
            # break that identity.
            if entry.queue is not None:
                if entry.queue.status == "queued":
                    queue = replace(queue, queued=queue.queued + 1)
                else:
                    queue = replace(queue, claimed=queue.claimed + 1)

    # Deterministic order: messages before turns, kinds alphabetical within
    # an owner — repeated reads with no writes between are deep-equal.
    owners = [
        HealthOwnerEntry(owner=row.owner, kind=row.kind, counts=row.counts)
        for row in sorted(
            counts_by_owner_kind.values(),
            key=lambda r: (r.owner, r.kind),
        )
    ]

    return OpOk(
        HealthReport(
            owners=owners,
            failures=failures,
            repair_preview=repair_preview,
            queue=queue,
        )
    )
