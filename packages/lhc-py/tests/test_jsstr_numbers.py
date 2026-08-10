"""Byte-parity of js_json_dumps number spelling against a Node oracle fixture.

Fixture: tests/fixtures/jsstr-number-cases.json
Generator: scripts/gen_jsstr_number_fixtures.mjs (node is the oracle).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from lhc.shared_tech._jsstr import js_format_number, js_json_dumps, js_json_dumps_pretty

_FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "jsstr-number-cases.json"


def _load_cases() -> list[dict[str, object]]:
    return json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


def _case_value(case: dict[str, object]) -> object:
    """Re-parse valueJson so the float bits match what Node stringify saw."""
    value_json = case.get("valueJson")
    if isinstance(value_json, str):
        return json.loads(value_json)
    return case["value"]


@pytest.fixture(scope="module")
def cases() -> list[dict[str, object]]:
    loaded = _load_cases()
    assert len(loaded) >= 30, f"fixture unexpectedly small: {len(loaded)}"
    return loaded


def test_fixture_covers_required_boundary_names(cases: list[dict[str, object]]) -> None:
    names = {str(c["name"]) for c in cases}
    required = {
        "1e21",
        "1e-6",
        "1e-7",
        "1e20",
        "1.23456789e23",
        "5e-324",
        "1e22",
        "0.1",
        "max_safe_integer",
        "neg_zero",
        "max_float",
        "nested_object_six",
        "nested_array_six",
    }
    missing = required - names
    assert not missing, f"fixture missing required cases: {sorted(missing)}"
    # At least 20 random floats.
    assert sum(1 for n in names if n.startswith("random_")) >= 20


@pytest.mark.parametrize(
    "case",
    _load_cases(),
    ids=lambda c: str(c["name"]),
)
def test_js_json_dumps_matches_node_oracle(case: dict[str, object]) -> None:
    value = _case_value(case)
    expected = case["expected"]
    assert isinstance(expected, str)
    actual = js_json_dumps(value)
    assert actual == expected, (
        f"case {case['name']}: js_json_dumps({value!r}) = {actual!r}, "
        f"expected {expected!r}"
    )


def test_six_defect_values_named() -> None:
    """Direct pin of the six values that exposed the py defect."""
    assert js_json_dumps(1e21) == "1e+21"
    assert js_json_dumps(1e-6) == "0.000001"
    assert js_json_dumps(1e-7) == "1e-7"
    assert js_json_dumps(1e20) == "100000000000000000000"
    assert js_json_dumps(1.23456789e23) == "1.23456789e+23"
    assert js_json_dumps(5e-324) == "5e-324"


def test_nested_object_and_list_byte_equal() -> None:
    obj = {
        "a": 1e21,
        "b": 1e-6,
        "c": 1e-7,
        "d": 1e20,
        "e": 1.23456789e23,
        "f": 5e-324,
    }
    assert js_json_dumps(obj) == (
        '{"a":1e+21,"b":0.000001,"c":1e-7,"d":100000000000000000000,'
        '"e":1.23456789e+23,"f":5e-324}'
    )
    arr = [1e21, 1e-6, 1e-7, 1e20, 1.23456789e23, 5e-324, -1e21, -1e-7]
    assert js_json_dumps(arr) == (
        "[1e+21,0.000001,1e-7,100000000000000000000,1.23456789e+23,5e-324,"
        "-1e+21,-1e-7]"
    )


def test_js_format_number_neg_zero_and_safe_int() -> None:
    assert js_format_number(-0.0) == "0"
    assert js_format_number(0.0) == "0"
    assert js_format_number(1.0) == "1"
    assert js_format_number(-3.0) == "-3"
    assert js_format_number(9007199254740991) == "9007199254740991"


# ── JSON.stringify object key order (array-index properties first) ──
#
# ECMA-262 OrdinaryOwnPropertyKeys / JSON.stringify:
#   1. integer index keys in ascending numeric order (canonical decimal
#      strings for 0..2^32-2 only — "0", "1", …, "4294967294")
#   2. remaining string keys in insertion order
# Non-canonical spellings ("01", "00", "4294967295", "-1", "1.5") stay ordinary.


def _boundary_key_object() -> dict[str, object]:
    """Insertion order deliberately disagrees with JSON.stringify order."""
    o: dict[str, object] = {}
    o["z"] = 1
    o["10"] = "ten"
    o["2"] = "two"
    o["0"] = "zero"
    o["a"] = 2
    o["01"] = "zo"
    o["4294967294"] = "max"
    o["4294967295"] = "beyond"
    o["-1"] = "neg"
    o["1.5"] = "f"
    return o


# Node JSON.stringify(_boundary_key_object()) — array indices 0,2,10,4294967294
# first ascending; ordinary keys z,a,01,4294967295,-1,1.5 keep insertion order.
_BOUNDARY_KEY_COMPACT_JS = (
    '{"0":"zero","2":"two","10":"ten","4294967294":"max",'
    '"z":1,"a":2,"01":"zo","4294967295":"beyond","-1":"neg","1.5":"f"}'
)

_BOUNDARY_KEY_PRETTY_JS = """\
{
  "0": "zero",
  "2": "two",
  "10": "ten",
  "4294967294": "max",
  "z": 1,
  "a": 2,
  "01": "zo",
  "4294967295": "beyond",
  "-1": "neg",
  "1.5": "f"
}"""


def _nested_array_index_object() -> dict[str, object]:
    nested: dict[str, object] = {}
    nested["10"] = "t"
    nested["2"] = "w"
    nested["0"] = "z"
    nested["ordinary"] = 1
    o: dict[str, object] = {}
    o["z"] = 1
    o["nested"] = nested
    o["1"] = "one"
    return o


_NESTED_ARRAY_INDEX_PRETTY_JS = """\
{
  "1": "one",
  "z": 1,
  "nested": {
    "0": "z",
    "2": "w",
    "10": "t",
    "ordinary": 1
  }
}"""


def test_js_json_dumps_array_index_keys_sorted_first() -> None:
    """Compact writer: canonical array-index keys first, ascending numeric."""
    assert js_json_dumps(_boundary_key_object()) == _BOUNDARY_KEY_COMPACT_JS


def test_js_json_dumps_pretty_array_index_keys_sorted_first() -> None:
    """Pretty writer shares the same JSON.stringify key-order contract."""
    assert js_json_dumps_pretty(_boundary_key_object()) == _BOUNDARY_KEY_PRETTY_JS


def test_js_json_dumps_nested_array_index_keys() -> None:
    """Key reordering is recursive (nested objects)."""
    assert js_json_dumps_pretty(_nested_array_index_object()) == (
        _NESTED_ARRAY_INDEX_PRETTY_JS
    )
    # Compact nested: top-level "1" is array-index → first; nested reorders too.
    assert js_json_dumps(_nested_array_index_object()) == (
        '{"1":"one","z":1,"nested":{"0":"z","2":"w","10":"t","ordinary":1}}'
    )


def test_js_json_dumps_ordinary_keys_keep_insertion_order() -> None:
    """Non-index keys are not alphabetically sorted — insertion order only."""
    assert js_json_dumps({"b": 1, "a": 2}) == '{"b":1,"a":2}'
    assert js_json_dumps({"z": 1, "a": 2, "m": 3}) == '{"z":1,"a":2,"m":3}'


def test_js_json_dumps_pure_array_index_keys_ascending() -> None:
    """Only-index objects sort numerically (not lexicographically: 10 after 2)."""
    assert js_json_dumps({"2": "x", "1": "y", "10": "z"}) == (
        '{"1":"y","2":"x","10":"z"}'
    )


def test_js_json_dumps_boundary_non_index_spellings() -> None:
    """01 / 4294967295 / leading zeros are ordinary keys, not array indices."""
    # "01" stays where inserted relative to ordinary neighbors.
    o: dict[str, object] = {"zzz": 0, "01": 1, "aaa": 2, "00": 3}
    assert js_json_dumps(o) == '{"zzz":0,"01":1,"aaa":2,"00":3}'
    # 4294967295 is 2^32-1 — NOT an array index; 4294967294 is the max index.
    o2: dict[str, object] = {"zzz": 0, "4294967295": 1, "aaa": 2, "4294967294": 3}
    assert js_json_dumps(o2) == '{"4294967294":3,"zzz":0,"4294967295":1,"aaa":2}'


def _unicode_digit_key_object() -> dict[str, object]:
    """Unicode Nd keys interleaved with ASCII index keys (insertion order).

    Arabic-Indic digits (U+0660..U+0669) are ``str.isdigit()`` True in Python
    and ``int()``-parseable, but JS array-index grammar is ASCII decimal only.
    """
    o: dict[str, object] = {}
    o["z"] = 1
    o["١"] = "arabic-1"  # U+0661 — before ASCII "1" in insertion order
    o["1"] = "one"
    o["٢"] = "arabic-2"  # U+0662 — between "1" and "2" in insertion order
    o["2"] = "two"
    o["10"] = "ten"
    o["١٠"] = "arabic-10"  # U+0661 U+0660 — after ASCII "10"
    return o


# Node JSON.stringify: ASCII indices 1,2,10 first; ordinary z,١,٢,١٠ insertion.
_UNICODE_DIGIT_KEY_COMPACT_JS = (
    '{"1":"one","2":"two","10":"ten","z":1,'
    '"١":"arabic-1","٢":"arabic-2","١٠":"arabic-10"}'
)

_UNICODE_DIGIT_KEY_PRETTY_JS = """\
{
  "1": "one",
  "2": "two",
  "10": "ten",
  "z": 1,
  "١": "arabic-1",
  "٢": "arabic-2",
  "١٠": "arabic-10"
}"""


def test_js_json_dumps_unicode_digits_remain_ordinary_keys() -> None:
    """Shared helper: Unicode digit keys must not sort as array indices."""
    payload = _unicode_digit_key_object()
    assert js_json_dumps(payload) == _UNICODE_DIGIT_KEY_COMPACT_JS
    assert js_json_dumps_pretty(payload) == _UNICODE_DIGIT_KEY_PRETTY_JS
    # Explicit order: ASCII indices first; Arabic-Indic keys stay with ordinary
    # insertion (after "z"), never promoted ahead of "z" as numeric indices.
    compact = js_json_dumps(payload)
    assert compact.index('"1"') < compact.index('"z"')
    assert compact.index('"z"') < compact.index('"١"')
    assert compact.index('"١"') < compact.index('"٢"')
    assert compact.index('"٢"') < compact.index('"١٠"')


def test_js_json_dumps_key_order_matches_node_oracle() -> None:
    """Live Node oracle (when available): JSON.stringify of the same shape."""
    import json as _json
    import shutil
    import subprocess

    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    payload = _boundary_key_object()
    # Reconstruct insertion order in Node via successive assignment (Object
    # literal key order would also work, but assignment mirrors the Python dict).
    script = """
const o = {};
const entries = JSON.parse(process.argv[1]);
for (const [k, v] of entries) o[k] = v;
process.stdout.write(JSON.stringify(o));
"""
    entries = _json.dumps(list(payload.items()), ensure_ascii=False)
    proc = subprocess.run(
        ["node", "-e", script, entries],
        check=True,
        capture_output=True,
        text=True,
    )
    node_compact = proc.stdout
    assert node_compact == _BOUNDARY_KEY_COMPACT_JS
    assert js_json_dumps(payload) == node_compact

    script_pretty = """
const o = {};
const entries = JSON.parse(process.argv[1]);
for (const [k, v] of entries) o[k] = v;
process.stdout.write(JSON.stringify(o, null, 2));
"""
    proc_p = subprocess.run(
        ["node", "-e", script_pretty, entries],
        check=True,
        capture_output=True,
        text=True,
    )
    assert js_json_dumps_pretty(payload) == proc_p.stdout
