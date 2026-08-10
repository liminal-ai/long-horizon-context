"""Private JS string semantics: UTF-16 code-unit length/slice/charCodeAt.

TS user-text `.length` / `.slice` / `charCodeAt` count UTF-16 code units, not
Python code points. Astral characters (e.g. emoji) are two units each.

Also: JSON.stringify number spelling (ECMAScript Number::toString radix 10;
integral safe-integers bare; NaN/Infinity → null inside JSON) and
template-literal diagnostic spelling.
"""

from __future__ import annotations

import json
import math
import re

# IEEE-754 binary64 safe-integer bound (2^53). Integral floats within this
# range stringify as bare integers; beyond it, float identity is kept so
# large-magnitude spellings (1e+21) are not expanded via Python int.
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


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


# ECMAScript WhiteSpace + LineTerminator + BOM for String.prototype.trim.
# Deliberately excludes U+0085 NEL (JS does not trim it; Python str.strip does)
# and includes U+FEFF (JS trims it; Python str.strip does not).
_JS_TRIM_CHARS = frozenset(
    {
        "\u0009",  # TAB
        "\u000b",  # VT
        "\u000c",  # FF
        "\u0020",  # SP
        "\u00a0",  # NBSP
        "\ufeff",  # BOM / ZWNBSP
        "\u000a",  # LF
        "\u000d",  # CR
        "\u2028",  # LS
        "\u2029",  # PS
        "\u1680",  # OGHAM SPACE MARK
        "\u2000",  # EN QUAD … HAIR SPACE
        "\u2001",
        "\u2002",
        "\u2003",
        "\u2004",
        "\u2005",
        "\u2006",
        "\u2007",
        "\u2008",
        "\u2009",
        "\u200a",
        "\u202f",  # NARROW NO-BREAK SPACE
        "\u205f",  # MEDIUM MATHEMATICAL SPACE
        "\u3000",  # IDEOGRAPHIC SPACE
    }
)


def _is_js_trim_char(ch: str) -> bool:
    return ch in _JS_TRIM_CHARS


def js_trim(s: str) -> str:
    """JS `String.prototype.trim` — WhiteSpace + LineTerminator + BOM (U+FEFF).

    Use wherever a Wave body translates JS `.trim()`. Do not substitute
    Python `str.strip()`: U+FEFF and U+0085 disagree between the two.
    """
    start = 0
    end = len(s)
    while start < end and _is_js_trim_char(s[start]):
        start += 1
    while end > start and _is_js_trim_char(s[end - 1]):
        end -= 1
    return s[start:end]


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

    Safe-integer integral floats become ints (`1.0` → `1`); larger-magnitude
    integral floats stay floats so notation (1e+21) is preserved. NaN/±Infinity
    become null (JSON.stringify in-object behavior). Recurses through
    dict/list/tuple.
    """
    if value is True or value is False or value is None:
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        # Only collapse to int inside the safe-integer range. Outside it,
        # int(1e21) expands to a 22-digit decimal that JS never emits.
        if value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER:
            return int(value)
        # Canonicalize -0.0 → 0.0 (JSON.stringify / ToString both yield "0").
        if value == 0.0:
            return 0
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, dict):
        return {key: js_json_normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [js_json_normalize(item) for item in value]
    return value


def _ecma_components_from_repr(x: float) -> tuple[str, int]:
    """Parse Python's shortest-digit `repr` into ECMA (s, n) components.

    s is a digit string of length k ≥ 1 with no leading zero (unless s == "0");
    the Number value equals int(s) × 10^(n−k). Digit generation is Python's
    (repr); this only re-parses the notation layer.
    """
    r = repr(x)
    if r.startswith("-"):
        r = r[1:]
    if r in ("inf", "nan"):
        raise ValueError(f"non-finite float has no ECMA decimal components: {x!r}")

    if "e" in r or "E" in r:
        mant, exp_part = re.split(r"[eE]", r, maxsplit=1)
        exp = int(exp_part)
        if "." in mant:
            whole, frac = mant.split(".", 1)
            s = whole + frac
            # value = float(mant) * 10^exp = int(s) * 10^(exp - len(frac))
            # n - k = exp - len(frac)  ⇒  n = exp + len(whole)
            n = exp + len(whole)
        else:
            s = mant
            # value = int(s) * 10^exp; n - k = exp  ⇒  n = exp + k
            n = exp + len(s)
        s = s.lstrip("0") or "0"
        return s, n

    if "." in r:
        whole, frac = r.split(".", 1)
        if whole in ("", "0"):
            # 0.000001 → frac has leading zeros then significant digits.
            stripped = frac.lstrip("0")
            if stripped == "":
                return "0", 1
            leading_zeros = len(frac) - len(stripped)
            s = stripped
            # value = int(s) * 10^(-(leading_zeros + len(s)))
            # n - k = -(leading_zeros + k)  ⇒  n = -leading_zeros
            n = -leading_zeros
            return s, n
        s = whole + frac
        # value = int(s) * 10^(-len(frac)); n - k = -len(frac)  ⇒  n = len(whole)
        n = len(whole)
        return s, n

    # Integer decimal form from repr (rare for non-safe magnitudes; kept for
    # completeness).
    s = r.lstrip("0") or "0"
    n = len(s) if s != "0" else 1
    return s, n


def _js_format_ecma_digits(s: str, n: int) -> str:
    """ECMAScript Number::toString placement given components (s, n)."""
    k = len(s)
    # k ≤ n ≤ 21: integer decimal, pad trailing zeros.
    if k <= n <= 21:
        return s + ("0" * (n - k))
    # 0 < n ≤ 21: digits with a decimal point after n places.
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    # −6 < n ≤ 0: 0.000… + digits.
    if -6 < n <= 0:
        return "0." + ("0" * (-n)) + s
    # Otherwise exponential, no zero-padded exponent; always e+/e- form.
    exp = n - 1
    mant = s if k == 1 else f"{s[0]}.{s[1:]}"
    if exp >= 0:
        return f"{mant}e+{exp}"
    return f"{mant}e{exp}"


def js_format_number(value: float | int) -> str:
    """ECMAScript Number::toString (radix 10) / JSON number spelling.

    Finite numbers only. Sign, then notation by decimal exponent band:
    decimal when −7 < k < 21 (i.e. 1e-6 … just below 1e21); otherwise
    exponent form with bare (unpadded) exponents.
    """
    if isinstance(value, bool):
        raise TypeError("bool is not a JSON number")
    if isinstance(value, int):
        if value == 0:
            return "0"
        # Pure Python ints in the safe range (and any int that is exactly a
        # safe float) print as bare decimal — matching JSON.stringify of the
        # corresponding IEEE value.
        if abs(value) <= _MAX_SAFE_INTEGER:
            return str(value)
        # Larger ints: spell as the float Node would see (f64 round-trip).
        value = float(value)
    if math.isnan(value) or math.isinf(value):
        raise ValueError("js_format_number requires a finite number")
    if value == 0.0:
        return "0"
    sign = "-" if value < 0.0 else ""
    abs_value = abs(value)
    # Safe-integer integrals: bare digits (1.0 → "1").
    if abs_value == math.trunc(abs_value) and abs_value <= _MAX_SAFE_INTEGER:
        return sign + str(int(abs_value))
    s, n = _ecma_components_from_repr(abs_value)
    return sign + _js_format_ecma_digits(s, n)


# Max array-index property name: ToUint32 bound excluding 2^32-1
# (ECMA-262 IsArrayIndex / OrdinaryOwnPropertyKeys).
_MAX_ARRAY_INDEX = 2**32 - 2  # 4294967294


def _is_js_array_index_key(key: str) -> bool:
    """True iff *key* is a canonical array-index property name.

    Canonical *ASCII* decimal spelling of an integer in ``0 .. 2**32-2`` only:
    ``"0"``, ``"1"``, …, ``"4294967294"``. Leading zeros (``"01"``),
    ``"4294967295"``, signs, fractions, scientific forms, and non-ASCII digit
    characters (e.g. Arabic-Indic ``"١"``, which Python ``str.isdigit()``
    accepts) are ordinary string keys (JSON.stringify insertion-order group).

    Digit check is ASCII ``'0'..'9'`` only — not ``str.isdigit()`` — matching
    ECMA-262 array-index / ``ToString(ToUint32(n))`` canonical spelling.
    """
    if key == "0":
        return True
    if not key or key[0] == "0":
        return False
    # ASCII decimal digits only. ``str.isdigit()`` is wrong here: it accepts
    # Unicode Nd (and some other) characters that are not JS array-index keys.
    if not all("0" <= c <= "9" for c in key):
        return False
    # Digit length > 10 cannot be ≤ 4294967294; len==10 still needs the bound.
    if len(key) > 10:
        return False
    return int(key) <= _MAX_ARRAY_INDEX


def _js_json_object_items(value: dict) -> list[tuple[str, object]]:
    """Object entries in JSON.stringify / OrdinaryOwnPropertyKeys order.

    1. Array-index keys ascending by numeric value.
    2. Remaining string keys in insertion order.

    Shared by compact and pretty writers so capture-side compact dumps and
    retrieval-side pretty dumps cannot drift on key order.
    """
    index_items: list[tuple[int, str, object]] = []
    ordinary: list[tuple[str, object]] = []
    for key, item in value.items():
        skey = str(key)
        if _is_js_array_index_key(skey):
            index_items.append((int(skey), skey, item))
        else:
            ordinary.append((skey, item))
    index_items.sort(key=lambda t: t[0])
    return [(s, v) for _, s, v in index_items] + ordinary


def _write_json(value: object) -> str:
    """Compact JSON writer with JS number spelling (no spaces)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return js_format_number(value)
    if isinstance(value, float):
        return js_format_number(value)
    if isinstance(value, str):
        # serde_json / JSON.stringify string escaping; non-ASCII raw.
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_write_json(item) for item in value) + "]"
    if isinstance(value, dict):
        parts: list[str] = []
        for key, item in _js_json_object_items(value):
            parts.append(json.dumps(key, ensure_ascii=False) + ":" + _write_json(item))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


_PRETTY_INDENT = "  "  # JSON.stringify space=2


def _write_json_pretty(value: object, depth: int = 0) -> str:
    """Pretty JSON writer matching ``JSON.stringify(value, null, 2)``.

    Same leaf spelling as :func:`_write_json` (ECMAScript numbers, raw
    non-ASCII, JSON.stringify key order via :func:`_js_json_object_items`).
    Empty objects/arrays stay compact (``{}`` / ``[]``); non-empty containers
    place each element on its own line with two-space indent per depth, and
    ``": "`` after object keys.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return js_format_number(value)
    if isinstance(value, float):
        return js_format_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        if len(value) == 0:
            return "[]"
        inner = depth + 1
        pad = _PRETTY_INDENT * inner
        close = _PRETTY_INDENT * depth
        lines = [
            pad + _write_json_pretty(item, inner) + ("," if i + 1 < len(value) else "")
            for i, item in enumerate(value)
        ]
        return "[\n" + "\n".join(lines) + "\n" + close + "]"
    if isinstance(value, dict):
        if len(value) == 0:
            return "{}"
        items = _js_json_object_items(value)
        inner = depth + 1
        pad = _PRETTY_INDENT * inner
        close = _PRETTY_INDENT * depth
        lines: list[str] = []
        for i, (key, item) in enumerate(items):
            key_json = json.dumps(key, ensure_ascii=False)
            comma = "," if i + 1 < len(items) else ""
            lines.append(
                pad + key_json + ": " + _write_json_pretty(item, inner) + comma
            )
        return "{\n" + "\n".join(lines) + "\n" + close + "}"
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def js_json_dumps(value: object) -> str:
    """JSON.stringify-compatible compact dump (no spaces, ensure_ascii=False).

    Number leaves use ECMAScript Number::toString spelling (see
    js_format_number). Object keys follow JSON.stringify order: canonical
    array-index names (0..2^32-2) ascending, then other keys in insertion
    order (see :func:`_js_json_object_items`).
    """
    return _write_json(js_json_normalize(value))


def js_json_dumps_pretty(value: object) -> str:
    """``JSON.stringify(value, null, 2)`` — pretty dump with JS number spelling.

    Same leaf and key-order contract as :func:`js_json_dumps` (ECMAScript
    Number::toString, array-index keys first, non-ASCII raw). Indentation and
    ``": "`` spacing match Node's two-space pretty form. Used by retrieval
    ``_verbatim_text`` for tool_call arguments (and other pretty
    ``JSON.stringify`` paths).
    """
    return _write_json_pretty(js_json_normalize(value), 0)


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


def js_camel_key(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def js_dataclass_json_value(value: object) -> object:
    """Dataclass -> JSON.stringify-shaped value: camelCase keys, None dropped.

    Mirrors how TS serializes the plain metadata/payload objects that the
    Python port models as dataclasses. Shared by durable_work and work_queue
    so the two stored-bytes paths cannot drift.
    """
    from dataclasses import asdict, is_dataclass

    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    if isinstance(value, dict):
        return {
            js_camel_key(str(key)): js_dataclass_json_value(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [js_dataclass_json_value(item) for item in value]
    return value
