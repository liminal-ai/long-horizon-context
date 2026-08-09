"""Pytest configuration + the final-state port gate classifier.

The gate (``scripts/check_gate.py``) requires collection success, full pytest
success, ``wrong=0``, and ``notimpl=0``. This plugin classifies every test
outcome and prints a PORT-GATE summary that the gate parses:

  - passed  : test passed
  - skipped : intentional skips (vitest ``it.skip`` mirrors); listed with reason
  - notimpl : failure/error whose exception chain roots in NotImplementedError
              (final-state forbids these — diagnostic only)
  - WRONG   : failure NOT rooted in NotImplementedError — a real defect

Classification rules: the exception chain is walked through ``__cause__`` AND
``__context__`` — deliberately including suppressed context — so a
``pytest.raises(...)`` match failure that wraps an unexpected
``NotImplementedError`` still classifies as notimpl for diagnosis.
Exception groups are searched recursively. Each test lands in exactly one
bucket (worst outcome wins: wrong > notimpl > passed/skipped).
"""

from __future__ import annotations

import pytest

_gate: dict[str, dict[str, str]] = {"passed": {}, "notimpl": {}, "wrong": {}, "skipped": {}}

_RANK = {"passed": 0, "skipped": 0, "notimpl": 1, "wrong": 2}


def roots_in_not_implemented(exc: BaseException | None) -> bool:
    """True when ``exc`` or any linked cause/context/group member is NIE."""
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


def classify_outcome(
    gate: dict[str, dict[str, str]],
    nodeid: str,
    bucket: str,
    detail: str,
    rank: dict[str, int] | None = None,
) -> None:
    """Place ``nodeid`` in ``bucket``, keeping the worst outcome across phases."""
    ranking = rank if rank is not None else _RANK
    for name, entries in gate.items():
        if nodeid in entries and ranking[name] >= ranking[bucket]:
            return
        entries.pop(nodeid, None)
    gate[bucket][nodeid] = detail


def skip_reason_from_report(
    report: pytest.TestReport,
    call: pytest.CallInfo[None],
) -> str:
    """Extract a human skip reason from a skipped test report."""
    if call.excinfo is not None:
        value = call.excinfo.value
        # pytest.skip raises Skipped with the reason as the message.
        msg = getattr(value, "msg", None)
        if isinstance(msg, str) and msg.strip():
            return msg.strip()
        text = str(value).strip()
        if text:
            return text
    longrepr = report.longrepr
    if isinstance(longrepr, tuple) and len(longrepr) >= 3:
        reason = str(longrepr[2]).strip()
        # pytest often prefixes with "Skipped: "
        if reason.lower().startswith("skipped:"):
            reason = reason.split(":", 1)[1].strip()
        if reason:
            return reason
    if longrepr is not None:
        text = str(longrepr).strip()
        if text:
            return text
    return report.when or "skipped"


def _classify(nodeid: str, bucket: str, detail: str) -> None:
    classify_outcome(_gate, nodeid, bucket, detail)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]):
    outcome = yield
    report = outcome.get_result()
    if report.skipped:
        _classify(item.nodeid, "skipped", skip_reason_from_report(report, call))
    elif report.when == "call" and report.passed:
        _classify(item.nodeid, "passed", "call")
    elif report.failed:
        exc = call.excinfo.value if call.excinfo is not None else None
        bucket = "notimpl" if roots_in_not_implemented(exc) else "wrong"
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
    for nodeid, reason in sorted(_gate["skipped"].items()):
        tr.write_line(f"PORT-GATE skip: {nodeid} :: {reason}")
    for nodeid in sorted(_gate["notimpl"]):
        tr.write_line(f"PORT-GATE notimpl: {nodeid}")
    for nodeid, when in sorted(_gate["wrong"].items()):
        tr.write_line(f"PORT-GATE WRONG: {nodeid} [{when}]")
