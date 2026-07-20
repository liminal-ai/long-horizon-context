"""Private JS string semantics: UTF-16 code-unit length/slice/charCodeAt.

TS user-text `.length` / `.slice` / `charCodeAt` count UTF-16 code units, not
Python code points. Astral characters (e.g. emoji) are two units each.
"""

from __future__ import annotations


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
