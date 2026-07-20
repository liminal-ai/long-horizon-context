"""Ported from packages/lhc/test/fixtures/drain-runner.ts. Phase 1 skeleton.

Spawnable drain runner for the process-boundary suite (TC-1.3 / TC-1.4).
Argument: one JSON config — {threadPath, leaseMs, holdMs, holdFrom}. It
assembles a real SDK (manual mode), registers the test work handlers with a
marker/hold protocol, and drains the thread:
  - prints `HANDLER_START <n> <workItemId>` when the nth handler begins — by
    drain mechanics that means item n's claim committed and item n-1's
    completion landed (a kill can leave item n's claim to expire);
  - from item `holdFrom` on, sleeps `holdMs` inside the handler before the
    model call, keeping that item claimed-and-running while the parent kills
    this process (TC-1.3) or drains from a second process (TC-1.4);
  - prints `DRAIN_DONE <report JSON>` if it survives to the end.

RunnerConfig is pure data — real. `_sleep` and `main` are skeletons: the
process-boundary protocol (stdout markers, exit codes) lands in Phase 2.
"""

from __future__ import annotations

import sys
from typing import TypedDict


class RunnerConfig(TypedDict):
    threadPath: str
    leaseMs: int
    holdMs: int
    holdFrom: int  # 1-based handler-start index the hold applies from


async def _sleep(ms: int) -> None:
    raise NotImplementedError


async def main() -> None:
    raise NotImplementedError


if __name__ == "__main__":
    import asyncio

    try:
        asyncio.run(main())
    except Exception as cause:  # noqa: BLE001 - mirrors main().catch in TS
        sys.stderr.write(f"drain-runner failed: {cause}\n")
        sys.exit(1)
