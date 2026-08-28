#!/usr/bin/env python3
"""Phase 2 gate for lhc-rs — run from packages/lhc-rs: python3 scripts/check_gate.py

Buckets every test outcome and verdicts the tree (Python-port playbook,
Rust-adapted):

  BLOCKER    cargo check/build failure — nothing else is trustworthy
  notimpl    test failed by panicking through a `todo!("phase 2")` body
  WRONG      test failed any other way — a real shape/linking defect
  passed     transitional mode (real Phase-2 todos remain): exact-name
             allowlist only (`scripts/gate_allowlist.txt` if present);
             final mode (crate-wide real todo count == 0): every non-ignored
             cargo ok is a pass. A nonempty allowlist in final mode is a
             GATE FAIL (transitional list retired). Target then is exactly
             728 passed / 0 notimpl / 15 ignored / 0 wrong / 0 suspicious.
  ignored    #[ignore] tests, reported for the ledger
  suspicious transitional: cargo ok not on the exact-name allowlist

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
  - Every crate-wide `**/*.rs` fn/method body (excluding target/) that contains
    a real `todo!("phase 2")` token must be exactly that expression
    (optional whitespace / optional trailing `;` only — comments inside the
    body are NOT exact). Every real token must fall inside a recognized body.
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
PHASE2_TODO = 'todo!("phase 2")'
# Original body between `{` / `}` must match: optional ws, todo, optional `;`, optional ws.
_EXACT_PHASE2_BODY_RE = re.compile(r'^\s*todo!\("phase 2"\)\s*;?\s*$')


def run(cmd: list[str]) -> tuple[int, str]:
    # Merge stderr into stdout at the pipe so cargo's "Running <binary>"
    # lines (stderr) stay interleaved with test results (stdout) — binary
    # attribution depends on stream order.
    proc = subprocess.run(
        cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc.returncode, proc.stdout


def parse_allowlist_lines(text: str) -> list[str]:
    """Parse allowlist text; reject duplicate non-comment entries by exact name."""
    entries: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        name = line.strip()
        if not name or name.startswith("#"):
            continue
        if name in seen:
            raise ValueError(f"duplicate allowlist entry: {name}")
        seen.add(name)
        entries.append(name)
    return entries


def load_allowlist() -> list[str]:
    path = ROOT / "scripts" / "gate_allowlist.txt"
    if not path.exists():
        return []
    return parse_allowlist_lines(path.read_text())


def _test_allowlist_duplicate_detector() -> None:
    """Mutation-test duplicate allowlist rejection (always-run)."""
    assert parse_allowlist_lines("a\n# c\nb\n") == ["a", "b"]
    try:
        parse_allowlist_lines("foo\nbar\nfoo\n")
        raise AssertionError("duplicate allowlist entry must raise")
    except ValueError as err:
        assert str(err) == "duplicate allowlist entry: foo", err


def final_mode_rejects_nonempty_allowlist(final_mode: bool, allow: list[str]) -> str | None:
    """Return a GATE FAIL message when final mode still has allowlist entries."""
    if final_mode and allow:
        return (
            "GATE FAIL: final mode forbids a nonempty transitional allowlist "
            f"({len(allow)} non-comment entries in scripts/gate_allowlist.txt); "
            "delete the file or leave only comments"
        )
    return None


def _test_final_mode_nonempty_allowlist_rejection() -> None:
    """Mutation-test final-mode nonempty-allowlist rejection (always-run)."""
    assert final_mode_rejects_nonempty_allowlist(True, []) is None
    assert final_mode_rejects_nonempty_allowlist(False, ["x::y"]) is None
    msg = final_mode_rejects_nonempty_allowlist(True, ["x::y"])
    assert msg is not None and "forbids a nonempty transitional allowlist" in msg, msg
    # Prove the parser still surfaces entries that would trip final mode.
    assert parse_allowlist_lines("# retired\nreintroduced::case\n") == [
        "reintroduced::case"
    ]
    assert (
        final_mode_rejects_nonempty_allowlist(
            True, parse_allowlist_lines("# retired\nreintroduced::case\n")
        )
        is not None
    )


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


def _is_ident_start(ch: str) -> bool:
    return ch.isalpha() or ch == "_"


def _is_ident_continue(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def _skip_block_comment(source: str, i: int) -> int:
    """Advance past a nested `/* ... */` block comment starting at `/*`."""
    n = len(source)
    if i + 1 >= n or source[i : i + 2] != "/*":
        return i
    i += 2
    depth = 1
    while i < n and depth > 0:
        if source[i : i + 2] == "/*":
            depth += 1
            i += 2
            continue
        if source[i : i + 2] == "*/":
            depth -= 1
            i += 2
            continue
        i += 1
    return i


def _skip_rust_whitespace_and_comments(source: str, i: int) -> int:
    """Advance past whitespace, // line comments, and nested /* block comments */."""
    n = len(source)
    while i < n:
        ch = source[i]
        if ch in " \t\r\n":
            i += 1
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            i += 2
            while i < n and source[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            i = _skip_block_comment(source, i)
            continue
        break
    return i


def _is_angle_close(source: str, i: int) -> bool:
    """True if source[i] is a real `>` close for generics (not ->, =>, >=)."""
    if i >= len(source) or source[i] != ">":
        return False
    prev = source[i - 1] if i > 0 else ""
    nxt = source[i + 1] if i + 1 < len(source) else ""
    # `->` / `=>`: `>` is part of the digraph, not a generic closer.
    if prev in "-=":
        return False
    # `>=`: `>` opens the comparison operator.
    if nxt == "=":
        return False
    return True


def _skip_balanced(
    source: str, i: int, open_ch: str, close_ch: str
) -> int:
    """Skip a balanced open...close starting at open_ch; return index after close.

    For `<>`, `>` inside `->`, `=>`, `>=` does not decrement depth (so
    `F: Fn() -> T` bounds stay inside the generic list). `>>` still closes
    two nested levels one `>` at a time.
    """
    n = len(source)
    if i >= n or source[i] != open_ch:
        return i
    depth = 0
    angle = open_ch == "<" and close_ch == ">"
    while i < n:
        ch = source[i]
        if ch in "\"'":
            i = _skip_rust_string(source, i)
            continue
        if ch == "r" or (ch in "bc" and i + 1 < n and source[i + 1] in "\"r"):
            peeked = _skip_rust_string(source, i)
            if peeked != i:
                i = peeked
                continue
        if ch == "/" and i + 1 < n and source[i + 1] in "/*":
            i = _skip_rust_whitespace_and_comments(source, i)
            continue
        if ch == open_ch:
            depth += 1
            i += 1
            continue
        if ch == close_ch:
            if angle and not _is_angle_close(source, i):
                i += 1
                continue
            depth -= 1
            i += 1
            if depth == 0:
                return i
            continue
        i += 1
    return i


def _advance_past_lexical_noise(source: str, i: int) -> int | None:
    """If source[i] starts a string/char/comment, return index after it; else None."""
    n = len(source)
    if i >= n:
        return None
    ch = source[i]
    if ch in "\"'":
        return _skip_rust_string(source, i)
    if ch == "r" or (ch in "bc" and i + 1 < n and source[i + 1] in "\"r"):
        peeked = _skip_rust_string(source, i)
        if peeked != i:
            return peeked
    if ch == "/" and i + 1 < n and source[i + 1] == "/":
        j = i + 2
        while j < n and source[j] != "\n":
            j += 1
        return j
    if ch == "/" and i + 1 < n and source[i + 1] == "*":
        return _skip_block_comment(source, i)
    return None


def find_real_phase2_todo_tokens(source: str) -> list[int]:
    """Start indices of real `todo!(\"phase 2\")` tokens (outside strings/comments)."""
    hits: list[int] = []
    n = len(source)
    i = 0
    while i < n:
        skipped = _advance_past_lexical_noise(source, i)
        if skipped is not None:
            i = skipped
            continue
        if source.startswith(PHASE2_TODO, i) and (
            i == 0 or not _is_ident_continue(source[i - 1])
        ):
            hits.append(i)
            i += len(PHASE2_TODO)
            continue
        i += 1
    return hits


def body_is_exact_phase2_todo(body_inner: str) -> bool:
    """True iff the original body is only todo!(\"phase 2\")[+ optional ;] + ws."""
    return _EXACT_PHASE2_BODY_RE.match(body_inner) is not None


def iter_fn_bodies(source: str) -> list[tuple[int, int, str]]:
    """Return (body_start_line, open_brace_index, body_inner) for each fn/method.

    Brace/string/comment-aware. Skips fn-pointer types (`fn(...)`) and
    semicolon-terminated signatures (trait/extern stubs). Angle-bracket
    balancing ignores `>` in `->` / `=>` / `>=`.
    """
    bodies: list[tuple[int, int, str]] = []
    n = len(source)
    i = 0
    while i < n:
        skipped = _advance_past_lexical_noise(source, i)
        if skipped is not None:
            i = skipped
            continue
        if (
            source.startswith("fn", i)
            and (i == 0 or not _is_ident_continue(source[i - 1]))
            and (i + 2 >= n or not _is_ident_continue(source[i + 2]))
        ):
            j = _skip_rust_whitespace_and_comments(source, i + 2)
            # fn-pointer / bare fn type: `fn (` with no name
            if j < n and source[j] == "(":
                i = j
                continue
            if j >= n or not _is_ident_start(source[j]):
                i += 2
                continue
            # skip name
            j += 1
            while j < n and _is_ident_continue(source[j]):
                j += 1
            j = _skip_rust_whitespace_and_comments(source, j)
            # generics
            if j < n and source[j] == "<":
                j = _skip_balanced(source, j, "<", ">")
                j = _skip_rust_whitespace_and_comments(source, j)
            if j >= n or source[j] != "(":
                i += 2
                continue
            j = _skip_balanced(source, j, "(", ")")
            # skip return type / where until `{` or `;`
            while j < n:
                j = _skip_rust_whitespace_and_comments(source, j)
                if j >= n:
                    break
                if source[j] == "{":
                    open_brace = j
                    after = _skip_balanced(source, j, "{", "}")
                    body_inner = source[open_brace + 1 : after - 1]
                    line_no = source.count("\n", 0, open_brace) + 1
                    bodies.append((line_no, open_brace, body_inner))
                    i = after
                    break
                if source[j] == ";":
                    i = j + 1
                    break
                # advance one token-ish char / skip strings / balanced groups
                skipped_inner = _advance_past_lexical_noise(source, j)
                if skipped_inner is not None:
                    j = skipped_inner
                    continue
                if source[j] == "(":
                    j = _skip_balanced(source, j, "(", ")")
                    continue
                if source[j] == "<":
                    j = _skip_balanced(source, j, "<", ">")
                    continue
                if source[j] == "[":
                    j = _skip_balanced(source, j, "[", "]")
                    continue
                j += 1
            else:
                i += 2
            continue
        i += 1
    return bodies


def find_inexact_phase2_todo_bodies(source: str) -> list[tuple[int, str]]:
    """Bodies with a real todo!(\"phase 2\") token that are not exactly that expr."""
    hits: list[tuple[int, str]] = []
    for line_no, _brace, body in iter_fn_bodies(source):
        if not find_real_phase2_todo_tokens(body):
            continue
        if body_is_exact_phase2_todo(body):
            continue
        snippet = re.sub(r"\s+", " ", body.strip())
        if len(snippet) > 80:
            snippet = snippet[:77] + "..."
        hits.append((line_no, snippet))
    return hits


def iter_rs_files(root: Path) -> list[Path]:
    """Crate-wide `**/*.rs`, excluding only `target/`."""
    files: list[Path] = []
    for path in sorted(root.rglob("*.rs")):
        if "target" in path.parts:
            continue
        files.append(path)
    return files


def exact_phase2_todo_tripwire(
    root: Path | None = None,
) -> tuple[list[str], str]:
    """Crate-wide: real Phase-2 todo bodies must be exact; every token covered.

    Returns (violations, summary) where summary is
    `exact-todo: tokens=N bodies=M covered=N`.
    """
    root = root if root is not None else ROOT
    violations: list[str] = []
    total_tokens = 0
    bodies_with_todo = 0
    covered_tokens = 0

    for path in iter_rs_files(root):
        text = path.read_text()
        try:
            rel = path.relative_to(root)
        except ValueError:
            rel = path
        tokens = find_real_phase2_todo_tokens(text)
        total_tokens += len(tokens)
        bodies = iter_fn_bodies(text)
        covered: set[int] = set()
        for line_no, open_brace, body in bodies:
            body_start = open_brace + 1
            body_end = body_start + len(body)
            in_body = [t for t in tokens if body_start <= t < body_end]
            if not in_body:
                continue
            bodies_with_todo += 1
            covered.update(in_body)
            if not body_is_exact_phase2_todo(body):
                snippet = re.sub(r"\s+", " ", body.strip())
                if len(snippet) > 80:
                    snippet = snippet[:77] + "..."
                violations.append(f"{rel}:{line_no}: {snippet}")
        for t in tokens:
            if t in covered:
                covered_tokens += 1
            else:
                line_no = text.count("\n", 0, t) + 1
                violations.append(
                    f"{rel}:{line_no}: orphan todo!(\"phase 2\") "
                    "(not inside a scanner-recognized fn/method body)"
                )

    summary = (
        f"exact-todo: tokens={total_tokens} bodies={bodies_with_todo} "
        f"covered={covered_tokens}"
    )
    return violations, summary


def _test_exact_phase2_todo_bodies() -> str:
    """Mutation-test the exact-todo scanner (always-run). Returns printable summary."""
    import tempfile

    # (name, sample, expect_exact_ok) — sample must contain exactly one fn body
    # unless noted in specialized cases below.
    cases: list[tuple[str, str, bool]] = [
        (
            "prelude_before_todo",
            'fn f() {\n    let _ = 1;\n    todo!("phase 2")\n}',
            False,
        ),
        (
            "trailing_after_todo",
            'fn f() {\n    todo!("phase 2");\n    let _ = 1;\n}',
            False,
        ),
        (
            "nested_wrapper",
            'fn f() {\n    if true {\n        todo!("phase 2")\n    }\n}',
            False,
        ),
        (
            "comments_line_around_todo",
            'fn f() {\n    // note\n    todo!("phase 2")\n}',
            False,
        ),
        (
            "comments_block_around_todo",
            'fn f() {\n    /* note */ todo!("phase 2")\n}',
            False,
        ),
        (
            "exact_todo",
            'fn f() {\n    todo!("phase 2")\n}',
            True,
        ),
        (
            "exact_todo_semi_ws",
            'pub async fn f(_x: i32) -> i32 {\n\n  todo!("phase 2");\n\n}',
            True,
        ),
        (
            "generic_fn_arrow_bound",
            'fn call<F: Fn() -> i32>(f: F) {\n    todo!("phase 2")\n}',
            True,
        ),
    ]
    passed = 0
    lines: list[str] = []
    for name, sample, expect_ok in cases:
        hits = find_inexact_phase2_todo_bodies(sample)
        ok = (not hits) if expect_ok else bool(hits)
        bodies = iter_fn_bodies(sample)
        assert len(bodies) == 1, f"{name}: expected 1 fn body, got {len(bodies)}"
        helper_ok = body_is_exact_phase2_todo(bodies[0][2])
        assert helper_ok == expect_ok, (
            f"{name}: body_is_exact_phase2_todo={helper_ok} want {expect_ok}"
        )
        tokens = find_real_phase2_todo_tokens(sample)
        assert tokens, f"{name}: expected real todo token(s)"
        assert ok, (
            f"{name}: scanner verdict mismatch expect_ok={expect_ok} hits={hits}"
        )
        passed += 1
        lines.append(f"  PASS {name} (expect_exact={expect_ok})")

    # Decoys: string / nested-block-comment text must not count as a real token.
    decoy_cases: list[tuple[str, str]] = [
        (
            "raw_string_decoy",
            'fn f() {\n    r#"todo!("phase 2")"#\n}',
        ),
        (
            "normal_string_decoy",
            'fn f() {\n    "todo!(\\"phase 2\\")"\n}',
        ),
        (
            "nested_block_comment_decoy",
            'fn before() { todo!("phase 2") }\n'
            '/* todo!("phase 2") /* inner */ */\n'
            'fn after() { todo!("phase 2") }\n',
        ),
    ]
    for name, sample in decoy_cases:
        if name == "nested_block_comment_decoy":
            tokens = find_real_phase2_todo_tokens(sample)
            assert len(tokens) == 2, (
                f"{name}: expected 2 real tokens (decoy ignored), got {tokens!r}"
            )
            hits = find_inexact_phase2_todo_bodies(sample)
            assert not hits, f"{name}: unexpected inexact hits {hits}"
            bodies = iter_fn_bodies(sample)
            assert len(bodies) == 2, f"{name}: expected 2 fn bodies, got {len(bodies)}"
        else:
            tokens = find_real_phase2_todo_tokens(sample)
            assert not tokens, f"{name}: decoy counted as real token: {tokens}"
            hits = find_inexact_phase2_todo_bodies(sample)
            assert not hits, f"{name}: decoy-only body flagged inexact: {hits}"
            bodies = iter_fn_bodies(sample)
            assert len(bodies) == 1, f"{name}: expected 1 fn body, got {len(bodies)}"
        passed += 1
        lines.append(f"  PASS {name}")

    # Fixture-path tripwire: crate-wide scan must catch tests/fixtures/*.rs.
    # Also: directory names like __pycache__/ must NOT weaken Rust .rs scanning
    # (only target/ is excluded). Python -B keeps bytecode out of the tree.
    with tempfile.TemporaryDirectory() as td:
        fake_root = Path(td)
        fixture = fake_root / "tests" / "fixtures" / "foo.rs"
        fixture.parent.mkdir(parents=True)
        fixture.write_text(
            'fn bad() {\n    let _ = 1;\n    todo!("phase 2")\n}\n',
            encoding="utf-8",
        )
        pycache_rs = fake_root / "__pycache__" / "hidden.rs"
        pycache_rs.parent.mkdir(parents=True)
        pycache_rs.write_text(
            'fn hidden_bad() {\n    let _ = 1;\n    todo!("phase 2")\n}\n',
            encoding="utf-8",
        )
        (fake_root / "src").mkdir(exist_ok=True)
        violations, _summary = exact_phase2_todo_tripwire(fake_root)
        assert any(
            "tests/fixtures/foo.rs" in v for v in violations
        ), f"fixture-path tripwire missed tests/fixtures: {violations}"
        passed += 1
        lines.append("  PASS fixture_path_tripwire")
        assert any(
            "__pycache__/hidden.rs" in v for v in violations
        ), f"__pycache__ path must still be scanned: {violations}"
        passed += 1
        lines.append("  PASS pycache_dir_still_scanned")

    total = len(cases) + len(decoy_cases) + 2
    summary = f"exact-todo scanner self-test: PASS ({passed}/{total})"
    return summary + "\n" + "\n".join(lines)


def classify() -> int:
    # Integration fixtures for compact-continuation fault hooks require
    # `test-util` (production builds keep that module feature-gated off).
    code, out = run(["cargo", "check", "--tests", "--features", "test-util", "--quiet"])
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

    # Feature-off structural proof: production consumers cannot name
    # compact_continuation::test_support (trybuild compile-fail).
    code_ff, out_ff = run(["cargo", "test", "--test", "ui_feature_off", "--quiet"])
    if code_ff != 0:
        print(out_ff)
        print("GATE BLOCKER: feature-off test_support compile-fail failed")
        return 2
    print("feature-off test_support: PASS")

    _, out = run(["cargo", "test", "--features", "test-util", "--no-fail-fast"])

    allow = load_allowlist()
    binary = "?"
    results: dict[str, str] = {}  # "binary::test" -> ok|FAILED|ignored
    panics: dict[str, str] = {}  # "binary::test" -> captured stdout section
    cargo_totals: list[tuple[str, int]] = []  # (binary, total run)
    section: str | None = None
    # trybuild's harness test often prints `test ui ...     Checking ...` with
    # the status on a later bare `ok` line (common under RUST_TEST_THREADS=1).
    pending_trybuild: str | None = None

    for line in out.splitlines():
        m = re.match(r"\s*Running (?:unittests )?(\S+)", line)
        if m:
            binary = Path(m.group(1)).stem
            pending_trybuild = None
            continue
        m = re.match(r"\s*Doc-tests (\S+)", line)
        if m:
            # Keep the following `test result: 0 passed` off the prior binary.
            binary = f"doctest_{m.group(1)}"
            pending_trybuild = None
            continue
        # Cargo prints should_panic cases as:
        #   test path::name - should panic ... ok
        # Optional " - should panic" must be accepted or lib totals drift by 1
        # (R6 closing: assemble_result section-cap should_panic).
        m = re.match(
            r"test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored)\b",
            line,
        )
        if m:
            # trybuild prints nested `test tests/ui/foo.rs ... ok` lines that
            # are not cargo test cases — ignore path-shaped names so totals
            # reconcile with cargo's `test result:` line.
            case = m.group(1)
            if "/" in case or case.endswith(".rs"):
                continue
            results[f"{binary}::{case}"] = m.group(2)
            pending_trybuild = None
            section = None
            continue
        m = re.match(r"test (\S+)(?: - should panic)? \.\.\.(?:\s|$)", line)
        if m:
            case = m.group(1)
            if "/" in case or case.endswith(".rs"):
                continue
            # Incomplete status on this line (trybuild parent) — wait for bare ok.
            pending_trybuild = case
            continue
        if pending_trybuild is not None and line.strip() in ("ok", "FAILED", "ignored"):
            results[f"{binary}::{pending_trybuild}"] = line.strip()
            pending_trybuild = None
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

    # Final mode when crate-wide real Phase-2 todo count is zero: every
    # non-ignored cargo ok is a pass (transitional name allowlist retired).
    # While todos remain, keep exact-name allowlist behavior so premature
    # greens are SUSPICIOUS (historical commits may still ship the file).
    _, todo_summary_for_mode = exact_phase2_todo_tripwire()
    m_todo = re.search(r"tokens=(\d+)", todo_summary_for_mode)
    todo_count = int(m_todo.group(1)) if m_todo else -1
    final_mode = todo_count == 0

    if (fail_msg := final_mode_rejects_nonempty_allowlist(final_mode, allow)) is not None:
        print(fail_msg)
        return 1

    buckets: dict[str, list[str]] = {
        "passed": [], "suspicious": [], "notimpl": [], "wrong": [], "ignored": []}
    for name, status in results.items():
        if status == "ignored":
            buckets["ignored"].append(name)
        elif status == "ok":
            if final_mode or any(fnmatch.fnmatch(name, pat) for pat in allow):
                buckets["passed"].append(name)
            else:
                buckets["suspicious"].append(name)
        else:
            panic_text = panics.get(name, "")
            if any(marker in panic_text for marker in NOTIMPL_MARKERS):
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
    if final_mode:
        # Explicit reconciled target — do not replace the transitional list
        # with a broad/prefix wildcard.
        # Prior Phase-2 close: 584. Compact-continuation stack through LIM-63
        # plus LIM-76 selector/continuation work is 728. LIM-77 adds one
        # claim_expired fallback compact test → 729. Tree at the turn-parts
        # port's start already reported 743 (literal had lagged). Turn parts
        # slice 2 (schema v12 / wire / steps / steer) adds 7 → 750;
        # slice 3 (host metadata surface) adds 3 → 753.
        # slice 4 (walk/settle/parts/protection/cap/entry/exclusivity,
        # install drift recompute) adds 26 → 779; slice 5 (TS oracle replay)
        # adds 1 → 780; steward correction (install boundary forward
        # resolution: 2 ported seam tests) → 782. Measured at the LIM-133 base
        # (b408f897) the tree already reported 784 — the literal had lagged by
        # two again. LIM-133 (bounded/non-copying/read-mostly opens) adds 49:
        # thread_validation 15, bounded_projections 20, read_mostly_open 10,
        # validation_no_snapshot 4 → 833. The LIM-133 correction adds 3 more
        # bounded_projections cases (cursor-key, traversed-count and snapshot
        # witnesses; the forged near-cap case became the authentic 2000/2001
        # boundary walk) → 836. Keep this
        # exact-count ledger in lockstep with cargo --features test-util.
        if (
            len(buckets["passed"]) != 836
            or len(buckets["notimpl"]) != 0
            or len(buckets["ignored"]) != 15
            or len(buckets["wrong"]) != 0
            or len(buckets["suspicious"]) != 0
        ):
            print(
                "GATE FAIL: final mode requires "
                "passed=836 notimpl=0 ignored=15 wrong=0 suspicious=0"
            )
            return 1
    print("GATE PASS")
    return 0


if __name__ == "__main__":
    _test_json_macro_to_string_detector()
    _test_allowlist_duplicate_detector()
    _test_final_mode_nonempty_allowlist_rejection()
    print(_test_exact_phase2_todo_bodies())
    todo_hits, todo_summary = exact_phase2_todo_tripwire()
    print(todo_summary)
    if todo_hits:
        print(
            "GATE BLOCKER: crate-wide **/*.rs fn/method body contains "
            "todo!(\"phase 2\") but is not exactly that expression "
            "(or orphan todo outside a recognized body):"
        )
        for v in todo_hits:
            print(f"  {v}")
        sys.exit(2)
    sys.exit(classify())
