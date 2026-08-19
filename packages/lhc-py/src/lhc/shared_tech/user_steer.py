"""Canonical typed non-boundary ``user_steer`` contract (LIM-113)."""

from __future__ import annotations

from typing import Literal, TypedDict

USER_STEER_PAYLOAD_VERSION: Literal[1] = 1
USER_STEER_IDEMPOTENCY_PREFIX = "lhc.user_steer:"
USER_STEER_RENDERING_LABEL = "User steering"


class UserSteerPayload(TypedDict):
    version: Literal[1]
    steerId: str
    text: str


def user_steer_idempotency_key(steer_id: str) -> str:
    return f"{USER_STEER_IDEMPOTENCY_PREFIX}{steer_id}"
