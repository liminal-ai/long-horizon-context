"""Ported from packages/lhc/src/messages/internal/smoothing.ts.

Deterministic prompt floor for smoothing recovery. Pure by construction:
no DB, no clock, no inference.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...shared_tech._jsstr import js_char_codes, js_len, js_slice


@dataclass(frozen=True, slots=True)
class _ReadLineResult:
    raw: str
    body: str
    next: int


def _clean_prose(text: str) -> str:
    import re

    return re.sub(r"\bi\b", "I", re.sub(r"\n{3,}", "\n\n", re.sub(
        r" *\n *", "\n", re.sub(r"[ \t\f\v]+", " ", text.replace("\r\n", "\n").replace("\r", "\n"))
    )).strip())


def _read_line(text: str, start: int) -> _ReadLineResult:
    units = js_char_codes(text)
    end = start
    while end < len(units) and units[end] not in (10, 13):
        end += 1
    next_index = end
    if end < len(units):
        next_index = end + 2 if units[end] == 13 and end + 1 < len(units) and units[end + 1] == 10 else end + 1
    return _ReadLineResult(
        raw=js_slice(text, start, next_index),
        body=js_slice(text, start, end),
        next=next_index,
    )


def _fence_marker(body: str) -> Literal["`", "~"] | None:
    trimmed = body.lstrip()
    if trimmed.startswith("```"):
        return "`"
    if trimmed.startswith("~~~"):
        return "~"
    return None


def clean_prompt(text: str) -> str:
    parts: list[str] = []
    prose_start = 0
    cursor = 0
    length = js_len(text)
    while cursor < length:
        line = _read_line(text, cursor)
        marker = _fence_marker(line.body)
        if marker is None:
            cursor = line.next
            continue
        prose = _clean_prose(js_slice(text, prose_start, cursor))
        if prose:
            parts.append(f"{prose}\n")
        fence_end = line.next
        while fence_end < length:
            fence_line = _read_line(text, fence_end)
            fence_end = fence_line.next
            if _fence_marker(fence_line.body) == marker:
                break
        parts.append(js_slice(text, cursor, fence_end))
        cursor = fence_end
        prose_start = fence_end
    tail = _clean_prose(js_slice(text, prose_start))
    if tail:
        parts.append(tail)
    return "".join(parts)
