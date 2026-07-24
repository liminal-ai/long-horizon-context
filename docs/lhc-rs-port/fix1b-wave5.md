# Wave 5 repair-r1b — Cargo and whitespace residue

Resume the existing Wave 5 Cursor session. FAST MODE is explicitly
`cursor-grok-4.5-high-fast`. Work in the current uncommitted tree. Do not
commit or push.

The orchestrator's independent pass found two mechanical residues:

1. `Cargo.toml` now repeats `regex = "1"` under `[dev-dependencies]`, although
   `regex` already exists under `[dependencies]` and integration tests can use
   normal dependencies. Remove only the redundant new dev-dependency line so
   Cargo.toml returns byte-identical to baseline `6d77dd6`. Do not change the
   lockfile or any other dependency.
2. `tests/chunk_compact_recovery.rs` has a literal source line ending in a
   trailing space to preserve TS's runtime SQL byte after `reason = ? `. This
   will fail a staged `git diff --check` because the file is untracked. Encode
   the exact runtime SQL bytes without source trailing whitespace—for example,
   a normal string with an explicit `\n` escape or `concat!` fragments. Confirm
   the resulting string still has exactly one space after `?` before the
   newline and the exact TS continuation indentation.

Then scan every untracked Wave 5 Rust file for source trailing whitespace and
fix any other occurrence without changing runtime SQL bytes. Run:

```text
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
rg -n '[ \t]+$' <all untracked Wave 5 Rust files>
```

Expected gate remains `367/367/367`, passed 38, notimpl 297, wrong/suspicious
0, ignored 12. Do not touch the four root files or certified prior-wave files.
You own cleanup only for exact artifacts you create; report paths. No broad
deletion or organization.
