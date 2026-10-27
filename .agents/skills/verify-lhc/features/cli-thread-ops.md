# CLI thread ops

## Sub-features

- `lhc thread health --home H --thread-id ID [--json]` — read-only thread health.
- `lhc thread export --home H --thread-id ID [--out FILE]` — history export.
- `lhc thread copy|bind|note|repair|fork …` — cross-home moves; `fork` runs copy, identity note, repair, compact, bind. Full flags: run `node packages/lhc/bin/lhc` with no args.

## How to get to it (user POV)

An operator with a thread home on disk checks or moves threads from a shell, without writing SDK code. Health answers "is this thread usable?"; copy/fork answer "move this conversation to another host."

## Driving it with the harness

The round-trip drive already exercises `health` against its seeded home. For manual ops:

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs --keep
node packages/lhc/bin/lhc thread health --home <printed-dir> --thread-id <printed-id>
node packages/lhc/bin/lhc thread export --home <printed-dir> --thread-id <printed-id> --out /tmp/export.jsonl
rm -rf <printed-dir>
```

Exit codes: 0 ok, 2 refused (caller error, e.g. unknown thread), 1 anything else. One line on stdout on success.

## Gotchas

- `--home` is the directory holding `registry.sqlite`, not the thread file and not `threads/`.
- `note`, `repair`, and `fork` require `--token-family` with a known slug (listed in the usage block).
- The CLI builds its own SDK instance per invocation; inference-backed verbs (`repair`, `fork` with compact) need the Claude CLI path flags — keep verify drives on the deterministic SDK path instead.
