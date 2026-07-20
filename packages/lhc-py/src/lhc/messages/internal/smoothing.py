"""Ported from packages/lhc/src/messages/internal/smoothing.ts. Phase 1 skeleton.

Deterministic prompt floor for smoothing recovery. Pure by construction:
no DB, no clock, no inference.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class _ReadLineResult:
    raw: str
    body: str
    next: int


def _clean_prose(text: str) -> str:
    raise NotImplementedError


def _read_line(text: str, start: int) -> _ReadLineResult:
    raise NotImplementedError


def _fence_marker(body: str) -> Literal["`", "~"] | None:
    raise NotImplementedError


def clean_prompt(text: str) -> str:
    raise NotImplementedError
