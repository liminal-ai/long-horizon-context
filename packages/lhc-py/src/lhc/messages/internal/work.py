"""Ported from packages/lhc/src/messages/internal/work.ts. Phase 1 skeleton."""

from __future__ import annotations

from typing import Literal

from ...intake_stream import EventKind
from ...shared_tech.work_queue import WorkKind

MessageDerivationType = Literal["smoothed_prompt", "tool_result_summary"]

MESSAGE_WORK_KINDS: dict[EventKind, WorkKind] = {
    "user_prompt": "prompt_smoothing",
    "tool_result": "tool_result_summary",
}

MESSAGE_WORK_DERIVATIONS: dict[WorkKind, MessageDerivationType] = {
    "prompt_smoothing": "smoothed_prompt",
    "tool_result_summary": "tool_result_summary",
}
