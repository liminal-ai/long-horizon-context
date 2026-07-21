"""Ported from packages/lhc/src/inspect/internal/overview.ts. Phase 1 skeleton.

Overview composition is one read-only call assembling thread identity, record
counts, derivation states, view summary, and visibility from other public
surfaces. Every thread shape falls out of this one composition path: absent
pieces normalize to zeros/nulls, no shape-specific branch.
"""

from __future__ import annotations

from collections.abc import Sequence

from ... import intake_stream, messages, thread_view, threads, turns
from ...shared_tech.derivation import DerivationReportEntry
from ...shared_tech.errors import OpOk, OpResult
from ...shared_tech.inspect import (
    InspectOverview,
    InspectOverviewChunks,
    InspectOverviewDerivation,
    InspectOverviewEvents,
    InspectOverviewEventsSpan,
    InspectOverviewMessages,
    InspectOverviewThread,
    InspectOverviewTurns,
    InspectOverviewView,
    InspectOverviewVisibility,
)
from ...threads import ThreadRef


# One report entry's operational bucket. Unlike ViewStatus, overview counts
# ready too.
def bucket_entries(
    entries: Sequence[DerivationReportEntry],
    counts: InspectOverviewDerivation,
) -> None:
    for entry in entries:
        if entry.state == "ready":
            counts.ready += 1
        elif entry.state == "pending":
            counts.pending += 1
        elif entry.state == "failed":
            counts.failed += 1
        elif entry.state == "blocked":
            counts.blocked += 1


async def compose_overview(ref: ThreadRef) -> OpResult[InspectOverview]:
    # Thread identity from the threads surface: the file's own metadata header
    # serves any resolvable ref; a registry row (threadId refs) adds the title.
    identity = await threads.info(ref)
    if not identity.ok:
        return identity
    thread = InspectOverviewThread(
        id=identity.value.thread_id,
        created_at=identity.value.created_at,
    )
    if "threadId" in ref:
        registered = await threads.resolve(ref)
        if registered.ok and registered.value.title is not None:
            thread = InspectOverviewThread(
                id=thread.id,
                created_at=thread.created_at,
                metadata={"title": registered.value.title},
            )

    events = await intake_stream.list_events(ref)
    if not events.ok:
        return events
    event_list = events.value
    first = event_list[0] if len(event_list) > 0 else None
    last = event_list[-1] if len(event_list) > 0 else None
    event_section = InspectOverviewEvents(
        count=len(event_list),
        span=(
            None
            if first is None or last is None
            else InspectOverviewEventsSpan(
                first=first["eventOrder"],
                last=last["eventOrder"],
            )
        ),
    )

    # The audit listing carries everything; deleted records count only in
    # `deleted`. Visible, byKind, and the token sum are computed over unflagged
    # records alone.
    listed = await messages.list(ref, {"includeDeleted": True})
    if not listed.ok:
        return listed
    by_kind: dict[str, int] = {}
    visible = 0
    deleted = 0
    visible_tokens = 0
    for record in listed.value:
        if record.deleted is True:
            deleted += 1
            continue
        visible += 1
        # TS: messageSection.byKind[record.kind] = (… ?? 0) + 1
        by_kind[record.kind] = by_kind.get(record.kind, 0) + 1
        visible_tokens += record.token_estimate
    message_section = InspectOverviewMessages(
        visible=visible,
        by_kind=by_kind,
        deleted=deleted,
        visible_tokens=visible_tokens,
    )

    turn_list = await turns.list_turns(ref)
    if not turn_list.ok:
        return turn_list
    open_count = sum(1 for turn in turn_list.value if turn.status == "open")
    closed = len(turn_list.value) - open_count

    chunk_list = await turns.list_chunks(ref)
    if not chunk_list.ok:
        return chunk_list
    # Closed-but-unchunked: closed turns whose derivation has not placed them
    # yet — stored placement read back, never recomputed.
    unchunked_turns = sum(
        1
        for turn in turn_list.value
        if turn.status == "closed" and turn.chunk_id is None
    )

    # Derivation counts across both owners' report surfaces (never a
    # derivation read), ready included.
    message_report = await messages.report(ref)
    if not message_report.ok:
        return message_report
    turn_report = await turns.report(ref)
    if not turn_report.ok:
        return turn_report
    derivation = InspectOverviewDerivation(ready=0, pending=0, failed=0, blocked=0)
    bucket_entries(message_report.value, derivation)
    bucket_entries(turn_report.value, derivation)

    # View summary and visibility: visibility from status; view identity from
    # describe, with stored snapshot fields returned verbatim.
    status = await thread_view.status(ref)
    if not status.ok:
        return status
    described = await thread_view.describe(ref)
    if not described.ok:
        return described
    stored = described.value
    view: InspectOverviewView | None = (
        None
        if stored is None
        else InspectOverviewView(
            view_id=stored.view_id,
            created_at=stored.created_at,
            compact_point=stored.compact_point,
            covered_from=stored.covered_from,
        )
    )

    return OpOk(
        InspectOverview(
            thread=thread,
            events=event_section,
            messages=message_section,
            turns=InspectOverviewTurns(open=open_count, closed=closed),
            chunks=InspectOverviewChunks(
                count=len(chunk_list.value),
                unchunked_turns=unchunked_turns,
            ),
            derivation=derivation,
            view=view,
            visibility=InspectOverviewVisibility(
                boundary_position=status.value.visibility.boundary_position,
                zone_tokens=status.value.visibility.zone_tokens,
            ),
        )
    )
