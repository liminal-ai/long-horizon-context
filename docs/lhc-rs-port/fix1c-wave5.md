# Wave 5 repair-r1c — preserve SQL indentation at runtime

Resume the Wave 5 Cursor session in FAST MODE
`cursor-grok-4.5-high-fast`. No commit/push.

The r1b encoding in `tests/chunk_compact_recovery.rs` uses:

```rust
"... reason = ? \n\
     WHERE ..."
```

Rust string line continuation consumes the source newline *and leading
whitespace on the next source line*, so this does not preserve the required
five spaces after the runtime `\n`.

Replace only this string expression with an encoding whose runtime bytes are
exactly:

```text
... reason = ? <one space><newline><five spaces>WHERE ...
```

Use `concat!("... reason = ? \n", "     WHERE ...")` or a single-line regular
string with explicit `\n`; do not leave source trailing whitespace. Add no
dependency or test. Prove the runtime byte boundary with a disposable one-line
probe or a temporary isolated assertion, then clean only that exact artifact.
Run fmt/check/gate/prompt checker and trailing-whitespace scan. Expected gate
remains 367/367/367 and otherwise unchanged. Do not touch any other file.
