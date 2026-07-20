"""Ported from packages/lhc/src/shared-tech/classify.ts. Phase 1 skeleton.

`safe_call` contains the host function: a thrown exception becomes `other`
and the adapter-owned timeout race becomes `timeout`, so host behavior cannot
crash a drain.
"""

from __future__ import annotations

from .inference_types import ModelCall, ModelCallInput, ModelCallResult


# try/catch + timeout race around the host function.
async def safe_call(call: ModelCall, input: ModelCallInput, timeout_ms: int) -> ModelCallResult:
    raise NotImplementedError
