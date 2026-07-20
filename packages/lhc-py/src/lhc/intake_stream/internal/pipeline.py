"""Ported from packages/lhc/src/intake-stream/internal/pipeline.ts. Phase 1 skeleton.

OUT-OF-ORDER (Wave 2/3): only the test seam — `IntakeWalkHook`,
`set_intake_walk_hook`, `set_intake_clock` — is ported here so
`tests/fixtures/intake_seam.py` has a real module to re-export from. The
batch transaction pipeline itself (`run_message_events`, `run_list_events`,
`recorded_keys`, `max_event_order`) lands with the rest of Wave 3.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from ...shared_tech.storage import Database

# Test seam (set only through test/fixtures): called after each event is
# processed inside the walk, so atomicity under mid-walk failure can be
# induced through a real mechanism — closing the handle — rather than a
# mocked transaction object.
IntakeWalkHook = Callable[[Database, int], None]

_walk_hook: IntakeWalkHook | None = None


def set_intake_walk_hook(hook: IntakeWalkHook | None) -> None:
    raise NotImplementedError


# Test seam (set only through test/fixtures): replaces the wall clock so
# recordedAt is sourced deterministically for the public SDK contract proof —
# tests record the same batch through both reference shapes and read it back
# field-for-field, recordedAt included, with nothing stripped. Unset in
# production: recording stamps real wall time. An explicit clock argument to
# run_message_events still wins over the seam.
_injected_clock: Callable[[], datetime] | None = None


def set_intake_clock(clock: Callable[[], datetime] | None) -> None:
    raise NotImplementedError
