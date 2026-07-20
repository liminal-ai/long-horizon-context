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

import asyncio
import json
import sys
from dataclasses import asdict, is_dataclass
from typing import TypedDict

from lhc.sdk import init_lhc

from .inference_callbacks_double import create_inference_callbacks_double
from .work_handlers import register_test_work_handlers


class RunnerConfig(TypedDict):
    threadPath: str
    leaseMs: int
    holdMs: int
    holdFrom: int  # 1-based handler-start index the hold applies from


async def _sleep(ms: int) -> None:
    await asyncio.sleep(ms / 1000.0)


async def main() -> None:
    if len(sys.argv) <= 2:
        raise RuntimeError("drain-runner: missing JSON config argument")
    config: RunnerConfig = json.loads(sys.argv[2])

    double = create_inference_callbacks_double()
    sdk = init_lhc(
        {
            "inferenceCallbacks": double,
            "mode": "manual",
            "lease": {"durationMs": config["leaseMs"]},
        }
    )
    started = 0

    async def on_handler_start(item) -> None:
        nonlocal started
        started += 1
        print(f'HANDLER_START {started} {item["workItemId"]}', flush=True)
        if started >= config["holdFrom"]:
            await _sleep(config["holdMs"])

    register_test_work_handlers(
        sdk, double, {"onHandlerStart": on_handler_start}
    )
    report = await sdk.work.drain({"filePath": config["threadPath"]})
    print(
        f"DRAIN_DONE {json.dumps(_json_value(report), separators=(',', ':'))}",
        flush=True,
    )
    if not report.ok:
        raise SystemExit(1)


def _camel_key(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def _json_value(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    if isinstance(value, dict):
        return {
            _camel_key(str(key)): _json_value(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as cause:  # noqa: BLE001 - mirrors main().catch in TS
        sys.stderr.write(f"drain-runner failed: {cause}\n")
        sys.exit(1)
