# claude-lhc v0.1.1

## Summary

A bug-fix release of the Claude LHC sidecar, the process t3code-lhc runs for its
"Claude LHC" provider. It carries the shared LHC core fix from cc-lhc 0.4.4: the
earliest turns of a long thread could disappear from the model's view. There are
no configuration or data changes.

Upgrade if you run Claude LHC threads long enough to be compacted.

## What changed

- **The earliest turns could vanish from the view.** Turns older than everything
  else in the view got no gap marker, and if their summaries were ready but not
  yet grouped with later turns, they were left out entirely. The model then said
  it could not see facts from the start of the thread, and after a later
  compaction could state wrong ones. Now older turns with a ready summary are
  shown when the budget allows, and every turn that still isn't shown is marked
  `turns tA–tB not in view; use get-turns`, one marker per run of missing turns,
  counted against the view's size. The turns themselves were never lost; they
  stayed retrievable throughout.

## Upgrading

- **t3code-lhc:** the sidecar version is pinned in `lhc-release/sidecar.json`. A
  t3code-lhc build that pins `0.1.1` installs it; nothing else to change.
- **Direct use:** `npm install claude-lhc@0.1.1`.

Threads and records are kept, and nothing on disk changes format.

## Rolling back

Pin `0.1.0` again (or `npm install claude-lhc@0.1.0`). No other step.

## Known limitations

- The fix is in the TypeScript core only. codex-lhc and grok-lhc use the Rust
  port, which gets it in a later release.

## How this release was tested

- The missing earliest turns were reproduced on cc-lhc 0.4.3 by a hands-on macOS
  stress test, and the fix has tests that fail without it, including an
  independent review's reproduction at 30 and 1000 turns.
- The core and claude-lhc test suites pass, and the fix was reviewed
  independently.
- The package builds byte-identical from two clean checkouts (Node 24.18.0,
  npm 11.16.0), installs, and the sidecar starts.

## Source and artifacts

- Source commit: `6fde0146`, the same commit as cc-lhc 0.4.4.
- npm: [`claude-lhc@0.1.1`](https://www.npmjs.com/package/claude-lhc/v/0.1.1),
  tarball sha256 `d8c0a6eceb8924bdb3190c09aa32524687599bb0445ea0d37b6ce62681a5b791`
- Fix commits: `3a7a8e6e`, `1adc6077`.
- Previous: `claude-lhc@0.1.0`, the first npm release (the summary-retry fix, and
  the t3code thread id passed through to Claude's shells).
