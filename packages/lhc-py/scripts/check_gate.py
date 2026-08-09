#!/usr/bin/env python3
"""Final-state lhc-py gate — run after every slice.

Usage (authoritative interpreter only):

  /srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py

The gate always invokes pytest via the same ``sys.executable`` that launched
this script. It fails closed unless:

1. Artifact identity is proven (executable, ``lhc.__file__``, PEP 660 editable
   ``direct_url.json``).
2. ``pytest --collect-only`` succeeds.
3. Full ``pytest`` exits 0.
4. PORT-GATE reports ``wrong=0`` and ``notimpl=0``.
5. Every collected test is classified (no silent drops).
6. Every skip is intentional (TS-mirrored ``it.skip`` reason).

Test totals are receipts, never hard-coded pass criteria.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
# Absolute paths without following the venv python symlink to the system
# interpreter. ``Path.resolve()`` would collapse `.venv/bin/python3` →
# `/usr/bin/python3.12` and silently accept a bare system Python.
EXPECTED_EXECUTABLE = (ROOT / ".venv" / "bin" / "python3").absolute()
EXPECTED_VENV = (ROOT / ".venv").absolute()
EXPECTED_LHC_ROOT = (ROOT / "src" / "lhc").resolve()

# Intentional skips are TS ``it.skip`` mirrors. Reasons must carry that marker
# so an accidental bare pytest.skip fails closed without freezing a skip count.
INTENTIONAL_SKIP_MARKERS = ("it.skip",)

# Pytest env vars that inject CLI options or plugin loading into child runs.
# Scrubbed from every gate subprocess so ambient operator env cannot shrink
# collection (e.g. PYTEST_ADDOPTS='--ignore=...') or load hostile plugins.
# Keep this list narrow: only vars that change which tests run or which
# plugins/hooks fire — not general debugging noise.
PYTEST_ENV_SCRUB = (
    "PYTEST_ADDOPTS",
    "PYTEST_PLUGINS",
    "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
)

_COUNT_RE = re.compile(
    r"PORT-GATE (passed|notimpl|skipped|wrong|classified)=(\d+)"
)
_SKIP_RE = re.compile(r"^PORT-GATE skip: (.+?) :: (.*)$")
_COLLECTED_RE = re.compile(r"(\d+) tests? collected")


@dataclass(frozen=True)
class ArtifactIdentity:
    executable: str
    lhc_file: str
    direct_url_raw: str
    direct_url: dict[str, Any]
    prefix: str | None = None


@dataclass(frozen=True)
class GateCounts:
    passed: int
    notimpl: int
    skipped: int
    wrong: int
    classified: int


@dataclass(frozen=True)
class GateVerdict:
    ok: bool
    messages: tuple[str, ...]


def parse_port_gate_counts(output: str) -> GateCounts | None:
    """Parse PORT-GATE count lines. Returns None if the summary is missing."""
    found = {
        key: int(value)
        for key, value in _COUNT_RE.findall(output)
    }
    required = ("passed", "notimpl", "skipped", "wrong", "classified")
    if any(key not in found for key in required):
        return None
    return GateCounts(
        passed=found["passed"],
        notimpl=found["notimpl"],
        skipped=found["skipped"],
        wrong=found["wrong"],
        classified=found["classified"],
    )


def parse_port_gate_skips(output: str) -> list[tuple[str, str]]:
    """Parse ``PORT-GATE skip: nodeid :: reason`` lines in order."""
    skips: list[tuple[str, str]] = []
    for line in output.splitlines():
        match = _SKIP_RE.match(line.strip())
        if match:
            skips.append((match.group(1), match.group(2)))
    return skips


def parse_collected_count(output: str) -> int | None:
    match = _COLLECTED_RE.search(output)
    if match is None:
        return None
    return int(match.group(1))


def is_intentional_skip_reason(reason: str) -> bool:
    """True when the skip reason documents a deliberate TS it.skip mirror."""
    text = reason.strip()
    if not text:
        return False
    return any(marker in text for marker in INTENTIONAL_SKIP_MARKERS)


def unexpected_skips(skips: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Return skips whose reasons are not intentional TS mirrors."""
    return [(nodeid, reason) for nodeid, reason in skips if not is_intentional_skip_reason(reason)]


def evaluate_final_gate(
    *,
    collection_code: int,
    collected: int | None,
    pytest_code: int,
    counts: GateCounts | None,
    skips: list[tuple[str, str]],
) -> GateVerdict:
    """Pure final-state verdict from collection + full-run receipts."""
    messages: list[str] = []

    if collection_code != 0:
        messages.append("GATE FAIL: collection errors (import/syntax/missing-symbol).")
        return GateVerdict(False, tuple(messages))

    if collected is None:
        messages.append("GATE FAIL: could not parse collected test count.")
        return GateVerdict(False, tuple(messages))

    if counts is None:
        messages.append("GATE FAIL: PORT-GATE summary not found (conftest plugin missing?).")
        return GateVerdict(False, tuple(messages))

    if pytest_code != 0:
        messages.append(f"GATE FAIL: full pytest exited {pytest_code} (suite must fully pass).")

    if counts.wrong > 0:
        messages.append(
            f"GATE FAIL: wrong={counts.wrong} (failures not rooted in NotImplementedError)."
        )

    if counts.notimpl > 0:
        messages.append(
            f"GATE FAIL: notimpl={counts.notimpl} (final-state forbids NotImplementedError roots)."
        )

    if counts.classified != collected:
        messages.append(
            f"GATE FAIL: classified {counts.classified} != collected {collected} "
            "— tests are escaping the gate."
        )

    if counts.skipped != len(skips):
        messages.append(
            f"GATE FAIL: skipped count {counts.skipped} != listed skips {len(skips)}."
        )

    bad = unexpected_skips(skips)
    if bad:
        detail = "; ".join(f"{nodeid!r} reason={reason!r}" for nodeid, reason in bad)
        messages.append(f"GATE FAIL: unexpected skips (not TS it.skip mirrors): {detail}")

    if messages:
        return GateVerdict(False, tuple(messages))
    return GateVerdict(True, ("GATE PASS",))


def absolute_no_symlink(path: str | Path) -> Path:
    """Absolute path without following symlinks (keeps ``.venv/bin/python3``)."""
    p = Path(path)
    if not p.is_absolute():
        p = Path.cwd() / p
    # normpath collapses ``.`` / ``..`` but does not resolve symlinks.
    return Path(os.path.normpath(p))


def is_expected_venv_executable(
    executable: str | Path,
    expected_executable: Path = EXPECTED_EXECUTABLE,
) -> bool:
    """True when *executable* is the package venv interpreter entrypoint.

    Compares path identity of the venv entrypoint, not the symlink target.
    Accepts ``python`` / ``python3`` / ``python3.X`` names in the same bin dir.
    """
    actual = absolute_no_symlink(executable)
    expected = absolute_no_symlink(expected_executable)
    if actual == expected:
        return True
    if actual.parent != expected.parent:
        return False
    return actual.name.startswith("python")


def _direct_url_points_at_package(data: dict[str, Any], package_root: Path) -> bool:
    url = data.get("url")
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    if parsed.scheme != "file":
        return False
    # file URLs may be URL-encoded; compare resolved paths.
    path = Path(unquote(parsed.path)).resolve()
    if path != package_root.resolve():
        return False
    dir_info = data.get("dir_info")
    if not isinstance(dir_info, dict):
        return False
    return dir_info.get("editable") is True


def prove_artifact_identity(
    *,
    executable: str | Path,
    lhc_file: str | Path,
    direct_url_text: str,
    expected_executable: Path = EXPECTED_EXECUTABLE,
    expected_lhc_root: Path = EXPECTED_LHC_ROOT,
    package_root: Path = ROOT,
    prefix: str | Path | None = None,
    expected_venv: Path = EXPECTED_VENV,
) -> tuple[ArtifactIdentity | None, list[str]]:
    """Return identity receipt and a list of hard failures (empty => proven)."""
    failures: list[str] = []
    exe = absolute_no_symlink(executable)
    lhc_path = Path(lhc_file).resolve()
    expected_exe = absolute_no_symlink(expected_executable)

    if not is_expected_venv_executable(exe, expected_exe):
        failures.append(
            f"sys.executable is {exe}, expected venv interpreter {expected_exe} "
            "(path identity of the venv entrypoint, not the symlink target)"
        )

    if prefix is not None:
        prefix_path = absolute_no_symlink(prefix)
        expected_prefix = absolute_no_symlink(expected_venv)
        if prefix_path != expected_prefix:
            failures.append(
                f"sys.prefix is {prefix_path}, expected package venv {expected_prefix}"
            )

    try:
        lhc_path.relative_to(expected_lhc_root.resolve())
    except ValueError:
        failures.append(
            f"lhc.__file__ is {lhc_path}, expected under {expected_lhc_root.resolve()}"
        )

    try:
        direct_url = json.loads(direct_url_text)
    except json.JSONDecodeError as exc:
        failures.append(f"direct_url.json is not valid JSON: {exc}")
        direct_url = {}

    if direct_url and not _direct_url_points_at_package(direct_url, package_root):
        failures.append(
            "direct_url.json does not identify PEP 660 editable install from "
            f"{package_root.resolve().as_uri()} (got {direct_url_text!r})"
        )
    elif not direct_url:
        # empty dict from parse failure already recorded; empty string path:
        if not direct_url_text.strip():
            failures.append("direct_url.json is empty")
        elif not failures:
            failures.append(
                "direct_url.json does not identify PEP 660 editable install from "
                f"{package_root.resolve().as_uri()} (got {direct_url_text!r})"
            )

    identity = ArtifactIdentity(
        executable=str(exe),
        lhc_file=str(lhc_path),
        direct_url_raw=direct_url_text,
        direct_url=direct_url if isinstance(direct_url, dict) else {},
        prefix=str(absolute_no_symlink(prefix)) if prefix is not None else None,
    )
    return identity, failures


def load_live_artifact_identity() -> tuple[ArtifactIdentity | None, list[str]]:
    """Import the installed package and prove identity against this tree."""
    # Reject the wrong interpreter before import so the failure names the
    # executable/prefix, not a secondary ModuleNotFoundError.
    early: list[str] = []
    if not is_expected_venv_executable(sys.executable):
        early.append(
            f"sys.executable is {absolute_no_symlink(sys.executable)}, "
            f"expected venv interpreter {absolute_no_symlink(EXPECTED_EXECUTABLE)} "
            "(path identity of the venv entrypoint, not the symlink target)"
        )
    if absolute_no_symlink(sys.prefix) != absolute_no_symlink(EXPECTED_VENV):
        early.append(
            f"sys.prefix is {absolute_no_symlink(sys.prefix)}, "
            f"expected package venv {absolute_no_symlink(EXPECTED_VENV)}"
        )
    if early:
        return None, early

    try:
        import lhc
    except Exception as exc:  # noqa: BLE001 — fail closed with the import error
        return None, [f"failed to import lhc: {exc}"]

    lhc_file = getattr(lhc, "__file__", None)
    if not lhc_file:
        return None, ["lhc.__file__ is missing"]

    try:
        dist = importlib.metadata.distribution("lhc-py")
        direct_url_text = dist.read_text("direct_url.json")
    except Exception as exc:  # noqa: BLE001
        return None, [f"could not read lhc-py direct_url.json: {exc}"]

    if direct_url_text is None:
        return None, ["lhc-py distribution has no direct_url.json (not an editable install?)"]

    return prove_artifact_identity(
        executable=sys.executable,
        lhc_file=lhc_file,
        direct_url_text=direct_url_text,
        prefix=sys.prefix,
    )


def scrub_pytest_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Copy *env* (default: ``os.environ``) with pytest injection vars removed.

    Prevents ambient ``PYTEST_ADDOPTS`` / plugin env from shrinking collection
    or altering hooks for gate subprocesses. Pure and testable.
    """
    clean = dict(os.environ if env is None else env)
    for key in PYTEST_ENV_SCRUB:
        clean.pop(key, None)
    return clean


def run_pytest(
    args: list[str],
    *,
    env: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    """Run pytest under the exact invoking interpreter with a scrubbed env."""
    cmd = [sys.executable, "-m", "pytest", *args]
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        env=scrub_pytest_env(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return proc.returncode, proc.stdout


def _git_receipt() -> list[str]:
    lines: list[str] = []
    repo_root = ROOT.parent.parent if ROOT.parent.name == "packages" else ROOT
    path_scope = ["packages/lhc-py", "docs/worklog/py-wave"]
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if head.returncode == 0:
            lines.append(f"git HEAD: {head.stdout.strip()}")
        else:
            lines.append(f"git HEAD: (unavailable: {head.stderr.strip() or head.returncode})")
        stat = subprocess.run(
            ["git", "diff", "--stat", "--", *path_scope],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if stat.returncode == 0:
            body = (stat.stdout or "").strip() or "(clean under packages/lhc-py docs/worklog/py-wave)"
            lines.append(f"git diff --stat (path-scoped): {body}")
        else:
            lines.append("git diff: (unavailable)")
        # Include untracked path-scoped files (diff --stat omits them).
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all", "--", *path_scope],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        if status.returncode == 0:
            porcelain = (status.stdout or "").rstrip()
            if porcelain:
                lines.append("git status --porcelain (path-scoped):")
                for row in porcelain.splitlines():
                    lines.append(f"  {row}")
            else:
                lines.append(
                    "git status --porcelain (path-scoped): "
                    "(clean under packages/lhc-py docs/worklog/py-wave)"
                )
        else:
            lines.append("git status --porcelain: (unavailable)")
    except OSError as exc:
        lines.append(f"git receipt: (unavailable: {exc})")
    return lines


def main() -> int:
    print("=== lhc-py final-state gate ===")
    print(f"invoking interpreter: {sys.executable}")
    print(f"expected interpreter: {EXPECTED_EXECUTABLE}")

    identity, id_failures = load_live_artifact_identity()
    if identity is not None:
        print(f"sys.executable: {identity.executable}")
        if identity.prefix is not None:
            print(f"sys.prefix: {identity.prefix}")
        print(f"lhc.__file__: {identity.lhc_file}")
        print(f"direct_url.json: {identity.direct_url_raw.strip()}")
    for line in _git_receipt():
        print(line)

    if id_failures:
        for msg in id_failures:
            print(f"GATE FAIL: artifact identity: {msg}")
        return 1
    print("artifact identity: PROVEN (executable + lhc source + PEP 660 editable)")

    collection_code, collection_out = run_pytest(["--collect-only", "-q"])
    if collection_code != 0:
        print(collection_out)
    collected = parse_collected_count(collection_out)
    if collected is not None:
        print(f"collect-only: clean ({collected} tests)" if collection_code == 0 else f"collect-only: FAILED ({collected} tests parsed)")
    else:
        print("collect-only: FAILED (could not parse collected count)")

    if collection_code != 0:
        print("GATE FAIL: collection errors (import/syntax/missing-symbol).")
        return 1

    pytest_code, pytest_out = run_pytest(["-q"])
    counts = parse_port_gate_counts(pytest_out)
    skips = parse_port_gate_skips(pytest_out)

    # Surface diagnostic lines from the plugin.
    for line in pytest_out.splitlines():
        stripped = line.strip()
        if stripped.startswith("PORT-GATE WRONG:") or stripped.startswith("PORT-GATE notimpl:"):
            print(stripped)
        if stripped.startswith("PORT-GATE skip:"):
            print(stripped)

    if counts is None and pytest_code != 0:
        # Still show pytest output when the suite failed before summary.
        print(pytest_out)

    verdict = evaluate_final_gate(
        collection_code=collection_code,
        collected=collected,
        pytest_code=pytest_code,
        counts=counts,
        skips=skips,
    )

    if counts is not None:
        print(
            f"gate: passed={counts.passed} notimpl={counts.notimpl} "
            f"skipped={counts.skipped} wrong={counts.wrong} classified={counts.classified}"
        )
        if skips:
            print(f"intentional skips ({len(skips)}; TS it.skip mirrors):")
            for nodeid, reason in skips:
                print(f"  - {nodeid}: {reason}")

    for msg in verdict.messages:
        print(msg)
    return 0 if verdict.ok else 1


if __name__ == "__main__":
    sys.exit(main())
