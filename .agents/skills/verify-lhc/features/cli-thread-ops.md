# CLI thread ops

## Sub-features

- `lhc thread health --home H --thread-id ID [--json]` — read-only derivation report: one line of `ready= pending= failed= blocked= repairable=` counts, or the full report with `--json`. A thread with failures still exits 0.
- `lhc thread export --home H --thread-id ID [--out FILE]` — writes the kept history as one JSON object (`threadId`, `turns`) to stdout or `--out`. With `--out`, stdout is `<path> turns=<n>`.
- Cross-home verbs: `copy` places a thread in another home, and `fork` runs copy, identity note, repair, compact, and bind in that order. Fork skips repair with `--no-repair`, compacts only when the two hosts use different providers (`--compact` forces it, `--no-compact` suppresses it), and binds only alias hosts such as `cc-lhc` and `claude-lhc`.
- In-place verbs: `bind`, `note`, and `repair` update the thread already in `--home`. Full flags: run `node packages/lhc/bin/lhc` with no args.

## How to get to it (user POV)

An operator with a thread home on disk checks or moves threads from a shell, without writing SDK code. Health answers "how many derivations are ready, pending, failed, blocked, or repairable?"; copy and fork answer "move this conversation to another host."

## Driving it with the harness

The round-trip drive already exercises `health` against its seeded home. For manual ops:

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs --keep
node packages/lhc/bin/lhc thread health --home <printed-dir> --thread-id <printed-id>
node packages/lhc/bin/lhc thread export --home <printed-dir> --thread-id <printed-id> --out <printed-dir>/export.json
node packages/lhc/bin/lhc thread health --home <printed-dir> --thread-id th_unknown
node .agents/skills/verify-lhc/helpers/cleanup.mjs <printed-dir>
```

Exit codes: 0 for a successful verb, which prints one stdout line. 2 for a refusal: `thread_not_found` (as in the last health line above), `mid_turn`, `path_exists`, `thread_exists`, `alias_bound_to_other_thread`, `file_bound_host`, `host_schema_behind` (a fork into `codex-lhc` or `grok` while the thread schema is ahead of lhc-rs), `invalid_thread_alias`, or `compact_refused`. 1 for a usage error, such as a missing `--token-family`, and every other failure. No args or `--help` exits 0 and prints the usage block.

## Gotchas

- `--home` is the directory holding `registry.sqlite`, not the thread file and not `threads/`.
- `note`, `repair`, and `fork` require `--token-family` with a known slug (listed in the usage block).
- Only repair calls the model, as its own verb or inside `fork`, when it retries failed derivations. It needs a Claude binary from `--claude-bin`, `LHC_CLAUDE_BIN`, or `~/.local/bin/claude`. Fork's compact does not spawn Claude. Keep verify drives on health, export, copy, bind, and note.
