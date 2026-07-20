"""Pytest configuration + the Phase 1 port gate classifier.

The gate (see docs/lhc-py-port-phase1-brief.md): during the skeleton phase,
every runtime failure/error must root in NotImplementedError. This plugin
classifies each test outcome and prints a PORT-GATE summary block that
scripts/check_gate.py parses:

  - notimpl : failure/error whose exception chain roots in NotImplementedError
              (expected Phase 1 state — skeletons reached)
  - passed  : test passed (legit only if it exercises constants/types alone;
              listed for inspection)
  - skipped : intentional skips (vitest it.skip mirrors + wave deferrals);
              counted so the bucket totals reconcile against collection
  - WRONG   : failure NOT rooted in NotImplementedError — a shape defect
              (bad signature, misnamed field, broken fixture). Fix immediately.

Classification rules: the exception chain is walked through `__cause__` AND
`__context__` — deliberately including suppressed context. Rationale: the
common Phase 1 pattern `pytest.raises(Exception, match="<validation msg>")`
catches the skeleton's NotImplementedError and re-raises a match-failure
AssertionError with context suppressed; that is expected skeleton state, not
a shape defect. The cost is that a hypothetical `raise X from None` that
deliberately swallowed an NIE also reads as notimpl — acceptable, since
Phase 2 flips every NIE to real behavior and retires this classifier anyway.
Exception groups are searched recursively (NIE inside a TaskGroup counts).
Each test lands in exactly one bucket (worst phase wins: wrong > notimpl >
passed).
"""

from __future__ import annotations

import pytest

_gate: dict[str, dict[str, str]] = {"passed": {}, "notimpl": {}, "wrong": {}, "skipped": {}}

_RANK = {"passed": 0, "skipped": 0, "notimpl": 1, "wrong": 2}


def _roots_in_not_implemented(exc: BaseException | None) -> bool:
    seen: set[int] = set()
    stack = [exc]
    while stack:
        e = stack.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        if isinstance(e, NotImplementedError):
            return True
        if isinstance(e, BaseExceptionGroup):
            stack.extend(e.exceptions)
        if e.__cause__ is not None:
            stack.append(e.__cause__)
        elif e.__context__ is not None:
            # Includes suppressed context — see module docstring for why.
            stack.append(e.__context__)
    return False


def _classify(nodeid: str, bucket: str, detail: str) -> None:
    # One bucket per test: keep the worst outcome across setup/call/teardown.
    for name, entries in _gate.items():
        if nodeid in entries and _RANK[name] >= _RANK[bucket]:
            return
        entries.pop(nodeid, None)
    _gate[bucket][nodeid] = detail


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]):
    outcome = yield
    report = outcome.get_result()
    if report.skipped:
        _classify(item.nodeid, "skipped", report.when or "")
    elif report.when == "call" and report.passed:
        _classify(item.nodeid, "passed", "call")
    elif report.failed:
        exc = call.excinfo.value if call.excinfo is not None else None
        bucket = "notimpl" if _roots_in_not_implemented(exc) else "wrong"
        _classify(item.nodeid, bucket, report.when or "")


def pytest_terminal_summary(terminalreporter, exitstatus: int, config: pytest.Config) -> None:
    tr = terminalreporter
    tr.section("PORT-GATE")
    total = sum(len(v) for v in _gate.values())
    tr.write_line(f"PORT-GATE passed={len(_gate['passed'])}")
    tr.write_line(f"PORT-GATE notimpl={len(_gate['notimpl'])}")
    tr.write_line(f"PORT-GATE skipped={len(_gate['skipped'])}")
    tr.write_line(f"PORT-GATE wrong={len(_gate['wrong'])}")
    tr.write_line(f"PORT-GATE classified={total}")
    for nodeid in _gate["passed"]:
        tr.write_line(f"PORT-GATE inspect-pass: {nodeid}")
    for nodeid, when in _gate["wrong"].items():
        tr.write_line(f"PORT-GATE WRONG: {nodeid} [{when}]")
