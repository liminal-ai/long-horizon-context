"""Ported from packages/lhc/src/index.ts. Phase 1 — PARTIAL (Wave 1/7 import seam).

Re-exports the subset Wave 1 tests import. Full mirror of sdk.ts re-exports
lands in Wave 7.
"""

from __future__ import annotations

from . import intake_stream, messages, threads, turns
from .intake_stream import BatchResult, EventKind, EventRecord, MessageEventInput
from .sdk import (
    Lhc,
    create_deterministic_inference_callbacks,
    init_lhc,
    register_testing_work,
    set_scheduler_poke,
    set_thread_touch,
    write_log,
)
from .shared_tech.derivation import Derivation, InferenceCallbacks, InferenceResult
from .shared_tech.logging import LogEntry, LogLevel
from .shared_tech.work_queue import DrainReport, count_live_items
from .threads import ThreadRef

__all__ = [
    "BatchResult",
    "Derivation",
    "DrainReport",
    "EventKind",
    "EventRecord",
    "InferenceCallbacks",
    "InferenceResult",
    "Lhc",
    "LogEntry",
    "LogLevel",
    "MessageEventInput",
    "ThreadRef",
    "count_live_items",
    "create_deterministic_inference_callbacks",
    "init_lhc",
    "intake_stream",
    "messages",
    "register_testing_work",
    "set_scheduler_poke",
    "set_thread_touch",
    "threads",
    "turns",
    "write_log",
]
