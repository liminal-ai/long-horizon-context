# cc-lhc

`cc-lhc` is the production Claude Code host for Long Horizon Context. It wraps
the closed `claude` CLI in a PTY, captures Claude's rollout JSONL into an LHC
thread, runs derivation inference through isolated `claude -p` subprocesses,
and, for respawn-safe interactive launches, rebuilds/respawns Claude when the
served thread view changes.

The integration was certified on 2026-08-10 against Claude Code 2.1.226. See
[`test/fixtures/slice7-certification-evidence.md`](test/fixtures/slice7-certification-evidence.md)
for the retained acceptance record.

Supported platforms are the six native targets in
`../cc-lhc-native/targets.json` — Linux, macOS, and Windows on x64 and arm64.
Exact process identity (ownership/liveness) comes from the `cc-lhc-native`
addon, delivered as prebuilt artifacts. The `native-platforms` GitHub
workflow is required to build the addon and run this package's full suite
with the compiled addon mandatory on every target; that workflow has not yet
succeeded on GitHub, so non-Linux targets currently rest on its definition
and local platform-gated tests rather than executed CI evidence. The
whole-product interactive certification above was performed on Linux.

## Start and help

```text
cc-lhc [cc-lhc flags] [claude args...]
cc-lhc --lhc-help
```

The three documented subcommands are reserved by the wrapper. Ordinary Claude
arguments, including `--help`, are forwarded after safe session-selector
normalization. Unknown `--lhc-*` flags exit with status 2.
`CC_LHC_CLAUDE_BIN` overrides the child binary. State defaults to
`~/.cc-lhc`; `CC_LHC_HOME` overrides it.

## What is integrated

- **Canonical capture.** A versioned rollout parser maps recognized
  conversational records into the append-only LHC record. Harmless host
  metadata is counted as telemetry; only classified integrity failures mark
  capture degraded.
- **Stable identity.** Assistant model identity is frozen from the response
  record. Thinking signatures are opaque; empty-but-signed thinking is
  preserved in the canonical record. The certified rebuild arm currently
  omits thinking blocks because the closed host cannot prove the prepared
  request identity required for safe signed replay.
- **Retrieval.** Claude can invoke `get-turns` and `get-messages` through Bash.
  A wrapper-owned runtime descriptor binds each invocation to the exact live
  session and LHC thread. Stale ownership, malformed state, and session
  mismatch fail closed before archive access or impression writes.
- **Context governance.** Provider-reported usage drives automatic compact at
  confirmed turn boundaries. Built-in policy targets 180k, triggers at 360k,
  reserves 50k runway, keeps native compact as a 1M emergency backstop, and
  leaves automatic prune off.
- **Controlled handoff.** On a respawn-safe interactive launch, compact/prune
  rebuild a new rollout, terminate the
  old child, and spawn `claude --resume <new-id>`. Capture stays attached
  through old-child exit; lineage and the ready descriptor advance only after
  replacement capture and child liveness are proven. User input is buffered
  after the transaction's commit point and delivered exactly once, or retained
  in a recovery artifact.
- **Single ownership.** A process-identity lease prevents two wrappers from
  owning the same Claude session, including across PID reuse.

## Retrieval and migration commands

```text
cc-lhc get-turns [--from TOKENS] <tN>...
cc-lhc get-messages [--from TOKENS] <mN>...
cc-lhc backfill-labels <thread-id-or-prefix> [--dry-run]
```

Retrieval is model-callable and uses the inherited
`CC_LHC_RUNTIME_DESCRIPTOR`; users should not set it manually. The service
computes a whole-stdout ceiling of at most 24,000 bytes, reserves envelope
overhead, and gives the remainder to the SDK as its byte budget. This keeps the
complete recalled-history envelope within Claude's certified inline-output
limit. Continuation receipts provide the next token offset.

`backfill-labels` is an operator command. It recomposes legacy stored
`turn_rendering` derivations with stable `<tN>`/`<mN>` labels for one explicit
thread. It does not use inference, alter canonical events, queue work, or
change source versions; `--dry-run` reports the planned changes.

## Control panel

Press **ctrl-]** while Claude is running. The wrapper opens an alternate-screen
panel so it never writes diagnostics into Claude's input box. Override the key
with `CC_LHC_LEADER`. The panel recognizes raw, kitty CSI-u, xterm
modifyOtherKeys, and Windows Terminal win32 input events.

| Command | Effect |
| --- | --- |
| `status` | Capture, descriptor, derivation, context-policy, and last-action status |
| `stats` | Current capture counters |
| `compact` | Smart compact and controlled child handoff |
| `prune [targetTokens]` | Advance the visibility boundary and hand off if changed |
| `export` | Write rollout and served-view transcript dumps |
| `auto on|off` | Change automatic compact for this wrapper lifetime |
| `bounds <lower> <upper>` | Change compact target/trigger for this wrapper lifetime |
| `help` / `?` | List panel commands |

Panel edits are session-scoped. Persistent policy is configured below.

The advisory lifecycle-command notifier warns on high-confidence user-entered
`/resume`, `/clear`, and `/compact`; it never blocks or rewrites input and is
not a correctness mechanism. Disable it for one launch with
`--lhc-no-notifier`. A real session mismatch still revokes retrieval and
capture through the authoritative rollout/session checks.

## Context policy

Policy precedence is:

```text
builtin < user config < project config < launch flags / panel edits
```

User config is `$XDG_CONFIG_HOME/cc-lhc/config.json` (or
`~/.config/cc-lhc/config.json`); project config is `.cc-lhc.json`. Unknown
fields and invalid bounds are reported and disarm automatic policy without
preventing Claude or capture from running. Supported persisted fields are
`autoCompact`, `lowerBoundTokens`, `upperBoundTokens`, `profile`,
`nativeCompactMode`, `nativeBackstopTokens`, `pruneEnabled`,
`pruneThresholdTokens`, `pruneTargetTokens`, `retryGrowthTokens`, and
`minRunwayTokens`. `observeOnly` is launch-only.

Run `cc-lhc --lhc-help` for the wrapper's launch flags and operative
environment surface.

## State and diagnostics

| Path under `~/.cc-lhc` | Purpose |
| --- | --- |
| `registry.sqlite` | Thread registry |
| `cc-lhc.sqlite` | Claude-session lineage and capture metadata |
| `threads/<uuid>.sqlite` | Per-thread LHC record, derivations, views, and impressions |
| `owners/*.json` | Exclusive live-session ownership leases |
| `runtime/*.json` | Per-wrapper retrieval capability descriptors (mode 0600 on POSIX; on Windows cc-lhc refuses a CC_LHC_HOME outside the user profile, so these inherit the profile's default ACLs — no POSIX modes and no bespoke DACL there) |
| `recovery/*` | Ordered input retained after an unrecoverable handoff failure |
| `wrapper.log` | Append-only wrapper diagnostics (no rotation yet) |

Runtime descriptors live in a private runtime directory and are capabilities,
not durable state. Rebuilt Claude rollouts remain under Claude's normal
`~/.claude/projects/` layout. The original rollout is never rewritten.

## Operational boundaries

- Fresh capture launches with a wrapper-assigned session ID. Explicit
  `--resume <id>` binds that session; bare `--resume` uses the wrapper-owned cwd
  picker, and `--continue` is resolved before Claude is spawned. Ambiguous or
  conflicting capture selectors fail before spawn.
- Launch-time resume and wrapper-controlled handoffs preserve the LHC thread.
  User-issued in-app `/resume` is unsupported; the
  advisory warning appears first, and any resulting mismatch fails closed.
- Automatic handoff requires respawn-safe launch argv. A positional initial
  prompt, prompt tokens after `--`, or an option/value boundary the wrapper
  cannot prove disables automatic respawn so a prompt is never re-executed.
  Manual compact/prune still writes and binds the rebuilt artifact; continue it
  with an external `cc-lhc --resume <rebuilt-session-id>`.
- Exact signed-thinking replay would require exact stored/live request identity.
  The wrapper cannot observe that closed request boundary, so rebuilt rollouts
  currently omit thinking blocks rather than guessing.
- Claude Code hooks are not required. The wrapper's lifecycle events come from
  the authoritative rollout stream; PTY handling is limited to terminal
  transport, the panel, child-liveness proof, and advisory notification.
- Automatic prune remains off by default. Native Claude compact is retained
  only as the configured emergency backstop.

## Verification

```text
# --config.verify-deps-before-run=false works around the open pnpm 11.8.0
# pre-run crash (long-horizon-context-52k); direct tsc/vitest also works.
pnpm --config.verify-deps-before-run=false --filter cc-lhc run typecheck
pnpm --config.verify-deps-before-run=false --filter cc-lhc run test   # CC_LHC_NATIVE_REQUIRE_ADDON=1 makes the compiled addon mandatory
```

Certification includes the real installed artifact in SSH → tmux → PTY,
automatic compact twice, unpiped labeled retrieval and impression recording,
prune, clean exit/relaunch, explicit resume, deliberate in-app mismatch,
legacy label backfill, and production-state isolation.
