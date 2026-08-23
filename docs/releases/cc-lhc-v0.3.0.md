# cc-lhc v0.3.0

## Overview

`cc-lhc` 0.3.0 makes Long Horizon Context easier to understand and control in
normal Claude Code sessions. It adds a redesigned Control Panel, fixed Band %
allocation presets, the current bounded LHC compact algorithm, clearer
continuity reporting, and recovery when Claude rejects an oversized prompt
before the configured automatic trigger is reached.

The release preserves the settled-turn safety boundary from 0.2.0. It does not
claim same-agentic-turn continuation or replace Claude Code's harness.

## Highlights

### Redesigned Control Panel

- A structured Home screen separates context, capture, allocation, notices,
  commands, and command entry.
- Help, Introduction, Details, and Band allocation are dedicated routes with
  explicit navigation and scope wording.
- Commands use a consistent slash-prefixed interface. Type `/` for suggestions;
  Tab and partial Enter complete commands without executing them.
- The panel remains usable in narrow terminals, exact 20×5 panes, and
  `NO_COLOR=1` environments.
- `/allocation`, `/auto`, and `/bounds` clearly identify their session scope.

### Band % allocation presets

CC-LHC exposes exactly three fixed presets:

| Preset | Low | Medium | High | Full | Intent |
| --- | ---: | ---: | ---: | ---: | --- |
| Default | 20% | 20% | 30% | 30% | Favors recent history |
| Balanced | 25% | 25% | 25% | 25% | Spreads space evenly |
| Historical | 30% | 20% | 30% | 20% | Keeps more older history |

The presets use the current bounded LHC selector. Custom percentage editing is
not exposed in this release.

### Smart Compact continuity and pressure handling

- Smart Compact writes one conservative continuity note when replacement ends
  tracked live work. The note reports only observed outcomes and uses bounded
  counts for long lists.
- Token-dense accepted prompts now contribute a canonical token estimate before
  launch, while replayed or skipped records do not double-count pressure.
- A typed provider `Prompt is too long` rejection can make the next settled
  decision eligible for Smart Compact without changing the configured target,
  trigger, or runway.
- A declined live-work confirmation causes no mutation. A later distinct
  rejection can ask again, and explicit approval performs one forward handoff.
- Zero-usage failures no longer erase the last trustworthy provider-context
  reading.

### Command interface

The primary Control Panel commands are:

```text
/status
/stats
/smart-compact
/smart-prune [tokens]
/export
/auto on|off
/bounds <target> <trigger>
/allocation
/details
/help
/introduction
```

Commands are lowercase and slash-prefixed. Removed unprefixed and legacy
spellings are not aliases.

## Compatibility and validation

- Supported targets: Linux x64/ARM64, macOS x64/ARM64, and Windows x64/ARM64.
- Runtime requirement: Node.js 24.3 or later and an installed, authenticated
  Claude Code CLI.
- Representative real-PTY qualification used Claude Code 2.1.240 on Linux.
- The six-platform workflow compiles and loads the native addon, runs the full
  CC-LHC suite, checks the complete npm package, and exercises compiler-free npm
  and standalone installer smoke.
- The final Default-description adjustment was re-soaked without rerunning the
  unchanged representative model burn-in, as explicitly approved.

## Install or upgrade

Linux or macOS:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.3.0/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.3.0/install.ps1 | iex
```

npm:

```sh
npm install --global cc-lhc@0.3.0
```

Installers preserve LHC state and replace only installations they manage. Do
not mix npm-owned and script-owned launchers on the same `PATH`.

## Known limitations

- Interactive Smart Compact runs only at a settled Claude turn boundary.
- A replacement starts a new Claude session from rebuilt history. CC-LHC does
  not synthesize pending tool state into a replacement provider request.
- Claude Code is independently updated. A future rollout or lifecycle change
  can require a compatibility update; CC-LHC reports repeated replacement
  failures instead of hiding them.
- Manual whole-product interaction was not repeated on every operating system;
  cross-platform qualification uses native CI, package checks, and installer
  smoke on all six supported targets.

## Source and artifacts

- Previous release: [`cc-lhc-v0.2.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.2.0)
- Source comparison: [`cc-lhc-v0.2.0...cc-lhc-v0.3.0`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.2.0...cc-lhc-v0.3.0)
- Release tag: [`cc-lhc-v0.3.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.3.0)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.3.0/SHA256SUMS)
- npm: [`cc-lhc@0.3.0`](https://www.npmjs.com/package/cc-lhc/v/0.3.0)

The GitHub Release body, artifact manifest, workflow links, and published
tarball hash are verified and recorded after promotion.
