"""Ported from packages/lhc/src/messages/index.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Wave 1 tests import messages.list. Full messages surface lands in Wave 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

from ..shared_tech.errors import OpResult
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
