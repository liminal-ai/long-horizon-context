# cc-lhc v0.4.1

## Overview

`cc-lhc` 0.4.1 fixes a defect in how the wrapper records Claude turns that,
on long-running threads, left the Smart Compact view with no smooth band and
no history before the most recent few hundred turns. The fix is on the
capture side only: finished turns are closed when Claude finishes them, and a
long research turn is split at safe exchange boundaries so the compact
selector can band it. Signed thinking blocks in the retained tail are replayed
verbatim.

Nothing in the Smart Compact selection algorithm, the thread schema, or the
native addon changed. A 0.4.1 wrapper reads a 0.4.0 thread as is.

## The defect

Two capture behaviors combined on threads with large research turns:

- **Finished turns stayed open.** A native turn was only closed in the LHC
  record when the next prompt arrived. At compact time the last completed
  turn was still an open turn and had to be kept whole in the full-fidelity
  tail.
- **Giant turns could not be divided.** A single research turn of fifty-plus
  tool calls could reach 50k or more estimated tokens. Whole-turn protection
  then kept it verbatim, and the overrun was charged against the elder bands
  in order: smooth first, then detailed.

On a 70k target with a 21k full share, a 52k retained turn zeroed the smooth
band, cut the detailed band to about one thousand tokens, and left brief to
cover the whole history with 14k, which it could not. Two threads observed
this on 0.4.0: a 487-turn steward thread with brief coverage starting at turn
300 and no earlier history, and a builder thread with the same layout. Both
selector layouts were reproduced from the recorded histories, so this is a
capture defect, not a selector defect.

A contributing factor is that thinking blocks with empty text and a long
signature are charged at signature length. That estimate is unchanged in
this release; see Known limitations.

## Highlights

### Completed turns close at completion

- The assistant's terminal line of a native turn now records a canonical
  `turn_end` keyed to the source rollout line
  (`cc-lhc:rollout:<uuid>:0:turn_end`). The turn is closed and bandable
  before the next prompt, and before any compact that runs on it.
- A settled-segment catch-up runs at the Smart Compact seam so a turn that
  finished just before the compact is closed before the view is built.
- Native turn-open and turn-settled lifecycle is unchanged.

### Long turns segment at safe exchanges

- Inside a turn, any tool-result line with no outstanding tool call is an
  exchange candidate. When the active turn's estimated size has passed the
  threshold, capture closes the turn there and opens a new one. Tool-call and
  tool-result pairs are never separated.
- The threshold is half the full-fidelity share of the live lower target:
  10.5k on a 200k model, 27k on a 1M model. It is read at every candidate,
  so a model or policy change applies immediately.
- A segment turn has no prompt of its own. The smooth band renders it in
  full like any other turn. In the detailed band, a middle segment that holds
  only tool traffic compresses to an empty entry, since the detailed band is
  built from prompt and narration and excludes tool detail by design; the
  first and last segments carry the turn there.
- An interrupted or completed native task that left tool calls unanswered no
  longer blocks segmentation of the next task.

### Signed thinking replays verbatim

- The `signed_verbatim` thinking arm is selected. Thinking blocks in the
  retained tail are replayed with their original signatures and reach the
  provider unchanged.

## Compatibility and validation

- Supported targets, runtime requirement, and native addon identity contract
  3 are unchanged from 0.4.0. No addon rebuild is required for this release;
  the wrapper is the only changed component.
- Thread schema unchanged. Records written by 0.4.0 open unmodified.
- Full CC-LHC suite at the release source: 132 files, 1399 passed, 3 skipped.
  Typecheck and workspace build clean.
- Real-SDK replay of one 50-line rollout: baseline one closed segment,
  candidate two closed segments at threshold 10.5k, all tool pairs intact.
- Installed-command burn-in in a disposable home: a research task of five
  sequential Read exchanges, then a one-shot resume that triggered Smart
  Compact. Three closed segments; both retained thinking signatures matched
  the archive, the rebuilt rollout, and the outgoing resumed request; no
  server-side input transformation; the resumed session recalled the task
  without rereading files. Lowered thresholds and excerpt-fallback
  derivations were used for this run.
- Live: the two affected threads were compacted on the fixed build after a
  one-off record repair (not an automatic effect of this release). The
  steward thread's next view at a 180k target landed within 1% of every band
  share: brief 36k, detailed 35.5k, smooth 53.9k, full 52.9k.

## Install or upgrade

Linux or macOS:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.1/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.1/install.ps1 | iex
```

npm:

```sh
npm install --global cc-lhc@0.4.1
```

Installers preserve LHC state and replace only installations they manage. Do
not mix npm-owned and script-owned launchers on the same `PATH`.

## Known limitations

- Middle segments of a split turn contribute nothing to the detailed band
  (see Highlights). The research they hold stays in the smooth band and the
  chunk summaries built from the full renderings.
- Existing oversized turns already in a record are not subdivided. On an
  affected 0.4.0 thread the first compact after upgrade may still move one
  old, huge, completed turn wholly into the smooth band. Later compacts are
  unaffected.
- The threshold is soft. A single exchange larger than the threshold ends the
  segment late; segments never split a tool pair.
- Thinking blocks are still estimated at text plus signature length, which
  overstates provider cost for empty-text signed blocks. A segment can carry
  a large phantom charge. Accounting is unchanged in this release.
- Signed-thinking replay was verified on one account. Provider prefix-binding
  behavior on other accounts is not claimed.
- Catch-up overhead on very long transcripts and net inference cost are
  unmeasured.
- Smart Compact still runs only at a settled Claude turn boundary.
- The 0.4.0 limitations on carried background work apply unchanged.
- No new manual macOS or Windows qualification for this patch; the six-target
  native CI covers them as in 0.4.0.

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.0)
- Source comparison: [`cc-lhc-v0.4.0...cc-lhc-v0.4.1`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.0...cc-lhc-v0.4.1)
- Release tag: [`cc-lhc-v0.4.1`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.1)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.1/SHA256SUMS)
- npm: [`cc-lhc@0.4.1`](https://www.npmjs.com/package/cc-lhc/v/0.4.1)

The GitHub Release body, artifact manifest, workflow links, and published
tarball hash are verified and recorded after promotion.
