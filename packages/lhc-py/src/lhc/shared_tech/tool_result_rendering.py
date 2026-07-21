"""Ported from packages/lhc/src/shared-tech/tool-result-rendering.ts.

Deterministic truncation for composed tool activity (call args and result
floors). Pure: no inference, DB, clock, or config, so identical source text
always yields identical output.
"""

from __future__ import annotations

from ._jsstr import js_len, js_slice

FALLBACK_TRUNCATION_LIMIT = 500


def truncate_for_fallback(text: str) -> str:
    # TS: text.length / text.slice — UTF-16 code units.
    if js_len(text) <= FALLBACK_TRUNCATION_LIMIT:
        return text
    dropped = js_len(text) - FALLBACK_TRUNCATION_LIMIT
    return f"{js_slice(text, 0, FALLBACK_TRUNCATION_LIMIT)}… [truncated {dropped} chars]"
