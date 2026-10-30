# Compact policy

## Sub-features

- Read: `sdk.threads.getCompactPolicy(ref)` returns `{ trigger, target }` in tokens, or `null` when no host has set one. A new thread reads `null`.
- Write: `sdk.threads.setCompactPolicy(ref, { trigger, target })` stores the pair on the `thread_metadata` row. It refuses non-positive or non-integer values and a target at or above the trigger with `invalid_compact_policy`, and leaves the stored pair unchanged.
- Copy: `copyThread` copies the whole file, so the copy carries the pair.
- Migrate: thread schema 14 adds the `compact_trigger_tokens` and `compact_target_tokens` columns. A schema-13 file migrates on its first open and reads `null`.
- Rust hosts: lhc-rs reads schema 13. While the SDK is ahead of it, `lhc thread fork --host codex-lhc|grok` exits 2 with `host_schema_behind` and writes no file.

## How to get to it (user POV)

A host such as claude-lhc sends its compact pair when it creates a thread, and reads the stored pair back on resume. The thread keeps the pair, so a resume or a fork uses the values the thread started with, not the host's current settings.

## Driving it with the harness

```sh
node .agents/skills/verify-lhc/helpers/compact-policy.mjs
```

Pass line: `verify-lhc compact-policy: PASS`. Asserts a new thread reads `null`, the stored pair reads back by file path and by thread id, `target == trigger` is refused without changing the pair, a copy carries the pair, and a fork into `codex-lhc` is refused with no file left behind.

Migrate a real thread file. The helper copies the source with SQLite's backup API from a read-only connection, so the source never changes:

```sh
node .agents/skills/verify-lhc/helpers/compact-policy.mjs --migrate ~/.t3code-lhc/threads/<id>.sqlite
```

Pass line: `verify-lhc compact-policy migrate: PASS`. It prints `user_version`, the event count and the `thread_metadata` row before and after the first open, plus `open+migrate ms=<n>`. It asserts the copy reads version 14, the policy is `null`, and the event count matches the source.

## Gotchas

- Never open a file in a live home (`~/.t3code-lhc`, `~/.codex/lhc`) through the SDK or the `lhc` CLI. The first open migrates it in place to the current schema, and an lhc-rs host cannot open a schema-14 file. Use `--migrate`, which works on a copy.
- Pick a source whose `PRAGMA user_version` is 13 (`sqlite3 -readonly <file> 'PRAGMA user_version'`). An older file also passes, but it exercises more migration steps than the 13 to 14 step.
