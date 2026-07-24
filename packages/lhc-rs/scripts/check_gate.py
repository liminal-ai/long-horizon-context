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

Also enforces tripwires:

  - `serde_json::to_string` may appear only in src/shared_tech/js_json.rs
    (persisted/hashed bytes must go through js_json_stringify). Scanned across
    all crate `**/*.rs` (src + tests), not just src/.
  - `serde_json::json!(...).to_string()` (including multiline / paren-balanced
    macro args) is banned crate-wide — same persisted-bytes rule.
  - `rusqlite` may appear only in src/shared_tech/storage.rs (bind via
    SqlParam everywhere else).
"""

from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTIMPL_MARKERS = ("not yet implemented", "phase 2")
JSON_MACRO = "serde_json::json!"


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
    """serde_json::to_string may appear only in src/shared_tech/js_json.rs —
    scanned across the whole crate (src + tests), not just src/."""
    violations = []
    sanctioned = ROOT / "src" / "shared_tech" / "js_json.rs"
    for path in ROOT.rglob("*.rs"):
        if path.resolve() == sanctioned.resolve():
            continue
        # Skip target/ build artifacts
        if "target" in path.parts:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if "serde_json::to_string" in line:
                violations.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()}")
    return violations


def _skip_rust_string(source: str, i: int) -> int:
    """Advance past a Rust string/byte/raw-string starting at source[i]."""
    n = len(source)
    if i >= n:
        return i
    # byte / c strings: b"..." / br#"..." / c"..."
    if source[i] in "bc" and i + 1 < n and source[i + 1] in "\"r":
        i += 1
    if i < n and source[i] == "r":
        i += 1
        hashes = 0
        while i < n and source[i] == "#":
            hashes += 1
            i += 1
        if i >= n or source[i] != '"':
            return i
        i += 1
        closing = '"' + ("#" * hashes)
        j = source.find(closing, i)
        return n if j < 0 else j + len(closing)
    if i < n and source[i] == '"':
        i += 1
        while i < n:
            ch = source[i]
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                return i + 1
            i += 1
        return n
    if i < n and source[i] == "'":
        # char literal — skip roughly
        i += 1
        if i < n and source[i] == "\\":
            i += 2
        elif i < n:
            i += 1
        if i < n and source[i] == "'":
            i += 1
        return i
    return i


def find_json_macro_to_string(source: str) -> list[tuple[int, str]]:
    """Locate `serde_json::json!(...)` expressions immediately serialized with
    `.to_string()`, including multiline macro arguments (paren-balanced).

    Does not ban unrelated `.to_string()`, bare `json!(...)`, or
    `js_json_stringify(&serde_json::json!(...))`.
    """
    hits: list[tuple[int, str]] = []
    n = len(source)
    start = 0
    while True:
        idx = source.find(JSON_MACRO, start)
        if idx < 0:
            break
        i = idx + len(JSON_MACRO)
        while i < n and source[i].isspace():
            i += 1
        if i >= n or source[i] != "(":
            start = idx + len(JSON_MACRO)
            continue
        # Balance parentheses from the opening '(' of json!(...).
        depth = 0
        j = i
        while j < n:
            ch = source[j]
            if ch in "\"'":
                j = _skip_rust_string(source, j)
                continue
            if ch == "r" or (ch in "bc" and j + 1 < n and source[j + 1] in "\"r"):
                # Possible raw/byte string — only treat as string if it looks like one.
                peeked = _skip_rust_string(source, j)
                if peeked != j:
                    j = peeked
                    continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        else:
            start = idx + len(JSON_MACRO)
            continue
        k = j
        while k < n and source[k].isspace():
            k += 1
        if source.startswith(".to_string()", k):
            line_no = source.count("\n", 0, idx) + 1
            snippet = source[idx:k + len(".to_string()")]
            # Collapse whitespace for readable reporting.
            snippet = re.sub(r"\s+", " ", snippet.strip())
            if len(snippet) > 120:
                snippet = snippet[:117] + "..."
            hits.append((line_no, snippet))
        start = j
    return hits


def json_macro_to_string_tripwire() -> list[str]:
    """Ban serde_json::json!(...).to_string() across the crate (src + tests)."""
    violations = []
    for path in ROOT.rglob("*.rs"):
        if "target" in path.parts:
            continue
        text = path.read_text()
        for lineno, snippet in find_json_macro_to_string(text):
            violations.append(f"{path.relative_to(ROOT)}:{lineno}: {snippet}")
    return violations


def rusqlite_tripwire() -> list[str]:
    """rusqlite may appear only in src/shared_tech/storage.rs."""
    violations = []
    sanctioned = ROOT / "src" / "shared_tech" / "storage.rs"
    for path in ROOT.rglob("*.rs"):
        if path.resolve() == sanctioned.resolve():
            continue
        if "target" in path.parts:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if "rusqlite" in line:
                violations.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()}")
    return violations


def _test_json_macro_to_string_detector() -> None:
    """Mutation-test the focused json!.to_string detector (always-run)."""
    bad = [
        'serde_json::json!({"a": 1}).to_string()',
        """serde_json::json!({
            "a": 1,
            "b": {"nested": true}
        })
        .to_string()""",
        'let s = serde_json::json!([1, (2), 3]).to_string();',
        'serde_json::json!({"msg": "has ).to_string() text"}).to_string()',
        """let metadata = serde_json::json!({
            "receipts": [{"messageId": "m1"}],
        })
        .to_string();""",
    ]
    good = [
        'some_string.to_string()',
        'format!("x={}", y)',
        'SqlParam::from(metadata.as_str())',
        'serde_json::json!({"a": 1})',
        'let v = serde_json::json!({"a": 1});',
        'js_json_stringify(&serde_json::json!({"a": 1}))',
        'js_json_stringify(&serde_json::json!({\n  "a": 1\n}))',
        'let x = value.to_string();',
        'err.to_string()',
        # chained method that is not .to_string on the macro result
        'serde_json::json!({"a": 1}).as_object()',
    ]
    for sample in bad:
        hits = find_json_macro_to_string(sample)
        assert hits, f"detector missed bad snippet:\n{sample}"
    for sample in good:
        hits = find_json_macro_to_string(sample)
        assert not hits, f"detector false-positive on:\n{sample}\nhits={hits}"


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

    json_to_string = json_macro_to_string_tripwire()
    if json_to_string:
        print("GATE BLOCKER: serde_json::json!(...).to_string() "
              "(persisted bytes must use js_json_stringify):")
        for v in json_to_string:
            print(f"  {v}")
        return 2

    rusqlite_hits = rusqlite_tripwire()
    if rusqlite_hits:
        print("GATE BLOCKER: rusqlite outside storage.rs "
              "(use SqlParam / storage adapter):")
        for v in rusqlite_hits:
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
    _test_json_macro_to_string_detector()
    sys.exit(classify())
