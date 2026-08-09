"""Behavioral tests for the final-state gate logic.

Imports pure helpers from ``scripts/check_gate.py`` and classification helpers
from ``conftest``. Never reads source text as an oracle.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from conftest import classify_outcome, roots_in_not_implemented

ROOT = Path(__file__).resolve().parent.parent
_CHECK_GATE_PATH = ROOT / "scripts" / "check_gate.py"


def _load_check_gate():
    spec = importlib.util.spec_from_file_location("lhc_py_check_gate", _CHECK_GATE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_check_gate()


# ---------------------------------------------------------------------------
# PORT-GATE parsing
# ---------------------------------------------------------------------------


def test_parse_port_gate_counts_reads_all_buckets() -> None:
    output = """
PORT-GATE passed=10
PORT-GATE notimpl=0
PORT-GATE skipped=2
PORT-GATE wrong=0
PORT-GATE classified=12
"""
    counts = gate.parse_port_gate_counts(output)
    assert counts is not None
    assert counts.passed == 10
    assert counts.notimpl == 0
    assert counts.skipped == 2
    assert counts.wrong == 0
    assert counts.classified == 12


def test_parse_port_gate_counts_missing_summary_returns_none() -> None:
    assert gate.parse_port_gate_counts("no gate here") is None
    assert gate.parse_port_gate_counts("PORT-GATE passed=1\nPORT-GATE wrong=0") is None


def test_parse_port_gate_skips_extracts_nodeid_and_reason() -> None:
    output = """
PORT-GATE skip: tests/test_a.py::test_one :: skipped in TS source (it.skip)
PORT-GATE skip: tests/test_b.py::test_two :: mirrors TS it.skip (upstream-deferred test).
noise
"""
    skips = gate.parse_port_gate_skips(output)
    assert skips == [
        ("tests/test_a.py::test_one", "skipped in TS source (it.skip)"),
        ("tests/test_b.py::test_two", "mirrors TS it.skip (upstream-deferred test)."),
    ]


def test_parse_collected_count() -> None:
    assert gate.parse_collected_count("542 tests collected in 0.5s") == 542
    assert gate.parse_collected_count("1 test collected in 0.01s") == 1
    assert gate.parse_collected_count("nope") is None


# ---------------------------------------------------------------------------
# Intentional skip policy (no frozen count)
# ---------------------------------------------------------------------------


def test_intentional_skip_reason_requires_it_skip_marker() -> None:
    assert gate.is_intentional_skip_reason("skipped in TS source (it.skip)")
    assert gate.is_intentional_skip_reason("mirrors TS it.skip (upstream-deferred test).")
    assert not gate.is_intentional_skip_reason("")
    assert not gate.is_intentional_skip_reason("temporarily broken")
    assert not gate.is_intentional_skip_reason("TODO later")


def test_unexpected_skips_filters_non_mirrors() -> None:
    skips = [
        ("a", "skipped in TS source (it.skip)"),
        ("b", "flaky on CI"),
        ("c", "mirrors TS it.skip"),
    ]
    assert gate.unexpected_skips(skips) == [("b", "flaky on CI")]


# ---------------------------------------------------------------------------
# Final-state verdict
# ---------------------------------------------------------------------------


def _ok_counts(**overrides: int) -> gate.GateCounts:
    base = dict(passed=100, notimpl=0, skipped=2, wrong=0, classified=102)
    base.update(overrides)
    return gate.GateCounts(**base)


def test_evaluate_final_gate_passes_on_clean_receipts() -> None:
    skips = [
        ("t1", "skipped in TS source (it.skip)"),
        ("t2", "mirrors TS it.skip"),
    ]
    verdict = gate.evaluate_final_gate(
        collection_code=0,
        collected=102,
        pytest_code=0,
        counts=_ok_counts(),
        skips=skips,
    )
    assert verdict.ok is True
    assert verdict.messages == ("GATE PASS",)


def test_evaluate_final_gate_fails_collection_errors() -> None:
    verdict = gate.evaluate_final_gate(
        collection_code=2,
        collected=None,
        pytest_code=0,
        counts=None,
        skips=[],
    )
    assert verdict.ok is False
    assert any("collection errors" in m for m in verdict.messages)


def test_evaluate_final_gate_fails_nonzero_pytest_exit() -> None:
    verdict = gate.evaluate_final_gate(
        collection_code=0,
        collected=102,
        pytest_code=1,
        counts=_ok_counts(),
        skips=[
            ("t1", "skipped in TS source (it.skip)"),
            ("t2", "mirrors TS it.skip"),
        ],
    )
    assert verdict.ok is False
    assert any("full pytest exited 1" in m for m in verdict.messages)


def test_evaluate_final_gate_fails_wrong_and_notimpl() -> None:
    verdict = gate.evaluate_final_gate(
        collection_code=0,
        collected=102,
        pytest_code=1,
        counts=_ok_counts(wrong=1, notimpl=2, passed=97, classified=102),
        skips=[
            ("t1", "skipped in TS source (it.skip)"),
            ("t2", "mirrors TS it.skip"),
        ],
    )
    assert verdict.ok is False
    joined = "\n".join(verdict.messages)
    assert "wrong=1" in joined
    assert "notimpl=2" in joined


def test_evaluate_final_gate_fails_classified_mismatch_without_hardcoded_total() -> None:
    # Any collected != classified fails; the gate never asserts a fixed suite size.
    verdict = gate.evaluate_final_gate(
        collection_code=0,
        collected=500,
        pytest_code=0,
        counts=_ok_counts(passed=98, skipped=0, classified=98),
        skips=[],
    )
    assert verdict.ok is False
    assert any("classified 98 != collected 500" in m for m in verdict.messages)


def test_evaluate_final_gate_fails_unexpected_skip_reason() -> None:
    verdict = gate.evaluate_final_gate(
        collection_code=0,
        collected=101,
        pytest_code=0,
        counts=_ok_counts(passed=100, skipped=1, classified=101),
        skips=[("tests/x.py::test_y", "I felt like it")],
    )
    assert verdict.ok is False
    assert any("unexpected skips" in m for m in verdict.messages)


def test_evaluate_final_gate_does_not_hardcode_pass_count() -> None:
    # Growing or shrinking the suite is fine as long as invariants hold.
    for total in (3, 42, 999):
        counts = gate.GateCounts(
            passed=total, notimpl=0, skipped=0, wrong=0, classified=total
        )
        verdict = gate.evaluate_final_gate(
            collection_code=0,
            collected=total,
            pytest_code=0,
            counts=counts,
            skips=[],
        )
        assert verdict.ok is True, total


# ---------------------------------------------------------------------------
# Artifact identity
# ---------------------------------------------------------------------------


def test_absolute_no_symlink_keeps_venv_entrypoint(tmp_path: Path) -> None:
    """Symlink targets must not replace the venv entrypoint path."""
    venv_bin = tmp_path / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    target = tmp_path / "system-python"
    target.write_text("")
    entry = venv_bin / "python3"
    entry.symlink_to(target)
    # Following symlinks collapses to the system binary; the gate must not.
    assert entry.resolve() == target.resolve()
    kept = gate.absolute_no_symlink(entry)
    assert kept == entry.absolute()
    assert kept != target.resolve()


def test_is_expected_venv_executable_rejects_symlink_target_path(tmp_path: Path) -> None:
    venv_bin = tmp_path / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    target = tmp_path / "system-python"
    target.write_text("")
    entry = venv_bin / "python3"
    entry.symlink_to(target)
    assert gate.is_expected_venv_executable(entry, entry) is True
    # The resolved system path is NOT the venv entrypoint.
    assert gate.is_expected_venv_executable(target, entry) is False


def test_prove_artifact_identity_accepts_matching_editable_install(tmp_path: Path) -> None:
    package = tmp_path / "lhc-py"
    venv_python = package / ".venv" / "bin" / "python3"
    venv_root = package / ".venv"
    lhc_init = package / "src" / "lhc" / "__init__.py"
    venv_python.parent.mkdir(parents=True)
    lhc_init.parent.mkdir(parents=True)
    venv_python.write_text("")
    lhc_init.write_text("")

    direct = json.dumps(
        {"url": package.resolve().as_uri(), "dir_info": {"editable": True}}
    )
    identity, failures = gate.prove_artifact_identity(
        executable=venv_python,
        lhc_file=lhc_init,
        direct_url_text=direct,
        expected_executable=venv_python,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
        prefix=venv_root,
        expected_venv=venv_root,
    )
    assert failures == []
    assert identity is not None
    assert identity.direct_url["dir_info"]["editable"] is True
    assert identity.prefix == str(venv_root.absolute())


def test_prove_artifact_identity_rejects_wrong_executable(tmp_path: Path) -> None:
    package = tmp_path / "lhc-py"
    expected = package / ".venv" / "bin" / "python3"
    other = tmp_path / "other-python"
    lhc_init = package / "src" / "lhc" / "__init__.py"
    expected.parent.mkdir(parents=True)
    lhc_init.parent.mkdir(parents=True)
    expected.write_text("")
    other.write_text("")
    lhc_init.write_text("")
    direct = json.dumps(
        {"url": package.resolve().as_uri(), "dir_info": {"editable": True}}
    )
    _identity, failures = gate.prove_artifact_identity(
        executable=other,
        lhc_file=lhc_init,
        direct_url_text=direct,
        expected_executable=expected,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
        prefix=package / ".venv",
        expected_venv=package / ".venv",
    )
    assert any("sys.executable" in f for f in failures)


def test_prove_artifact_identity_rejects_wrong_prefix(tmp_path: Path) -> None:
    package = tmp_path / "lhc-py"
    venv_python = package / ".venv" / "bin" / "python3"
    lhc_init = package / "src" / "lhc" / "__init__.py"
    venv_python.parent.mkdir(parents=True)
    lhc_init.parent.mkdir(parents=True)
    venv_python.write_text("")
    lhc_init.write_text("")
    direct = json.dumps(
        {"url": package.resolve().as_uri(), "dir_info": {"editable": True}}
    )
    _i, failures = gate.prove_artifact_identity(
        executable=venv_python,
        lhc_file=lhc_init,
        direct_url_text=direct,
        expected_executable=venv_python,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
        prefix="/usr",
        expected_venv=package / ".venv",
    )
    assert any("sys.prefix" in f for f in failures)


def test_prove_artifact_identity_rejects_non_editable_or_wrong_url(tmp_path: Path) -> None:
    package = tmp_path / "lhc-py"
    venv_python = package / ".venv" / "bin" / "python3"
    lhc_init = package / "src" / "lhc" / "__init__.py"
    venv_python.parent.mkdir(parents=True)
    lhc_init.parent.mkdir(parents=True)
    venv_python.write_text("")
    lhc_init.write_text("")

    non_editable = json.dumps(
        {"url": package.resolve().as_uri(), "dir_info": {"editable": False}}
    )
    _i, failures = gate.prove_artifact_identity(
        executable=venv_python,
        lhc_file=lhc_init,
        direct_url_text=non_editable,
        expected_executable=venv_python,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
    )
    assert any("PEP 660 editable" in f for f in failures)

    wrong_url = json.dumps(
        {
            "url": (tmp_path / "elsewhere").resolve().as_uri(),
            "dir_info": {"editable": True},
        }
    )
    _i, failures = gate.prove_artifact_identity(
        executable=venv_python,
        lhc_file=lhc_init,
        direct_url_text=wrong_url,
        expected_executable=venv_python,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
    )
    assert any("PEP 660 editable" in f for f in failures)


def test_prove_artifact_identity_rejects_lhc_outside_package_src(tmp_path: Path) -> None:
    package = tmp_path / "lhc-py"
    venv_python = package / ".venv" / "bin" / "python3"
    outsider = tmp_path / "site-packages" / "lhc" / "__init__.py"
    venv_python.parent.mkdir(parents=True)
    outsider.parent.mkdir(parents=True)
    (package / "src" / "lhc").mkdir(parents=True)
    venv_python.write_text("")
    outsider.write_text("")
    direct = json.dumps(
        {"url": package.resolve().as_uri(), "dir_info": {"editable": True}}
    )
    _i, failures = gate.prove_artifact_identity(
        executable=venv_python,
        lhc_file=outsider,
        direct_url_text=direct,
        expected_executable=venv_python,
        expected_lhc_root=package / "src" / "lhc",
        package_root=package,
    )
    assert any("lhc.__file__" in f for f in failures)


# ---------------------------------------------------------------------------
# Exception-chain classification (conftest helpers)
# ---------------------------------------------------------------------------


def test_roots_in_not_implemented_walks_cause_context_and_groups() -> None:
    assert roots_in_not_implemented(NotImplementedError("x")) is True
    assert roots_in_not_implemented(ValueError("nope")) is False

    wrapped = RuntimeError("outer")
    wrapped.__cause__ = NotImplementedError("inner")
    assert roots_in_not_implemented(wrapped) is True

    suppressed = AssertionError("match failed")
    suppressed.__context__ = NotImplementedError("skeleton")
    # __cause__ is None; classifier still walks __context__ (incl. suppressed).
    assert roots_in_not_implemented(suppressed) is True

    group = ExceptionGroup("g", [ValueError("a"), NotImplementedError("b")])
    assert roots_in_not_implemented(group) is True


def test_classify_outcome_keeps_worst_bucket() -> None:
    buckets: dict[str, dict[str, str]] = {
        "passed": {},
        "notimpl": {},
        "wrong": {},
        "skipped": {},
    }
    rank = {"passed": 0, "skipped": 0, "notimpl": 1, "wrong": 2}

    classify_outcome(buckets, "t1", "passed", "call", rank)
    assert "t1" in buckets["passed"]

    classify_outcome(buckets, "t1", "notimpl", "call", rank)
    assert "t1" in buckets["notimpl"]
    assert "t1" not in buckets["passed"]

    # A later milder outcome must not demote wrong/notimpl.
    classify_outcome(buckets, "t1", "passed", "teardown", rank)
    assert "t1" in buckets["notimpl"]
    assert "t1" not in buckets["passed"]

    classify_outcome(buckets, "t1", "wrong", "call", rank)
    assert "t1" in buckets["wrong"]
    assert "t1" not in buckets["notimpl"]


# ---------------------------------------------------------------------------
# Pytest env scrubbing (PYTEST_ADDOPTS / plugins cannot shrink the gate)
# ---------------------------------------------------------------------------


def test_scrub_pytest_env_removes_injection_vars_only() -> None:
    dirty = {
        "PATH": "/usr/bin",
        "HOME": "/tmp/home",
        "PYTEST_ADDOPTS": "--ignore=tests/test_derivation_messages.py",
        "PYTEST_PLUGINS": "hostile_plugin",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "UNRELATED": "keep-me",
    }
    clean = gate.scrub_pytest_env(dirty)
    for key in gate.PYTEST_ENV_SCRUB:
        assert key not in clean
    assert clean["PATH"] == "/usr/bin"
    assert clean["HOME"] == "/tmp/home"
    assert clean["UNRELATED"] == "keep-me"
    # Input mapping is not mutated.
    assert dirty["PYTEST_ADDOPTS"] == "--ignore=tests/test_derivation_messages.py"


def test_scrub_pytest_env_defaults_to_os_environ_copy(monkeypatch) -> None:
    monkeypatch.setenv("PYTEST_ADDOPTS", "--maxfail=1")
    monkeypatch.setenv("PYTEST_PLUGINS", "x")
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    monkeypatch.setenv("LHC_GATE_MARKER", "present")
    clean = gate.scrub_pytest_env()
    assert "PYTEST_ADDOPTS" not in clean
    assert "PYTEST_PLUGINS" not in clean
    assert "PYTEST_DISABLE_PLUGIN_AUTOLOAD" not in clean
    assert clean.get("LHC_GATE_MARKER") == "present"


def test_run_pytest_scrubs_addopts_so_ignore_cannot_drop_modules() -> None:
    """Behavioral: parent PYTEST_ADDOPTS must not shrink gate collection.

    Mirrors the reachable P2: ambient
    ``PYTEST_ADDOPTS='--ignore=tests/test_derivation_messages.py'`` shrinks a
    full suite collect when inherited, but the gate's scrubbed subprocess must
    still see the full collection.
    """
    import subprocess

    collect_args = ["--collect-only", "-q"]
    ignore_opt = "--ignore=tests/test_derivation_messages.py"

    # Baseline under a clean env (same args the gate uses for collection).
    base_code, base_out = gate.run_pytest(collect_args, env=gate.scrub_pytest_env())
    assert base_code == 0, base_out
    baseline = gate.parse_collected_count(base_out)
    assert baseline is not None and baseline > 0

    # Malicious ambient ADDOPTS (+ plugins key) that would drop a whole module.
    dirty = gate.scrub_pytest_env()
    dirty["PYTEST_ADDOPTS"] = ignore_opt
    dirty["PYTEST_PLUGINS"] = "nonexistent_hostile_plugin_must_not_load"
    code, out = gate.run_pytest(collect_args, env=dirty)
    assert code == 0, out
    collected = gate.parse_collected_count(out)
    assert collected == baseline

    # Control: same ADDOPTS without scrubbing shrinks full-suite collection.
    control_env = gate.scrub_pytest_env()
    control_env["PYTEST_ADDOPTS"] = ignore_opt
    raw = subprocess.run(
        [sys.executable, "-m", "pytest", *collect_args],
        cwd=ROOT,
        env=control_env,  # intentionally NOT scrubbed
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    raw_collected = gate.parse_collected_count(raw.stdout)
    assert raw_collected is not None and raw_collected < baseline, raw.stdout
