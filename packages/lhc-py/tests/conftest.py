"""Pytest configuration + the Phase 1 port gate classifier.

The gate (see docs/lhc-py-port-phase1-brief.md): during the skeleton phase,
every runtime failure/error must root in NotImplementedError. This plugin
classifies each test outcome and prints a PORT-GATE summary block that
scripts/check_gate.py parses:

  - notimpl : failure/error whose exception chain roots in NotImplementedError
              (expected Phase 1 state — skeletons reached)
  - passed  : test passed (legit only if it exercises constants/types alone;
              listed for inspection)
  - WRONG   : failure NOT rooted in NotImplementedError — a shape defect
              (bad signature, misnamed field, broken fixture). Fix immediately.
"""

from __future__ import annotations

import pytest

_gate: dict[str, list[str]] = {"passed": [], "notimpl": [], "wrong": []}


def _roots_in_not_implemented(exc: BaseException | None) -> bool:
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        if isinstance(exc, NotImplementedError):
            return True
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return False


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.passed:
        _gate["passed"].append(item.nodeid)
    elif report.failed:
        exc = call.excinfo.value if call.excinfo is not None else None
        bucket = "notimpl" if _roots_in_not_implemented(exc) else "wrong"
        _gate[bucket].append(f"{item.nodeid} [{report.when}]")


def pytest_terminal_summary(terminalreporter, exitstatus: int, config: pytest.Config) -> None:
    tr = terminalreporter
    tr.section("PORT-GATE")
    tr.write_line(f"PORT-GATE passed={len(_gate['passed'])}")
    tr.write_line(f"PORT-GATE notimpl={len(_gate['notimpl'])}")
    tr.write_line(f"PORT-GATE wrong={len(_gate['wrong'])}")
    for nodeid in _gate["passed"]:
        tr.write_line(f"PORT-GATE inspect-pass: {nodeid}")
    for nodeid in _gate["wrong"]:
        tr.write_line(f"PORT-GATE WRONG: {nodeid}")
