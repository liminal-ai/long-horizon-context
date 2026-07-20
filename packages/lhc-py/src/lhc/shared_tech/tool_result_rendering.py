"""Ported from packages/lhc/src/shared-tech/tool-result-rendering.ts. Phase 1 skeleton.

Deterministic truncation for composed tool activity (call args and result
floors). Pure: no inference, DB, clock, or config, so identical source text
always yields identical output.
"""

from __future__ import annotations

FALLBACK_TRUNCATION_LIMIT = 500


def truncate_for_fallback(text: str) -> str:
    raise NotImplementedError
