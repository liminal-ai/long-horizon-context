"""Ported from packages/lhc/src/thread-view/internal/seam.ts.

Test injection facility for compact's write path. Production code carries
the point as a no-op unless a test installs a hook: "compact-write" fires
between the sweep and the view-write transaction.
Tests reach the setters through test/fixtures/view-seam.ts (the one
directory sanctioned to import below the SDK surface); production code
only ever fires.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

ViewInjectionPoint = Literal["compact-write"]

ViewInjectionHook = Callable[[], None]

_hooks: dict[ViewInjectionPoint, ViewInjectionHook | None] = {
    "compact-write": None,
}


def set_view_injection_hook(point: ViewInjectionPoint, hook: ViewInjectionHook | None) -> None:
    _hooks[point] = hook


# The production-side call: a no-op when nothing is installed. An installed
# hook's throw propagates to the call site on purpose — that is the injected
# failure the call site must survive.
def fire_view_injection(point: ViewInjectionPoint) -> None:
    hook = _hooks[point]
    if hook is not None:
        hook()
