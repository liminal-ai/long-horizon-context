"""Private JS string semantics: UTF-16 code-unit length/slice/charCodeAt.

TS user-text `.length` / `.slice` / `charCodeAt` count UTF-16 code units, not
Python code points. Astral characters (e.g. emoji) are two units each.

Also: JSON.stringify number spelling (integral floats → bare ints; NaN/Infinity
→ null inside JSON) and template-literal diagnostic spelling.
"""

from __future__ import annotations

import json
import math


def js_char_codes(s: str) -> list[int]:
    """UTF-16 code units matching JS `s.charCodeAt(i)` for each index."""
    out: list[int] = []
    for ch in s:
        cp = ord(ch)
        if cp <= 0xFFFF:
            out.append(cp)
        else:
            cp -= 0x10000
            out.append(0xD800 + (cp >> 10))
            out.append(0xDC00 + (cp & 0x3FF))
    return out


def js_len(s: str) -> int:
    """JS `s.length` — UTF-16 code-unit count."""
    n = 0
    for ch in s:
        n += 2 if ord(ch) > 0xFFFF else 1
    return n


def _decode_utf16_units(units: list[int]) -> str:
    """Reassemble UTF-16 units into a Python str.

    Complete surrogate pairs become one astral code point (matching JS string
    content after an even-boundary slice). Lone surrogates are kept as-is,
    matching JS mid-pair slices.
    """
    chars: list[str] = []
    i = 0
    n = len(units)
    while i < n:
        u = units[i]
        if 0xD800 <= u <= 0xDBFF and i + 1 < n and 0xDC00 <= units[i + 1] <= 0xDFFF:
            cp = 0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00)
            chars.append(chr(cp))
            i += 2
        else:
            chars.append(chr(u))
            i += 1
    return "".join(chars)


def js_slice(s: str, start: int = 0, end: int | None = None) -> str:
    """JS `s.slice(start, end)` over UTF-16 code units."""
    units = js_char_codes(s)
    length = len(units)
    if end is None:
        end = length

    def _clamp(index: int, length: int) -> int:
        if index < 0:
            index = length + index
        if index < 0:
            return 0
        if index > length:
            return length
        return index

    start_i = _clamp(start, length)
    end_i = _clamp(end, length)
    if end_i < start_i:
        return ""
    return _decode_utf16_units(units[start_i:end_i])


def js_json_normalize(value: object) -> object:
    """Normalize a value tree for JSON.stringify number/NaN semantics.

    Integral floats become ints (`1.0` → `1`); NaN/±Infinity become null
    (JSON.stringify in-object behavior). Recurses through dict/list/tuple.
    """
    if value is True or value is False or value is None:
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, dict):
        return {key: js_json_normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [js_json_normalize(item) for item in value]
    return value


def js_json_dumps(value: object) -> str:
    """JSON.stringify-compatible compact dump (no spaces, ensure_ascii=False)."""
    return json.dumps(
        js_json_normalize(value),
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def js_repr(value: object) -> str:
    """JS template-literal spelling for diagnostic interpolation."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer():
            return str(int(value))
        return str(value)
    return str(value)
