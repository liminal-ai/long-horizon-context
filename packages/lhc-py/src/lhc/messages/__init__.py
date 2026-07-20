"""Ported from packages/lhc/src/messages/index.ts. Phase 1 — PARTIAL (Wave 1/2 import seam).

Wave 1 tests import messages.list. Wave 2 adds the derive() import seam
(work-execution.test.ts calls sdk.messages.derive). Full messages surface
lands in Wave 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict, Union

from ..shared_tech.errors import ErrorResult, OpResult
from ..threads import ThreadRef

# Data keys verbatim from TS MessageListOptions; "from" is a Python keyword,
# so the functional TypedDict form is required. All optional: existing callers
# see visible messages, unbounded, in record order.
MessageListOptions = TypedDict(
    "MessageListOptions",
    {"from": int, "to": int, "limit": int, "includeDeleted": bool},
    total=False,
)


@dataclass(frozen=True, slots=True)
class MessageBlock:
    block_type: str
    content: dict[str, object]


@dataclass(frozen=True, slots=True)
class MessageRecord:
    message_id: str
    kind: str
    blocks: list[MessageBlock]


async def list(thread_ref: ThreadRef, filter: MessageListOptions | None = None) -> OpResult[list[MessageRecord]]:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class MessageDerived:
    message_id: str
    derivation_type: Literal["smoothed_prompt", "tool_result_summary"]
    source_version: int
    outcome: Literal["derived"] = "derived"


@dataclass(frozen=True, slots=True)
class MessageNotDerivable:
    message_id: str
    outcome: Literal["not_derivable"] = "not_derivable"


@dataclass(frozen=True, slots=True)
class MessageDeriveFailed:
    message_id: str
    error: ErrorResult
    outcome: Literal["failed"] = "failed"


MessageDeriveResult = Union[MessageDerived, MessageNotDerivable, MessageDeriveFailed]


# Synchronous message-owned derivation (Wave 4 completes the body). For each
# message id, selects the one message-owned derivation implied by the stored
# message kind, runs the existing handler, and lands the normal
# version-checked derivation write before returning.
async def derive(thread_ref: ThreadRef, message_ids: list[str]) -> OpResult[list[MessageDeriveResult]]:
    raise NotImplementedError
