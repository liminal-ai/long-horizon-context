"""Ported from packages/lhc/src/shared-tech/classify.ts.

`safe_call` contains the host function: a thrown exception becomes `other`
and the adapter-owned timeout race becomes `timeout`, so host behavior cannot
crash a drain.
"""

from __future__ import annotations

import asyncio

from .inference_types import ModelCall, ModelCallErr, ModelCallInput, ModelCallResult


# try/catch + timeout race around the host function.
async def safe_call(call: ModelCall, input: ModelCallInput, timeout_ms: int) -> ModelCallResult:
    async def attempt() -> ModelCallResult:
        try:
            # The async wrapper folds synchronous throws into the same path —
            # the host's promise contract is not trusted (may be sync-raising).
            result = call(input)  # type: ignore[operator]
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                return await result  # type: ignore[misc]
            return result  # type: ignore[return-value]
        except BaseException as cause:
            # JS `String(cause)` — Error → "Error: msg"; other values → String(value).
            if isinstance(cause, Exception):
                msg = str(cause)
                name = type(cause).__name__
                # V8: String(new Error("x")) === "Error: x"
                if name in ("Error", "Exception") or type(cause) is Exception:
                    message = f"Error: {msg}" if msg else "Error"
                else:
                    message = msg if msg else name
            else:
                message = str(cause)
            return ModelCallErr(kind="other", message=message)

    attempt_task = asyncio.create_task(attempt())
    timeout_task = asyncio.create_task(asyncio.sleep(timeout_ms / 1000.0))
    try:
        done, _pending = await asyncio.wait(
            {attempt_task, timeout_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if attempt_task in done:
            return attempt_task.result()
        return ModelCallErr(
            kind="timeout",
            message=f"model call timed out after {timeout_ms}ms",
        )
    finally:
        timeout_task.cancel()
        # Leave attempt running if it lost the race (TS Promise.race behavior);
        # only cancel the timer task.
