# cc-lhc v0.4.3

## Overview

A reliability release from the 0.4.2 gorilla test (interactive and one-shot, on
Claude Code 2.1.280), plus two core queue fixes found in the soak. No thread schema
change (13). cc-lhc's own lineage database gains one column (`rebuild_unaccepted`);
see "Rollback to 0.4.2" before going back.

- **One-shot (`-p`) runs Claude as a plain process** (F1, F8). Stdout is Claude's own
  bytes: no pty warnings, CRLF or cursor escapes, so `--output-format json` parses,
  and a prompt piped on stdin reaches Claude. The child dies with the wrapper
  (parent-death signal on Linux, a watchdog elsewhere). `848d2272`, Windows `89a6900c`.
- **A kill during Smart Compact no longer strands the session** (F2). The rebuild is
  recorded as unaccepted before its transcript is written, and a launch that finds
  one resolves it back to its thread. A record-less rebuild from an older build is
  never auto-linked; the launch lists `cc-lhc --resume` choices, and `-p` prints
  them on stderr and exits 2 instead of exiting 13 silently (mjm). `ba7ef020`,
  `85869155`, `a5c2c995`, `02e5ab6f`.
- **Launch sweep** removes dead owners' runtime descriptors and moves abandoned
  rebuilds aside, and no longer mistakes its own lease for a live owner (F3).
  `cd5315b6`, `d2c49ff0`.
- **Carried background work reports back after Smart Compact** (F4, F4b). A carried
  subagent interrupted at handoff is reported killed with a resume offer; a
  relaunched Monitor's events are delivered once each, it survives later compactions
  as the same process, and it is stopped at session end. `c01d9524`, `c5819a8d`,
  `e823218d`.
- **A too-long rejection continues once** (F5). After Claude rejects a request as too
  long and cc-lhc compacts, it resubmits a labelled continue that names the tool
  calls already run; typing in that window is held and a resend notice shown.
  Never in `-p`. `1a1cc7bb`, `4e5c7dbb`.
- **No silent turn loss in the served view** (F6, all hosts on the core). A chunk
  straddling the smooth band now covers its older members, and any turn no band
  represents gets a gap marker. `8b76c31c`.
- **Torn transcript tails are repaired** (F7). A partial last line is trimmed (saved
  under `torn-lines/`) or completed before resume, only when no other process has the
  file open; the live watcher waits on a partial line instead of degrading. `ed0034b1`.
- **Expired derivation claims are retried, not failed** (f5h, all hosts on the core).
  A claim whose process died mid-derivation goes back to the queue. A clean exit hands
  its claims back, so ordinary one-shot exits never count. Each claim is fenced to its
  attempt, so a slow old holder cannot complete or fail its retry. A second expiry in a
  row fails the derivation as `claim_expired_repeatedly` with a warning in the thread
  log. On open, existing `claim_expired` failures are requeued once. `9eb57849`,
  `afc18110`.
- **Release scripts read the version** from `--version` or `package.json` (bvb).
  `f8674b79`.

## The defects, and where each was reproduced

Per the release standard, each fix was reproduced on the pre-fix build:

- F1–F8: gorilla report on cc-lhc 0.4.2 (2026-09-23), findings table and sections
  1–7; F1 3/3, F2 2/2 tree kills, F3 one descriptor per kill, F4 1/1, F5 1/1, F6
  deterministic (views v71, v80), F7 deterministic (simulated torn line), F8 2/2.
  Build and per-fix repros against the candidate: `BUILD-043.md` (campaign
  cc-lhc-gorilla-20260923).
- F4b: Alder's soak on 0.4.3-local.1, a relaunched Monitor failing re-qualification
  (`launch_not_found`) at the second compaction and outliving the session.
- f5h: Alder's soak one-shot series (10 `claim_expired`, 5/7 recall misses) and the
  t3code steward's live thread (227 `claim_expired` failures, 81 view gaps); on a copy
  of that store the fix requeued all 227 and a drain completed them. Alder's
  old-holder counterexamples (success and failure) failed before the fence.
- Windows: CI run 35915132917 (12 failures per Windows target, one a product defect:
  one-shot kill and parent-death relied on SIGHUP).
- mjm, bvb: hit while qualifying the fixes and building 0.4.3-local.1/.2.

## Compatibility and validation

- Thread schema unchanged (13). cc-lhc's lineage DB adds `rebuild_unaccepted`
  (migrated on first 0.4.3 launch). Work-item payloads gain `claimAttempt` and
  `claimExpired` keys; older builds ignore them.
- Package suites green on `f8674b79`: lhc 948, cc-lhc 1408, claude-lhc 58; typecheck
  and biome clean. Native addon source unchanged since 0.4.2.
- Soak: 0.4.3-local.1 (`b11b8e7a`) from 2026-09-23T19:59Z and 0.4.3-local.2
  (`9b0290b2`) from 23:09Z on the live box, with Alder's soak and reviews.
- Six-platform build and the live turn on the shipped artifact: see "Source and
  artifacts".

## Install or upgrade

Install on Linux or macOS from the checksum-verified GitHub release:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/install.ps1 | iex
```

npm:

```sh
npm install --global cc-lhc@0.4.3
```

Upgrading in place keeps records and config. Running sessions keep their version
until they exit. Do not mix npm-owned and script-owned launchers on the same `PATH`.

## Rollback to 0.4.2

0.4.2 ignores `rebuild_unaccepted`. If a launch names a session it has no alias for,
it re-imports that thread's lineage and promotes the newest row, which after an
interrupted 0.4.3 Smart Compact can be a rebuild that was never accepted. So after
switching back to 0.4.2, run once (Python 3; it ships as a release asset and in
`packages/cc-lhc/scripts/`):

```sh
curl -fsSLO https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/rollback-unaccepted.py
python3 rollback-unaccepted.py --apply
```

It deletes unaccepted lineage rows, moves their transcripts to
`~/.cc-lhc/abandoned-rebuilds/`, and skips threads whose owner is still running.
Without `--apply` it is a dry run. It honours `CC_LHC_HOME` and `CLAUDE_CONFIG_DIR`. 0.4.2's drain also fails an expired claim as
`claim_expired` again; a later 0.4.3 open requeues those once.

## Known limitations

- A record-less rebuilt orphan from 0.4.2 or earlier is not linked automatically;
  pick the thread with `cc-lhc --resume` as the guidance shows.
- The claim hand-back runs on process exit: SIGKILL or a hard crash still leaves a
  claim to expire (and a second in a row fails it).
- Unchanged from 0.4.2: tool-only middle segments of a split turn carry no summary by
  design; family weights are measured constants.
- Not covered by the gorilla test: disk-full, multi-hour sessions, native `/compact`.

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.2)
- Source: LHC main (release cut on `f8674b79`)
- Build run: _pending_; npm package sha256 _pending_
- Live turn on the shipped artifact: _pending_
- Source comparison: [`cc-lhc-v0.4.2...cc-lhc-v0.4.3`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.2...cc-lhc-v0.4.3)
- Release tag: [`cc-lhc-v0.4.3`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.3)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/SHA256SUMS)
- npm: [`cc-lhc@0.4.3`](https://www.npmjs.com/package/cc-lhc/v/0.4.3)
