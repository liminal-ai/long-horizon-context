"""Ported from packages/lhc/src/inspect/internal/view-report.ts. Phase 1 skeleton.

View-contents report composition uses only describe + model context. The
stored arrangement, gaps, config, per-band token counts, and source-state
provenance come from `threadView.describe`; serving cost comes from measuring
`threadView.getLlmRequestContext` messages with the shared estimator. Nothing
here recomputes selection, rendering, derivation choice, or boundary state.
"""

from __future__ import annotations

from collections.abc import Sequence

from ... import thread_view
from ...shared_tech.errors import OpOk, OpResult, storage_failure
from ...shared_tech.inspect import (
    ViewContentsBand,
    ViewContentsBandEntry,
    ViewContentsGap,
    ViewContentsLoadCost,
    ViewContentsMeta,
    ViewContentsMetaConfig,
    ViewContentsReport,
    ViewContentsSourceState,
    ViewContentsTail,
)
from ...shared_tech.token_counting import estimate_tokens
from ...shared_tech.view import Band, LlmRequestContextMessage
from ...threads import ThreadRef

_BAND_ORDER: tuple[Band, ...] = ("brief", "detailed", "smooth")


def _message_text(message: LlmRequestContextMessage) -> str:
    return "".join(part.text for part in message.content)


def _measured_tokens(messages: Sequence[LlmRequestContextMessage]) -> int:
    return sum(estimate_tokens(_message_text(message)) for message in messages)


async def compose_view_report(ref: ThreadRef) -> OpResult[ViewContentsReport]:
    described = await thread_view.describe(ref)
    if not described.ok:
        return described
    context = await thread_view.get_llm_request_context(ref)
    if not context.ok:
        return context
    stored = described.value
    # TS: stored?.bands.length ?? 0
    stored_band_count = 0 if stored is None else len(stored.bands)

    band_messages = context.value.messages[:stored_band_count]
    tail_messages = context.value.messages[stored_band_count:]

    # Cross-check count only: the arrangement is describe's; model context has
    # to be serving the same snapshot's bands. A mismatch means the two reads saw
    # different stored state, so report it rather than papering over it.
    if len(band_messages) != stored_band_count:
        return storage_failure(
            f"view report cross-check failed: describe saw {stored_band_count} "
            f"stored band(s) but model context produced {len(band_messages)} "
            "band message(s); the view changed between reads"
        )

    # Band sections: stored arrangement entries grouped in served order
    # (brief → detailed → smooth), gap entries included. Their reasons live in
    # `gaps`. storedTokens is the band row's count from the stored snapshot, not
    # recomputed here.
    bands: list[ViewContentsBand] = []
    if stored is not None:
        for band in _BAND_ORDER:
            entries = [
                ViewContentsBandEntry(
                    subject_kind=entry.subject_kind,
                    subject_id=entry.subject_id,
                    derivation_used=entry.derivation_used,
                    degraded=entry.degraded,
                )
                for entry in stored.arrangement
                if entry.band == band
            ]
            stored_band = next((row for row in stored.bands if row.band == band), None)
            if len(entries) == 0 and stored_band is None:
                continue
            bands.append(
                ViewContentsBand(
                    band=band,
                    entries=entries,
                    stored_tokens=0 if stored_band is None else stored_band.stored_tokens,
                )
            )

    band_tokens = _measured_tokens(band_messages)
    tail_tokens = _measured_tokens(tail_messages)

    meta: ViewContentsMeta | None = None
    gaps: list[ViewContentsGap] = []
    source_state: ViewContentsSourceState | None = None
    if stored is not None:
        meta = ViewContentsMeta(
            view_id=stored.view_id,
            created_at=stored.created_at,
            profile=stored.profile_name,
            config=ViewContentsMetaConfig(
                lower_bound=stored.config.lower_bound,
                percentages=dict(stored.config.percentages),
            ),
            compact_point=stored.compact_point,
            covered_from=stored.covered_from,
        )
        gaps = [
            ViewContentsGap(
                band=gap.band,
                subject_id=gap.subject_id,
                reason=gap.reason,
            )
            for gap in stored.gaps
        ]
        source_state = ViewContentsSourceState(
            max_event_order=stored.source_state.max_event_order,
            derivation_counts=dict(stored.source_state.derivation_counts),
        )

    return OpOk(
        ViewContentsReport(
            meta=meta,
            bands=bands,
            gaps=gaps,
            tail=ViewContentsTail(
                message_count=len(tail_messages),
                tokens=tail_tokens,
            ),
            load_cost=ViewContentsLoadCost(
                band_tokens=band_tokens,
                tail_tokens=tail_tokens,
                total=band_tokens + tail_tokens,
            ),
            source_state=source_state,
        )
    )
