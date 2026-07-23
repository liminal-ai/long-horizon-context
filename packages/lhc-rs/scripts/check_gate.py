#!/usr/bin/env python3
"""Phase 1 gate for lhc-rs — run from packages/lhc-rs: python3 scripts/check_gate.py

Buckets every test outcome and verdicts the tree (Python-port playbook,
Rust-adapted):

  BLOCKER    cargo check/build failure — nothing else is trustworthy
  notimpl    test failed by panicking through a `todo!("phase 2")` body (expected)
  WRONG      test failed any other way — a real shape/linking defect, investigate
  passed     allowed only for tests matching scripts/gate_allowlist.txt
             (Wave 0 infrastructure, constants, goldens); any other pass is
             SUSPICIOUS — a skeleton should not satisfy a behavior test
  ignored    #[ignore] tests, reported for the ledger

Reconciliation: classified counts must equal cargo's own totals per binary —
silently-dropped tests were a blind spot in the Python port's first gate.

Also enforces the serialization tripwire: `serde_json::to_string` may appear
only in src/shared_tech/js_json.rs (persisted/hashed bytes must go through
js_json_stringify — see that module's header).
"""

from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTIMPL_MARKERS = ("not yet implemented", "phase 2")


def run(cmd: list[str]) -> tuple[int, str]:
    # Merge stderr into stdout at the pipe so cargo's "Running <binary>"
    # lines (stderr) stay interleaved with test results (stdout) — binary
    # attribution depends on stream order.
    proc = subprocess.run(
        cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc.returncode, proc.stdout


def load_allowlist() -> list[str]:
    path = ROOT / "scripts" / "gate_allowlist.txt"
    if not path.exists():
        return []
    return [
        line.strip()
        for line in path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def serialization_tripwire() -> list[str]:
    violations = []
    for path in (ROOT / "src").rglob("*.rs"):
        if path.name == "js_json.rs":
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if "serde_json::to_string" in line:
                violations.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()}")
    return violations


def classify() -> int:
    code, out = run(["cargo", "check", "--tests", "--quiet"])
    if code != 0:
        print(out)
        print("GATE BLOCKER: cargo check failed")
        return 2

    violations = serialization_tripwire()
    if violations:
        print("GATE BLOCKER: serde_json::to_string outside js_json.rs "
              "(persisted bytes must use js_json_stringify):")
        for v in violations:
            print(f"  {v}")
        return 2

    _, out = run(["cargo", "test", "--no-fail-fast"])

    allow = load_allowlist()
    binary = "?"
    results: dict[str, str] = {}  # "binary::test" -> ok|FAILED|ignored
    panics: dict[str, str] = {}  # "binary::test" -> captured stdout section
    cargo_totals: list[tuple[str, int]] = []  # (binary, total run)
    section: str | None = None

    for line in out.splitlines():
        m = re.match(r"\s*Running (?:unittests )?(\S+)", line)
        if m:
            binary = Path(m.group(1)).stem
            continue
        m = re.match(r"test (\S+) \.\.\. (ok|FAILED|ignored)", line)
        if m:
            # trybuild prints nested `test tests/ui/foo.rs ... ok` lines that
            # are not cargo test cases — ignore path-shaped names so totals
            # reconcile with cargo's `test result:` line.
            case = m.group(1)
            if "/" in case or case.endswith(".rs"):
                continue
            results[f"{binary}::{case}"] = m.group(2)
            section = None
            continue
        m = re.match(r"---- (\S+) stdout ----", line)
        if m:
            section = f"{binary}::{m.group(1)}"
            panics.setdefault(section, "")
            continue
        m = re.match(
            r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored", line)
        if m:
            cargo_totals.append((binary, sum(int(g) for g in m.groups())))
            section = None
            continue
        if section is not None:
            panics[section] = panics[section] + line + "\n"

    buckets: dict[str, list[str]] = {
        "passed": [], "suspicious": [], "notimpl": [], "wrong": [], "ignored": []}
    for name, status in results.items():
        if status == "ignored":
            buckets["ignored"].append(name)
        elif status == "ok":
            if any(fnmatch.fnmatch(name, pat) for pat in allow):
                buckets["passed"].append(name)
            else:
                buckets["suspicious"].append(name)
        else:
            text = panics.get(name, "")
            if any(marker in text for marker in NOTIMPL_MARKERS):
                buckets["notimpl"].append(name)
            else:
                buckets["wrong"].append(name)

    classified = sum(len(v) for v in buckets.values())
    reported = sum(total for _, total in cargo_totals)
    print(f"classified={classified} cargo-reported={reported} "
          f"(binaries: {len(cargo_totals)})")
    print(f"passed={len(buckets['passed'])} suspicious={len(buckets['suspicious'])} "
          f"notimpl={len(buckets['notimpl'])} wrong={len(buckets['wrong'])} "
          f"ignored={len(buckets['ignored'])}")

    for name in buckets["suspicious"]:
        print(f"SUSPICIOUS PASS (not allowlisted): {name}")
    for name in buckets["wrong"]:
        print(f"WRONG: {name}")
        detail = panics.get(name, "").strip()
        if detail:
            print("  " + "\n  ".join(detail.splitlines()[:6]))

    if classified != reported:
        print("GATE FAIL: classification does not reconcile with cargo totals")
        return 1
    if buckets["wrong"] or buckets["suspicious"]:
        print("GATE FAIL")
        return 1
    print("GATE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(classify())
