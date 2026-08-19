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
with the compiled addon mandatory on every target. The six-target matrix and
compiler-free package installation passed before the 0.1.0 package was
prepared. The whole-product interactive certification above was performed on
Linux, with subsequent Windows and macOS dogfood findings incorporated before
the package build.

## Install

Prerequisites are Node 24.3 or later and an installed, authenticated Claude
Code CLI.

Install on Linux or macOS from the checksum-verified GitHub release:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.1.0/install.sh | sh
```

Install on Windows from PowerShell:

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.1.0/install.ps1 | iex
```

The installers detect x64 or ARM64, download the matching complete runtime
bundle, and verify its SHA-256 before installation. The bundle includes all
JavaScript dependencies, the target PTY runtime, and the native identity addon.
The client does not invoke npm or a compiler. Node 24.3 or later and an
authenticated Claude Code CLI remain prerequisites.

The ordinary npm installation remains available:

```text
npm install --global cc-lhc
cc-lhc --lhc-help
```

The package includes prebuilt native identity addons for all supported
targets. A supported client does not need a C++ compiler or `node-gyp`.

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
- **Capability-limited context governance (LIM-64).** Provider-reported input
  usage is authoritative and includes input + cache creation + cache read.
  Predicted next-request pressure adds a **source-labelled** estimate for
  content captured after that provider request (never double-counted as
  provider usage). Missing or invalid latest usage falls back to the last known
  provider reading plus that estimate, labelled `last_known` so an older
  measurement is never read as fresh — a session at 900k does not become healthy
  because one usage line went bad. Two things decide an automatic compact: the
  user's `autoCompact` policy and measured pressure. Capture health, descriptor
  readiness, receipt storage, and typed-ahead input are diagnostics and have no
  say. Classification uses explicit named states and durable receipts. Threshold
  crossing during an open agentic turn is observed and receipted but **not**
  mutated mid-turn — Claude Code cannot replace the in-flight request the way
  Codex full continuation can. At the next Claude-safe settled seam, policy may
  run the compact/rebuild and wrapper-owned spawn-first handoff below.
  A native compact summary is captured as one bounded closed turn and reported
  loudly; nothing latches and LHC compaction continues. Capture that is degraded or still catching up does not
  block the seam: the wrapper rebuilds capture state from the persisted
  transcript and re-evaluates the moment it is ready. Built-in policy targets
  180k, triggers at 360k, reserves 50k runway, and leaves automatic prune off.
- **Forward-only construction.** The settled seam is read once, before any SDK
  work, and never re-read: input arriving, a turn opening, or capture changing
  generation appends to a thread whose settled history the snapshot already
  holds, so none of them can cancel a compact that is under way. The rebuilt
  rollout is written under bounded retries from the durable installed view. From
  the moment compact owns the settled session, bytes bound for Claude are
  dropped rather than delivered — never buffered, never replayed — and one line
  says *input typed during compaction was not delivered — please resend*.
- **Spawn-first handoff.** On a respawn-safe interactive launch, compact/prune
  rebuild a new rollout, then spawn `claude --resume <new-id>` **off-route** — a
  real child owning no terminal, no stdin, and no capture generation. Once it has
  proven observable viability (it rendered and survived a stabilization window;
  session-file growth is recorded when it appears and never required), input
  routing, output routing, the retrieval descriptor, and the capture generation
  switch in one step, and later old-child output is ignored. The old child is
  killed last, best effort, and a survivor is left running and named loudly by
  PID. A working session exists at every moment and nothing ever rolls back to
  the oversized one. This is **not** same-agentic-turn continuation: there is no
  synthetic tool-tail preservation and no Codex parity claim.
- **When replacements repeatedly will not run.** Each nonviable swap costs the
  session nothing and is retried at the next settled seam. After a bounded
  number of them, two things happen instead of another quiet retry, and both
  persist: a standing alarm — *cc-lhc rebuilt sessions are not loading — likely
  a compatibility problem with the installed Claude version* — and a survival
  relaunch of the old session **without** the injected `DISABLE_AUTO_COMPACT`,
  so Claude's own compaction can keep it alive in degraded form. The alarm is
  cc-lhc's best guess from observable viability, not proof Claude rejected the
  file; the terminal is never parsed to find out. Nothing ends: the old session
  stays live and captured, retrieval keeps working, and manual compact still
  runs — only the automatic swap stops.
- **Runtime continuity.** Wrapper-owned handoffs preserve the latest confirmed
  Claude effort and permission mode from the rollout. Unknown values are not
  inferred, and permissions are never broadened by guesswork.
- **Single ownership per thread.** Launch resolves the host-qualified session
  alias (`claude-code:<uuid>`) through the LHC registry to a thread, takes a
  process-identity lease on that **thread**, and re-reads the thread's current
  alias under the lease before choosing a session. Every alias of one thread
  contends for one lease, so two wrappers can never both drive it — including
  across PID reuse. A launch through an older alias resolves forward onto the
  thread's current session. An accepted swap whose registry pointer could not
  be written is recorded host-side with the pointer it observed, and reconciled
  into the registry at the next launch under the lease — repairing only that
  exact predecessor, so a later successful acceptance is never rolled back.

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
`~/.config/cc-lhc/config.json`); project config is `.cc-lhc.json`. Supported
persisted fields are `autoCompact`, `lowerBoundTokens`, `upperBoundTokens`,
`profile`, `pruneEnabled`,
`pruneThresholdTokens`, `pruneTargetTokens`, and `minRunwayTokens`.

Bad configuration never disarms the product. An unknown field, a malformed
value, an unreadable file, or an incoherent pair of bounds falls back to the
built-in default for the fields involved; automatic compact stays on. The
fallback is announced at startup, in the wrapper log, in the control panel, and
in the compact message written to the rebuilt session, and it says: *Invalid
compact configuration. Default configuration used. Please fix or update the
configuration.* Only an explicit `autoCompact: false` — in config or through a
panel `auto off` — turns automatic compact off.

Run `cc-lhc --lhc-help` for the wrapper's launch flags and operative
environment surface.

## State and diagnostics

| Path under `~/.cc-lhc` | Purpose |
| --- | --- |
| `registry.sqlite` | Thread registry and alias map (session alias → thread, one current alias per thread) |
| `cc-lhc.sqlite` | Host-local session detail (rollout paths, prefix proof, replay signatures, pending-acceptance recovery) and durable governor receipts (`cc_governor_receipts`) |
| `threads/<uuid>.sqlite` | Per-thread LHC record, derivations, views, and impressions |
| `owners/*.json` | Exclusive thread-ownership leases (keyed by thread hash) |
| `runtime/*.json` | Per-wrapper retrieval capability descriptors (mode 0600 on POSIX; on Windows cc-lhc refuses a CC_LHC_HOME outside the user profile, so these inherit the profile's default ACLs — no POSIX modes and no bespoke DACL there) |
| `recovery/*` | Only pre-rewrite artifacts, cleared at launch by the thread that owns them |
| `wrapper.log` | Append-only wrapper diagnostics (no rotation yet) |

Runtime descriptors live in a private runtime directory and are capabilities,
not durable state. Rebuilt Claude rollouts remain under Claude's normal
`~/.claude/projects/` layout. The original rollout is never rewritten.

## Capability boundary vs Codex full continuation

Authoritative cross-host certification (frozen heads, invariant receipts, and
gate commands):
[`docs/compact-continuation-certification.md`](../../docs/compact-continuation-certification.md).

| | **cc-lhc (capability-limited)** | **Codex (full state machine)** |
| --- | --- | --- |
| Mid-agentic-turn request replacement | **No** — closed CLI, no injection seam | Yes — in-place next-request install |
| When compact may run | Claude-safe **settled** seam only | Settled model-turn seam inside an open agentic turn |
| Open-turn threshold | Classify + durable receipt; `wouldMutate=false` | May compact / preserve tool tail / force continuation |
| Continuation marker / `context_compact_continue` | **Not fabricated** | Typed marker + forced boundary when applicable |
| Handoff | Rebuild rollout + `claude --resume` (new session id) | Serve compacted view into the same agentic turn |
| Native writer | Native auto-compact disabled per child; a summary is captured as one bounded turn | One-writer rules with native conflict refuse |
| Receipts | Structured rows in `cc-lhc.sqlite` + rollout operation note | Compact-continuation receipt in thread DB |
| Live post-measurement pressure | Real watcher lines: provider `output_tokens` when valid, else host canonical-payload bytes/4; cumulative until next sampling | Full runtime estimate path |

v1 accepts this difference honestly. Shared LIM-60/61 strings and pressure
accounting are reused where they remain truthful; cc-lhc does not claim effects
Claude Code cannot perform.

**Durable receipts (production):** every classification is receipted, and
receipts are write-behind — they record the compact, they never decide whether
it runs. When the receipt store is unavailable the operation proceeds against an
in-memory receipt id with a loud warning (restart recovery is degraded for that
attempt; the session still compacts). Exact native replay is idempotent (unique
`replay_key`); a replayed receipt whose outcome was a *deferral* is retried,
because no mutation had started, while an existing `scheduled` receipt after
restart is not re-run. Outcomes attach only to that exact receipt id (never
“latest wouldMutate”), so old-session → new-session handoff and manual compact
cannot rewrite an unrelated automatic classification.

## Operational boundaries

- Fresh capture launches with a wrapper-assigned session ID. Explicit
  `--resume <id>` binds that session; bare `--resume` uses the wrapper-owned cwd
  picker, and `--continue` is resolved before Claude is spawned. Ambiguous or
  conflicting capture selectors fail before spawn.
- Launch-time resume and wrapper-controlled handoffs preserve the LHC thread.
  Resuming any older session of a thread lands on the session that thread
  currently accepts; the current pointer advances when a swap is accepted.
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
- Automatic prune remains off by default. Every managed Claude child launches
  with `DISABLE_AUTO_COMPACT=1`, so Claude's own automatic compaction never runs
  on a managed session; manual `/compact` stays available. An explicit user
  `--autocompact` passes through unchanged and cc-lhc does not inject the
  disable for that launch, with an anomaly notice. Omission is all the wrapper
  claims: inherited environment and Claude's own settings still govern whether
  native auto-compact then runs, and cc-lhc cannot observe them.

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
