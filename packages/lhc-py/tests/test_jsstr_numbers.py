"""Byte-parity of js_json_dumps number spelling against a Node oracle fixture.

Fixture: tests/fixtures/jsstr-number-cases.json
Generator: scripts/gen_jsstr_number_fixtures.mjs (node is the oracle).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from lhc.shared_tech._jsstr import js_format_number, js_json_dumps

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
