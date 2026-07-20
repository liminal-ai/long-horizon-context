"""Ported from packages/lhc/src/thread-view/index.ts. Phase 1 skeleton.

Wave 6 owns the full thread-view surface. Wave 4 tests need `status` as a
forward stub so `messages-read` collection stays clean.
"""

from __future__ import annotations

from ..shared_tech.errors import OpResult
from ..shared_tech.view import ViewStatus
from ..threads import ThreadRef


# Reads only, callable any time, no side effects: tail size against the
# configured trigger threshold with a compact recommendation, derivation
# counts by state, the active view's health or null pre-compact, and the
# visibility zone's sum against its max.
async def status(ref: ThreadRef) -> OpResult[ViewStatus]:
    raise NotImplementedError


__all__ = [
    "status",
]
