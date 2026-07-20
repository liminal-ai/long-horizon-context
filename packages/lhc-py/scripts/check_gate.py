#!/usr/bin/env python3
"""Phase 1 port gate — run after every wave. Exit 0 iff the port is shape-clean.

Usage: uv run python scripts/check_gate.py

Step 1: `pytest --collect-only -q` must succeed (zero import/collection errors).
Step 2: full `pytest -q`; parse the PORT-GATE block emitted by tests/conftest.py.
        Gate passes iff wrong == 0. NotImplementedError-rooted failures are the
        expected Phase 1 state; passing tests are listed for manual inspection.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    code, out = run(["uv", "run", "pytest", "--collect-only", "-q"])
    if code != 0:
        print(out)
        print("GATE FAIL: collection errors (import/syntax/missing-symbol).")
        return 1
    collected = re.search(r"(\d+) tests? collected", out)
    print(f"collect-only: clean ({collected.group(1) if collected else '?'} tests)")

    _, out = run(["uv", "run", "pytest", "-q"])
    counts = {
        k: int(m)
        for k, m in re.findall(r"PORT-GATE (passed|notimpl|skipped|wrong|classified)=(\d+)", out)
    }
    if not counts:
        print(out)
        print("GATE FAIL: PORT-GATE summary not found (conftest plugin missing?).")
        return 1

    for line in out.splitlines():
        if "PORT-GATE inspect-pass:" in line or "PORT-GATE WRONG:" in line:
            print(line.strip())
    print(
        f"gate: passed={counts['passed']} notimpl={counts['notimpl']} "
        f"skipped={counts.get('skipped', 0)} wrong={counts['wrong']}"
    )
    if counts["wrong"] > 0:
        print("GATE FAIL: failures not rooted in NotImplementedError — fix shapes now.")
        return 1
    if collected is not None and counts.get("classified", -1) != int(collected.group(1)):
        print(
            f"GATE FAIL: classified {counts.get('classified')} != collected "
            f"{collected.group(1)} — tests are escaping the gate (unexpected skip/xfail?)."
        )
        return 1
    print("GATE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
