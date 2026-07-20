"""Ported from packages/lhc/src/inspect/internal/view-report.ts. Phase 1 skeleton.

View-contents report composition uses only describe + model context. The
stored arrangement, gaps, config, per-band token counts, and source-state
provenance come from `threadView.describe`; serving cost comes from measuring
`threadView.getLlmRequestContext` messages with the shared estimator. Nothing
here recomputes selection, rendering, derivation choice, or boundary state.
"""

from __future__ import annotations

from collections.abc import Sequence

from ...shared_tech.errors import OpResult
from ...shared_tech.inspect import ViewContentsReport
from ...shared_tech.view import Band, LlmRequestContextMessage
from ...threads import ThreadRef

_BAND_ORDER: tuple[Band, ...] = ("brief", "detailed", "smooth")


def _message_text(message: LlmRequestContextMessage) -> str:
    raise NotImplementedError


def _measured_tokens(messages: Sequence[LlmRequestContextMessage]) -> int:
    raise NotImplementedError


async def compose_view_report(ref: ThreadRef) -> OpResult[ViewContentsReport]:
    raise NotImplementedError
