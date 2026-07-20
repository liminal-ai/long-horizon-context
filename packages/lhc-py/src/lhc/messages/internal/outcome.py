"""Ported from packages/lhc/src/messages/internal/outcome.ts. Phase 1 skeleton.

Mechanical ToolOutcome stamping: the outcome on a tool-activity summary is a
pure function of the record — paired-result presence and its isError flag —
and nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...shared_tech.derivation import ToolOutcome


@dataclass(frozen=True, slots=True)
class PairedResult:
    is_error: bool


def derive_tool_outcome(paired_result: PairedResult | None) -> ToolOutcome:
    if paired_result is None:
        return "unknown"
    return "failed" if paired_result.is_error else "succeeded"
