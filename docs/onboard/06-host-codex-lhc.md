# Host: codex-lhc — RETIRED

**Status: retired 2026-08-06.** The `packages/codex-lhc` TypeScript wrapper was
removed from this repo. Codex integration now lives in a **fork of
`openai/codex` with LHC compiled in-process** via the vendored Rust port
(`lhc-rs`):

- Fork: <https://github.com/liminal-ai/codex-lhc> (local checkout: `/srv/work/codex`, branch `lhc`)
- Adapter crate: `codex-rs/lhc/codex-lhc-host`
- Fork docs: `lhc-docs/README.md` (what/why), `FORK.md` (maintenance contract,
  touchpoint inventory, sync drills), `lhc-docs/INSTALL.md` (build/run)
- Launcher: `~/.local/bin/codex-lhc` runs the fork binary with
  `--enable lhc_capture`; storage under `~/.codex/lhc/`

## Why the wrapper was retired

The wrapper took the outside position: a PTY around the closed `codex` CLI,
watching its rollout JSONL files and respawning the child to swap context on
compact. That pattern remains alive where it is genuinely needed — `cc-lhc`
wraps the closed Claude Code the same way — but Codex is open source, so the
fork integrates LHC natively: in-process capture from Codex's own response
items, LHC replacing native compaction inside both the manual and automatic
paths, and rollout rewrite so live and resumed history match. No file
watching, no respawn swap, no child-process seams.

The wrapper also rotted structurally: upstream Codex reworked its session
storage (rollout migration to the thread-store), which is exactly the format
the wrapper's file-watcher parsed, and the wrapper had already needed compile
repairs against SDK surface changes. It was deleted rather than maintained;
the full implementation remains in git history (last tree at commit
`2f52c47`'s parent lineage — see `git log -- packages/codex-lhc`).

Old wrapper-era threads under `~/.codex-lhc/` are plain LHC sqlite threads,
readable by the SDK directly; nothing depends on the wrapper to read them.
