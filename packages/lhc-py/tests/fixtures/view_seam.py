"""Ported from packages/lhc/test/fixtures/view-seam.ts. Phase 1.

Epic 03 Story 0 view-domain test seams. Lives in fixtures/ — the one
directory sanctioned to reach below the SDK surface (boundary check
exempt).

The injection facility (FC-0.6): re-export of the thread-view seam so
tests install crash/failure hooks at compact's write path between sweep
and view write (TC-2.4). Uninstalled, production fires are no-ops.

seed_view_boundary is a sanctioned below-SDK write — skeletal in Phase 1
(same pattern as corrupt.py).
"""

from __future__ import annotations

from lhc.thread_view.internal.seam import (
    ViewInjectionHook,
    ViewInjectionPoint,
    fire_view_injection,
    set_view_injection_hook,
)

# Sanctioned below-SDK write (same sanctioning as corrupt.ts): seeds the
# view_boundary row to an arbitrary position for mid-tail context reads.
# UPDATE-only on purpose: thread creation seeded the singleton row.
#
# SQL verbatim from TS:
#   UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1


def seed_view_boundary(file_path: str, position: int) -> None:
    raise NotImplementedError


__all__ = [
    "ViewInjectionHook",
    "ViewInjectionPoint",
    "fire_view_injection",
    "seed_view_boundary",
    "set_view_injection_hook",
]
