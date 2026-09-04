# cc-lhc v0.4.0

## Overview

`cc-lhc` 0.4.0 keeps background work alive across Smart Compact. A background
shell, agent, workflow, monitor, or scheduled wakeup that is running when the
Claude Code process is replaced is carried into the replacement session, and
its real outcome is delivered to that session exactly once. The release also
resolves the Smart Compact policy from the active model's reported context
window, removes the Smart Compact disable and confirmation surfaces, and makes
the wrapper silent on Claude's own screen.

The settled-turn safety boundary from 0.2.0 and 0.3.0 is unchanged. Smart
Compact still runs only at a settled Claude turn.

## Highlights

### Background work survives Smart Compact

- Background shells keep running under the replaced Claude process, which is
  retained as their completion host until their results are delivered. Claude's
  own exit marker is the terminal evidence; nothing is inferred from a process
  disappearing.
- Agents and workflows are resumed in the replacement through their supported
  continuation (`SendMessage`, `Workflow resumeFromRunId`). Scheduled wakeups
  are re-armed at their original time. Monitors are relaunched once per
  handoff, with the same logical launch id, and reported as restarted.
- Results are delivered on the next real prompt through a launch-scoped
  `UserPromptSubmit` hook, exactly once, with no provider call and no PTY
  injection while the session is idle.
- A fresh wrapper resuming the same thread seeds the carried work before
  reading new evidence, so results survive wrapper restarts.
- `cc-lhc tasks status|output|stop <launch id>` manages a carried item by its
  durable identity; stale or foreign identities are refused.
- Orderly wrapper exit copies readable output into a CC-LHC-owned artifact
  before removing tracking. User-owned files are never modified.
- Behavior is the same on Linux, macOS, and Windows. The native addon
  (identity contract 3) supplies process pause/resume, exit readback, and
  output-file holder lookup on each platform.

### Model-aware Smart Compact policy

- The context window is read from Claude's status line for the active model.
  A 200k window resolves to target 70k / trigger 140k / runway 40k; a 1M
  window resolves to 180k / 360k / 50k. Anything else falls back to the 200k
  policy and is reported on the panel.
- Switching models re-resolves the policy before the next automatic decision
  and shows one nonblocking notice in the Control Panel.
- Explicit user or project bounds still take precedence over the built-ins.
- An explicit `--autocompact` on the Claude command line produces a truthful
  advisory that native auto-compact may preempt Smart Compact.

### Removed surfaces

- The Smart Compact disable surfaces are gone: `--lhc-auto-compact`, the
  `autoCompact` config field, and the `/auto` panel command. Smart Compact is
  always armed; the trigger and target are the controls.
- The live-work confirmation prompt and Compact-delay grace are gone. Carrying
  work replaces asking about it.

### Quiet wrapper, one-time onboarding

- CC-LHC writes nothing to Claude's screen during normal operation. A
  Control Panel opens on its own only for an actionable condition: a native
  auto-compact conflict, an unsafe capture or database state, repeated
  replacement failure, possibly undelivered input, or unmanageable async
  identity.
- The onboarding Control Panel shows once per onboarding version per
  `CC_LHC_HOME`, built from the resolved policy. Escape returns to Claude; the
  reopen key is shown on the panel.
- Terminal replies to the replacement process during a compact are no longer
  counted as typed input, so a compact no longer opens the resend panel.
- Stopping a rollout tail no longer waits on derivation drain, logs a warning,
  or writes a runtime note into the thread. Derivation finishes on the
  scheduler regardless.
- The post-compact note is one line: `N background process(es) carried over.`

### Truthful identity and terminology

- `cc-lhc --lhc-version` reports the package version and the exact source
  commit stamped at build time from explicit input, never from ambient Git.
  `--version` and everything after `--` are forwarded to Claude verbatim.
- `/status` labels provider-reported context and LHC-estimated tokens as
  distinct measures with no fixed ratio or direction.
- `cc-lhc preview --fixture <name>` renders every Control Panel state from
  production code in a disposable home.

### Command interface

The primary Control Panel commands are:

```text
/status
/stats
/smart-compact
/smart-prune [tokens]
/export
/bounds <target> <trigger>
/allocation
/details
/help
/introduction
```

## Compatibility and validation

- Supported targets: Linux x64/ARM64, macOS x64/ARM64, and Windows x64/ARM64.
- Runtime requirement: Node.js 24.3 or later and an installed, authenticated
  Claude Code CLI.
- Native addon identity contract 3. A 0.3.0 installation cannot load a 0.4.0
  prebuild and vice versa; installers and the npm package ship matching
  prebuilds for all six targets.
- Representative real-PTY qualification used Claude Code 2.1.258 on Linux:
  one-shot launch, onboarding panel, model switch and policy re-resolution,
  background shell carried across a manual Smart Compact with exactly-once
  delivery, orderly exit, and resume in a fresh wrapper.
- The six-platform workflow compiles and loads the native addon, runs the
  real-child process-control tests, runs the full CC-LHC suite, checks the
  complete npm package, and exercises compiler-free npm and standalone
  installer smoke.

## Install or upgrade

Linux or macOS:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.0/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.0/install.ps1 | iex
```

npm:

```sh
npm install --global cc-lhc@0.4.0
```

Installers preserve LHC state and replace only installations they manage. Do
not mix npm-owned and script-owned launchers on the same `PATH`.

## Known limitations

- Smart Compact runs only at a settled Claude turn boundary.
- Carried work depends on unsupported Claude Code behavior: process signals,
  the task output file Claude writes, and the `UserPromptSubmit` hook. A
  Claude Code update can require a compatibility update.
- If the wrapper itself exits while a replaced Claude process is still
  supervising a background shell, that shell's result is not delivered and the
  supervising process is retired on the next orderly exit of the same thread.
- Manual whole-product interaction was performed on Linux; macOS and Windows
  qualification uses native CI with real child processes, package checks, and
  installer smoke on all six supported targets.

## Source and artifacts

- Previous release: [`cc-lhc-v0.3.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.3.0)
- Source comparison: [`cc-lhc-v0.3.0...cc-lhc-v0.4.0`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.3.0...cc-lhc-v0.4.0)
- Release tag: [`cc-lhc-v0.4.0`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.0)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.0/SHA256SUMS)
- npm: [`cc-lhc@0.4.0`](https://www.npmjs.com/package/cc-lhc/v/0.4.0)

The GitHub Release body, artifact manifest, workflow links, and published
tarball hash are verified and recorded after promotion.
