# cc-lhc v0.2.0

## Overview

`cc-lhc` 0.2.0 is a context-continuity release for long-running Claude Code
sessions. It reworks automatic compaction around settled-turn gating and adds
forward-only interactive handoff, pre-launch compaction for one-shot commands,
protection for live background work, and stronger session, capture, and
recovery guarantees.

This release follows `v0.1.0`. Existing LHC thread data remains append-only and
retrievable. The wrapper may replace the underlying Claude session as context is
compacted, while preserving the LHC thread and its stable `tN`/`mN` addresses.

## Highlights

### Automatic context governance

- Automatic compaction now acts only at a settled Claude turn, never in the
  middle of an agentic turn.
- Provider-reported input usage remains authoritative. Content captured after
  the last provider report is added as a separately labelled estimate rather
  than being presented as provider usage.
- Eligible decisions and completed attempts are bound to durable receipts.
  Replaying an already scheduled receipt cannot start a duplicate automatic
  compact. If receipt storage is unavailable, cc-lhc reports the fault and
  continues with an in-memory receipt rather than stranding an oversized
  session.
- Missing or stale usage falls back to the last valid provider reading plus the
  labelled estimate. It no longer makes an oversized session appear healthy.
- Capture or descriptor trouble is repaired from persisted state where
  possible and reported as health information; it does not silently change the
  user's compact policy.

### Interactive compact and handoff

- Compact and prune now build and start the replacement Claude session before
  switching terminal routing to it.
- Once the replacement has shown that it can run, input, output, retrieval
  binding, and capture move together. The old Claude process is stopped last.
- The handoff is forward-only. A failed candidate is never promoted, and a
  successful switch is never undone by a later cleanup or registry failure.
- Input typed after compaction takes ownership is not buffered or replayed into
  another session. The wrapper drops it and asks the user to resend it, avoiding
  accidental delivery to the wrong Claude session.
- Repeated replacement failures leave the current session usable and visible.
  After a bounded number of failures, cc-lhc raises a persistent compatibility
  warning and relaunches the current session with Claude's native compaction
  available as a survival fallback.
- Confirmed Claude effort and permission mode are preserved across wrapper-owned
  handoffs. Unknown values are not guessed, and permissions are not broadened.

### One-shot commands

- One-shot invocations such as `cc-lhc --resume <id> -p <prompt>` now evaluate
  pressure and, when needed, compact before starting Claude.
- The original prompt is sent once to the rebuilt session. The thread's current
  session advances only after capture observes that session accepting the
  prompt.
- `--print=<prompt>` and `-p=<prompt>` are recognized as one-shot forms and
  contribute their prompt size to the pressure estimate.
- If capture cannot prove a ready, settled snapshot within the bounded startup
  window, the prompt runs once on the existing session instead. It is not
  automatically resent, and a later invocation can compact after capture has
  caught up.

### Live background work protection

- Before an eligible interactive automatic compact, cc-lhc detects open work
  owned by the Claude process, including background agents, background shell
  commands, monitors, workflows, and scheduled wakeups.
- When such work is still open and a terminal operator is present, cc-lhc names
  the work and asks for confirmation before writing compact or handoff state.
  Only an explicit `y` proceeds, after rechecking that the same session is still
  eligible.
- A declined, dismissed, interrupted, or unrenderable prompt changes no durable
  state. The next eligible settled turn may ask again.
- Work closes only from matching terminal evidence or an explicit stop. Elapsed
  wall-clock time alone does not mark a scheduled item complete.

### Resume, lineage, and ownership

- Session aliases now resolve through one host-qualified thread registry. An
  old `--resume` alias lands on the thread's current Claude session.
- All aliases of one LHC thread share one exact process-identity lease, so two
  wrappers cannot concurrently drive the same thread through different session
  IDs.
- Existing lineage is imported on first use. Interrupted pre-0.2.0 handoff
  records are consumed into the forward recovery path rather than restoring an
  older oversized session.
- If a replacement was accepted but the current-session pointer could not be
  written, that acceptance is retained and reconciled on the next launch only
  when the predecessor still matches. Newer accepted state is not overwritten.

### Capture and retrieval

- Rebuilt-session capture verifies the known rollout prefix before accepting
  new records. A missing, changed, reordered, or truncated prefix fails closed
  instead of importing ambiguous history into the canonical event record.
- Capture generations and the thread lease now settle in a defined order on
  normal exit, failed launch, failed replacement startup, and one-shot exit.
  Watchers are not left running after ownership is released.
- Stable retrieval remains available through `get-turns` and `get-messages`.
  Calls remain bound to the exact live wrapper descriptor; malformed, stale, or
  mismatched bindings fail closed before archive access or impression writes.
- Retrieved output remains bounded and supports continuation offsets rather
  than emitting an unbounded terminal payload.

### Native compact summaries

- Wrapper-started Claude children run with Claude's automatic compaction
  disabled while the LHC compact path is healthy.
- If a native Claude compact summary is nevertheless observed—for example from
  manual `/compact` or resumed state—cc-lhc recognizes the current Claude Code
  record shape, captures the summary as one bounded closed turn, and reports
  that native compaction occurred. LHC observation and retrieval continue.
- Repeatedly nonviable rebuilt sessions re-enable native compaction only on the
  explicit survival relaunch described above.

### Large threads and protected tool state

- Large message reads are now paged below SQLite's bound-variable limit. This
  fixes message-read and live-composition failures on threads with roughly
  34,000 or more messages without truncating the canonical records returned.
- Compaction protects unresolved tool-call/tool-result relationships and
  refuses unsafe continuation states. Optional derivation gaps degrade the
  rendered result where safe instead of needlessly making the entire compact
  unavailable.
- Compact installation rechecks and repairs drifted derived state inside the
  transaction, keeping the installed view and continuation receipt coherent.

## Fixed failure modes and recovery changes

- A replacement that dies or never becomes viable stays off-route; terminal
  input and output remain attached to the current session.
- A crash between replacement construction and routing no longer restores an
  obsolete handoff journal. The next launch re-evaluates current captured state
  and continues forward.
- Registry pointer-write failure after a successful switch no longer causes a
  rollback or loses the accepted replacement.
- Capture startup failure for a rebuilt session no longer leaves the existing
  session running without capture.
- Failures before child launch now settle pre-launch capture before releasing
  thread ownership.
- Fast one-shot exit now waits for prompt acceptance and pointer settlement
  before releasing the thread lease.
- Stale or concurrent prompt acceptance cannot advance the thread pointer over
  a newer accepted session.
- Invalid context configuration is reported and falls back to safe built-in
  values instead of silently disabling automatic context management.

## Configuration and compatibility changes

The main defaults are unchanged from `v0.1.0`:

| Setting | Default |
| --- | ---: |
| Automatic compact | on |
| Compact target (`lowerBoundTokens`) | 180,000 tokens |
| Automatic trigger (`upperBoundTokens`) | 360,000 tokens |
| Minimum runway (`minRunwayTokens`) | 50,000 tokens |
| Profile | `continuation` |
| Automatic prune | off |

Configuration precedence remains:

```text
built-in < user config < project config < launch flags / panel edits
```

User configuration is read from
`$XDG_CONFIG_HOME/cc-lhc/config.json` or `~/.config/cc-lhc/config.json`.
Project configuration is `.cc-lhc.json`.

The following experimental controls from `v0.1.0` are no longer accepted:

- `--lhc-no-capture`
- `--lhc-observe-only` and persisted `observeOnly`
- `--lhc-retry-growth-tokens` and persisted `retryGrowthTokens`
- persisted `nativeCompactMode` and `nativeBackstopTokens`

Unknown `--lhc-*` arguments exit with status 2. Unknown or malformed persisted
fields are ignored with a visible fallback notice; remove obsolete fields from
existing configuration files. Use explicit `autoCompact: false`,
`--lhc-auto-compact=off`, or panel command `auto off` when automatic compact
must be disabled.

Existing thread databases continue through the SDK's in-place schema migration,
and legacy session lineage is imported into the alias registry on first use. No
manual data conversion is required. Keep a normal backup before an upgrade if
the state is important; do not copy a live SQLite database without also
following SQLite's snapshot rules.

## Platform and runtime support

The npm package and GitHub release contain prebuilt native identity addons for:

- Linux x64 and ARM64
- macOS x64 and Apple Silicon/ARM64
- Windows x64 and ARM64

No C++ compiler or `node-gyp` is required on a supported client.

Runtime requirements:

- Node.js 24.3 or later
- An installed and authenticated Claude Code CLI

The release was built with Node 24.18.0. Package/install smoke used Node 24.3.0
on Linux and macOS and Node 24.15.0 on Windows. The forward compact path was
exercised against Claude Code 2.1.235 on Linux; the earlier whole-product
baseline remains Claude Code 2.1.226. These are tested baselines, not a strict
upper version pin for Claude Code.

## Install or upgrade

The installers preserve LHC user state and replace only installations they
manage. Do not mix an npm-owned launcher with a script-owned launcher on the
same `PATH`.

### GitHub installer: Linux or macOS

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/install.sh | sh
```

### GitHub installer: Windows PowerShell

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/install.ps1 | iex
```

### npm

```sh
npm install --global cc-lhc@0.2.0
cc-lhc --lhc-help
```

## Manual rollback and uninstall

These are user-invoked operations. cc-lhc does not automatically roll back an
installation.

### Roll back an npm-owned installation

```sh
npm install --global cc-lhc@0.1.0
```

Remove it with:

```sh
npm uninstall --global cc-lhc
```

### Roll back a GitHub-installer-owned installation on Linux or macOS

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/install.sh | sh -s -- --version 0.1.0
```

Uninstall it while preserving `~/.cc-lhc`:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/install.sh | sh -s -- --uninstall
```

### Roll back or uninstall on Windows PowerShell

```powershell
$installer = Join-Path $env:TEMP "cc-lhc-install.ps1"
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/install.ps1 -OutFile $installer
& $installer -Version 0.1.0
```

To uninstall instead:

```powershell
& $installer -Uninstall
```

The managed installers preserve the user state directory. Back up or remove
that state separately only when you explicitly intend to do so.

## Known limitations and validation scope

- Interactive handoff starts a new Claude session from rebuilt history. It is
  not same-agentic-turn continuation, and it does not synthesize a pending tool
  tail into a replacement request.
- Rebuilt sessions omit signed thinking blocks when cc-lhc cannot prove the
  exact prepared-request model identity required for safe signature replay.
  Canonical captured history remains preserved.
- The deep real-PTY compact, resume, recovery, and retrieval exercises for this
  release were run on Linux. The six-target CI matrix compiled and loaded the
  native addon and ran the full cc-lhc suite, package smoke, and standalone
  installer smoke on Linux, macOS, and Windows x64/ARM64; equivalent manual
  interactive compact sessions were not rerun on every native target.
- A requested varied long-thread burn-in was not valid evidence and is not
  claimed as passing. The retained evidence includes focused real-session
  compact and recovery exercises plus deterministic suites, not that burn-in.
- Standalone archives are protected by published SHA-256 checksums and GitHub
  asset digests. This release does not claim platform notarization or an OS
  installer signature.
- Claude Code is a closed, independently updated dependency. A future rollout
  format or process-lifecycle change may require a cc-lhc compatibility update;
  repeated replacement failures are surfaced rather than hidden.

## Source, artifacts, and verification

- Previous release: [`cc-lhc-v0.1.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.1.0)
- Full source comparison: [`cc-lhc-v0.1.0...cc-lhc-v0.2.0`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.1.0...cc-lhc-v0.2.0)
- Release tag: [`cc-lhc-v0.2.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.2.0)
- Exact release source: [`29721eaf0b799fc4f595c638d94176f34652519f`](https://github.com/liminal-ai/long-horizon-context/commit/29721eaf0b799fc4f595c638d94176f34652519f)
- Artifact manifest: [`release-manifest.json`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/release-manifest.json)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.2.0/SHA256SUMS)
- npm: [`cc-lhc@0.2.0`](https://www.npmjs.com/package/cc-lhc/v/0.2.0)
- Six-platform build and package verification: [GitHub Actions run 32320599549](https://github.com/liminal-ai/long-horizon-context/actions/runs/32320599549)
- npm publication: [GitHub Actions run 32321394592](https://github.com/liminal-ai/long-horizon-context/actions/runs/32321394592)

The six native jobs, complete npm-package aggregation, and standalone-release
aggregation passed from the exact release source. The GitHub release contains
six platform archives plus the installers, checksum file, and manifest. All ten
uploaded asset digests were compared with the certified local artifacts.

The public npm tarball is byte-identical to the certified package:

```text
cc-lhc@0.2.0
SHA-256 9698fdefcfa9d40a57e4d6431b0151bf43eb98613b734a47b1c745d4101af894
```

Clean public installs were verified through both npm and the GitHub installer.
The CLI loaded the required native identity addon, exposed retrieval commands,
and installed without invoking a native compiler. GitHub-installer uninstall
preserved the user state directory.
