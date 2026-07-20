"""Ported from packages/lhc/test/fixtures/intake-seam.ts. Phase 1.

Test seam re-export for the intake walk. Lives in fixtures/ — the one
directory sanctioned to reach below the SDK surface (boundary check exempt).
`set_intake_walk_hook` induces real mid-walk failures (closing the handle
inside the transaction) for the atomicity architecture-risk tests;
`set_intake_clock` pins recorded_at to a fixed instant so the SDK contract
proof (TC-1.4) can read back every field — recorded_at included — for an
exact match.
"""

from __future__ import annotations

from lhc.intake_stream.internal.pipeline import (
    IntakeWalkHook,
    set_intake_clock,
    set_intake_walk_hook,
)

__all__ = [
    "IntakeWalkHook",
    "set_intake_clock",
    "set_intake_walk_hook",
]
