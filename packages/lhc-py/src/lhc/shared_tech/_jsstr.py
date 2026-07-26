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
        for key, item in value.items():
            parts.append(json.dumps(str(key), ensure_ascii=False) + ":" + _write_json(item))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def js_json_dumps(value: object) -> str:
    """JSON.stringify-compatible compact dump (no spaces, ensure_ascii=False).

    Number leaves use ECMAScript Number::toString spelling (see
    js_format_number); dict key order is insertion order.
    """
    return _write_json(js_json_normalize(value))


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
