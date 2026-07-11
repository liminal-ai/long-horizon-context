# Linux deployment handoff for t3code-lhc

## Context: what this system is

Lee is building a persistent, privately reachable coding-agent environment on his Linux
server. The user-facing application is **T3 Code**. The context-management subsystem added
to it is **LHC (Long Horizon Context)**. The combined fork is referred to here as
**t3code-lhc**.

This is not a conventional website that calls a hosted AI API from the browser. It is a web
control plane for coding agents that actually run on the Linux machine:

```text
Lee's browser
  -> T3 Code web application over HTTP/WebSocket
  -> T3 Code server on the Linux machine
  -> locally installed and authenticated coding-agent CLI/SDK
  -> project repositories and tools on the Linux machine
```

The browser is an authenticated remote client. The Linux server is the execution environment.
It owns the provider processes, credentials, project files, terminals, Git operations,
conversation state, and long-running work. Closing the browser does not conceptually move the
agent or its files elsewhere; the execution boundary remains the T3 Code server.

### What T3 Code provides

[T3 Code](https://github.com/pingdotgg/t3code) is an early-stage Node.js server and React/Vite
web application for running coding agents such as Claude Code, Codex, Cursor, and Grok. It
provides:

- a browser interface for projects, threads, messages, diffs, Git actions, and terminals;
- an authenticated HTTP/WebSocket boundary suitable for a separate client machine;
- provider adapters that start, resume, interrupt, and stop coding-agent sessions;
- normalized provider events used to render different harnesses through one application;
- persisted server orchestration and resume state; and
- headless and remote-access support, including LAN endpoints, pairing, and Tailscale Serve.

For this deployment, T3 Code is meant to become the day-to-day web application Lee opens from
another computer while the actual Claude Code or Codex process runs on the Linux server against
repositories stored there.

### What LHC provides

LHC is Lee's long-horizon context SDK. It keeps a durable, structured record of an agent thread
and derives progressively compressed representations of older context. Its purpose is to let a
useful coding conversation continue beyond the point where raw prompts, file reads, and tool
output would otherwise overwhelm a provider context window.

LHC records and derives context; it is not itself another chat UI or coding-agent provider. For
each captured thread it maintains:

- exact prompts, assistant responses, reasoning, tool calls, and tool results;
- explicit turn boundaries and runtime notes;
- durable per-thread SQLite state;
- background derivations such as tool-result summaries and compressed turn views;
- token/accounting and context-health information;
- a **smart compact** operation that ages older material into lower-fidelity context bands while
  preserving a recent verbatim tail; and
- a **prune** operation that removes stale tool-output bulk from the context served to the model
  without deleting it from the durable LHC record.

The durable LHC record and the context currently served to a model are intentionally different.
A prune or compact makes the next provider context smaller; it does not erase the historical
source material from LHC.

### What the t3code-lhc fork adds

The implementation lives in Lee's fork of T3 Code because it needs a few server and web
integration points that stock T3 Code does not yet have. Most of the implementation is isolated
in the fork's `packages/lhc-host` package.

For Claude Code and Codex, the fork adds four connected capabilities:

1. **Automatic capture.** T3 Code's normalized provider-event stream and send-turn hook feed each
   live thread into a corresponding LHC thread. Capture occurs in the server; the user does not
   run a separate recorder.
2. **Background context derivation.** The LHC SDK maintains summaries and compressed views while
   the conversation proceeds. A bounded `claude -p` inference lane performs derivation work.
3. **Native-session compact/prune.** When LHC changes the served view, the host renders that view
   into a new native Claude or Codex rollout, stops the current provider session, changes T3
   Code's persisted resume cursor, and lets the next turn resume from the rebuilt session.
4. **Web controls.** The existing context-usage ring in T3 Code opens an LHC popover showing record
   size and context health, with **Smart compact** and **Prune tool outputs** actions when the
   provider supports them and the thread is idle.

The resulting flow is:

```text
Claude/Codex turn on Linux
  -> T3 Code normalizes provider events
  -> LHC captures durable history and computes derivations
  -> Lee optionally selects compact or prune in the browser
  -> LHC renders the desired session view
  -> t3code-lhc writes a new provider-native rollout and flips the resume cursor
  -> the next Claude/Codex turn continues from that rebuilt context
```

This is significantly more reliable than earlier terminal-wrapper integrations. T3 Code already
talks to Claude through the Agent SDK and to Codex through app-server JSON-RPC, so session changes
are controlled file/API/cursor operations. There is no PTY keystroke injection, ANSI parsing, or
attempt to drive an interactive terminal UI during compact/prune.

### The three kinds of state

The deployment agent should understand that three related records coexist:

1. **T3 Code state** owns projects, UI projections, authentication, provider bindings, and the
   persisted resume cursor.
2. **LHC state** is the durable context-management record and derivation store.
3. **Provider-native state** is the Claude or Codex rollout the provider actually loads as model
   history.

T3 Code's message projection is not automatically provider context. That is why the integration
must rebuild the provider's native session after LHC compaction rather than merely rewrite a web
application database.

### Current implementation status

Claude Code and Codex are implemented and have passed real end-to-end acceptance on macOS:

- live T3 Code capture into durable LHC threads;
- full prompt/assistant/tool fidelity, including large tool results;
- background derivation drain;
- compact and prune through authenticated server endpoints and the web context-ring UI;
- synthetic native rollout generation;
- persisted cursor flip with race/contestation checks;
- next-turn recall proving the provider loaded the rebuilt context;
- continued turns and repeated swaps on the same LHC lineage; and
- a 13-step isolated sync-smoke covering both real providers after an upstream merge.

Grok and Cursor are not part of this Linux deployment. Their local session formats and synthetic
resume feasibility have been researched, but their capture fidelity and production renderers are
not implemented. Their LHC web actions intentionally remain hidden.

The Linux work is therefore a deployment and environment-validation exercise for an existing
Claude/Codex implementation—not a request to invent the integration on the server.

## Audience and mandate

This handoff is for the agent already helping Lee configure his local Linux server and home
network. Assume that agent understands the machine, service manager, storage, firewall, DNS,
LAN, and Tailscale setup better than this document does.

The task is **not** to redesign the infrastructure or the LHC integration. The task is to
deploy the existing T3 Code fork as a persistent web application on that Linux server, make
it reachable from Lee's LAN and/or tailnet according to the server's established network
policy, and verify that Claude Code and Codex threads receive the existing LHC capture,
compact, and prune behavior.

Do not deploy stock `npx t3` as the final service: the LHC integration lives in Lee's T3 Code
fork and must run from that checkout until it is upstreamed or packaged separately.

## Desired end state

- One Linux user owns the T3 Code process, provider CLIs, project files, provider credentials,
  T3 Code state, and LHC state.
- T3 Code serves its built React web application and HTTP/WebSocket backend as one persistent
  service.
- Lee can pair a browser and reach the application:
  - directly from the trusted home LAN; and/or
  - from any device on his tailnet, preferably through Tailscale Serve HTTPS when the hosted
    HTTPS web client is involved.
- The server can launch authenticated Claude Code and Codex sessions against projects on the
  Linux machine.
- Every new Claude/Codex T3 thread is captured into `~/.t3code-lhc/`.
- The context ring in the composer opens an LHC popover with **Smart compact** and
  **Prune tool outputs** for captured Claude/Codex threads.
- A compact/prune stops the provider session, rebuilds its native rollout, flips T3 Code's
  persisted resume cursor, and lets the next turn resume the rebuilt context.
- The deployment survives logout and reboot under the service-management approach already
  chosen for the Linux server.
- Updating the fork remains an explicit fetch/merge/build/gates/sync-smoke operation; a failed
  update never replaces the last known-good running revision.

## Repository locations and remotes

The current linked dependency assumes this exact relative checkout layout under the Linux
user's home directory:

```text
~/code/
  pi-long-horizon/
    liminal-context/          # LHC SDK repository
  t3code-lhc/
    t3code/                   # LHC-enabled T3 Code fork
```

### LHC repository

```text
Local path:  ~/code/pi-long-horizon/liminal-context
Origin:      https://github.com/liminal-ai/long-horizon-context.git
Branch:      main
```

At handoff time the expected revision is at least:

```text
aedb94e  pi-lhc: format fold path and tighten omission regressions
```

Fetch before deploying and record the actual commit used. The relevant SDK package is:

```text
~/code/pi-long-horizon/liminal-context/packages/lhc
```

### T3 Code fork

```text
Local path:  ~/code/t3code-lhc/t3code
Origin:      https://github.com/liminal-ai/t3code.git
Branch:      lhc
Upstream:    https://github.com/pingdotgg/t3code.git
```

At handoff time the expected revision is at least:

```text
2ac199185  docs(lhc): record Cursor and Grok session-rebuild findings
```

The LHC host implementation is:

```text
~/code/t3code-lhc/t3code/packages/lhc-host
```

Its package dependency is deliberately local:

```json
"lhc": "link:../../../../pi-long-horizon/liminal-context/packages/lhc"
```

From `packages/lhc-host`, that relative path resolves correctly only when the two repositories
have the layout shown above. Either preserve that layout or deliberately change and re-lock the
link. Preserving it is recommended for the first deployment.

## Required onboarding reading

Read these in order before changing deployment code:

### Integration overview

1. `~/code/pi-long-horizon/liminal-context/packages/t3code-lhc/README.md`
   - What T3 Code is, why it is a good LHC host, capture/swap architecture, fork policy, and
     deployment intent.
2. `~/code/pi-long-horizon/liminal-context/packages/t3code-lhc/claude-code-codex-lhc.md`
   - Detailed implemented design for Claude and Codex, rollout formats, cursor shapes, failure
     modes, and live-validation results.
3. `~/code/pi-long-horizon/liminal-context/packages/t3code-lhc/grok-cursor-lhc.md`
   - Background only. Grok/Cursor are researched but intentionally deferred and must not be
     enabled during this deployment.

GitHub equivalents:

- <https://github.com/liminal-ai/long-horizon-context/tree/main/packages/t3code-lhc>

### Fork operations and evidence

4. `~/code/t3code-lhc/t3code/docs/lhc/operations.md`
   - Authoritative state layout, environment flags, endpoints, errors, troubleshooting, and
     sync-smoke command.
5. `~/code/t3code-lhc/t3code/docs/lhc/findings/live-capture-validation.md`
   - Proven source-boot, authentication, WebSocket, restart, and capture behavior.
6. `~/code/t3code-lhc/t3code/docs/lhc/findings/phase2-acceptance.md`
   - Real Claude compact/prune/resume acceptance.
7. `~/code/t3code-lhc/t3code/docs/lhc/findings/phase4-acceptance.md`
   - Real Codex compact/prune/resume acceptance.
8. `~/code/t3code-lhc/t3code/docs/lhc/sync-reports/2026-07-09-1945.md`
   - First complete 13/13 green real-provider certification report.
9. `~/code/t3code-lhc/t3code/docs/lhc/implementation-plan.md` and `impl-log.md`
   - Historical decisions and implementation provenance; useful if behavior needs debugging.

Fork links:

- <https://github.com/liminal-ai/t3code/tree/lhc/docs/lhc>
- <https://github.com/liminal-ai/t3code/tree/lhc/packages/lhc-host>

### T3 Code remote operation

10. `~/code/t3code-lhc/t3code/docs/user/remote-access.md`
    - Current supported headless, LAN, Tailscale, pairing, hosted-web, and SSH access paths.
11. `~/code/t3code-lhc/t3code/docs/architecture/remote.md`
    - Execution-environment and access-endpoint model.
12. `~/code/t3code-lhc/t3code/docs/getting-started/quick-start.md`
    - Upstream build/start overview. Use it together with the fork-specific source-boot caveat
      below.

## Runtime ownership and credentials

Run T3 Code as the same unprivileged Linux account whose provider CLIs are installed and
authenticated. The server process launches the providers and reads/writes their native session
stores. Running it as another service user without deliberately migrating auth and homes will
produce confusing provider failures or split session state.

The service account needs:

- `HOME` set to its real home directory;
- a non-interactive `PATH` containing `node`, `claude`, `codex`, `git`, and expected shell/tool
  binaries;
- read/write access to the project repositories it will operate on;
- read/write access to T3 Code, LHC, Claude, and Codex state directories; and
- valid Claude Code and Codex authentication in that account.

Provider CLIs and subagent CLIs are already installed according to Lee. Verify them from the
same non-interactive environment the service manager will use rather than reinstalling them.
In particular:

- Claude Code must run normal Agent SDK sessions for the Claude provider.
- `claude -p` must also work because LHC background derivations use a bounded one-shot Claude
  inference lane even while the user is working in a Codex thread.
- Codex authentication must support `codex app-server`.

If the service PATH cannot reliably locate Claude, set `T3CODE_LHC_CLAUDE_BIN` to the absolute
Claude executable path. Do not enable `T3CODE_LHC_NO_INFERENCE` for the intended final service;
it is a diagnostic/manual-capture mode only.

## Toolchain

The combined repositories currently require Node 24. Choose a version satisfying both:

```text
T3 Code root:      ^24.13.1
LHC SDK package:   >=24.17.0 <25
Recommended:       latest available Node 24.x satisfying >=24.17.0
```

The repositories pin different pnpm releases through `packageManager`:

```text
T3 Code fork:      pnpm@11.10.0
liminal-context:   pnpm@11.8.0
```

Corepack can honor each repository's pin when commands are run from that repository. Vite+
(`vp`) is used by T3 Code; use the repository-provided tooling or the already-installed `vp`
CLI rather than substituting unrelated build commands.

## Initial checkout and build sequence

Adapt locations only if the existing server layout requires it; preserve relative repository
placement.

```bash
mkdir -p "$HOME/code/pi-long-horizon" "$HOME/code/t3code-lhc"

git clone https://github.com/liminal-ai/long-horizon-context.git \
  "$HOME/code/pi-long-horizon/liminal-context"

git clone --branch lhc https://github.com/liminal-ai/t3code.git \
  "$HOME/code/t3code-lhc/t3code"

cd "$HOME/code/pi-long-horizon/liminal-context"
corepack pnpm install --frozen-lockfile
corepack pnpm --filter lhc run build

cd "$HOME/code/t3code-lhc/t3code"
corepack pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp run typecheck
pnpm exec vp run --filter @t3tools/lhc-host test
pnpm exec vp run --filter @t3tools/web build
```

Project requirements say `vp check` and `vp run typecheck` must pass before a code revision is
accepted. The package test should show the existing LHC host suite green. Building the web app
must produce:

```text
apps/web/dist/index.html
```

The server's static-file resolver discovers that monorepo web build automatically.

### Known server-bundle caveat

The fork was live-validated by running the TypeScript server entrypoint directly under Node 24
with its small `.js`-to-`.ts` resolve hook. At the time of validation, the normal `vp pack`
server bundle had an Effect export incompatibility and was not the trusted path.

The proven boot command is therefore:

```bash
cd "$HOME/code/t3code-lhc/t3code"
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve ...
```

Do not block initial deployment on producing `apps/server/dist/bin.mjs`. The Linux agent may
re-test the normal full production bundle later, but first establish the known-good source-server
plus built-web configuration. Keep the resolve hook in the final service command unless a tested
code update removes the need for it.

## Persistent state layout

Use two separate persistent roots:

```text
T3CODE_HOME=$HOME/.t3code
T3CODE_LHC_HOME=$HOME/.t3code-lhc
```

T3 Code stores its database, auth/session state, runtime metadata, and logs below its base dir.
The running server writes authoritative process metadata here:

```text
$T3CODE_HOME/userdata/server-runtime.json
```

LHC stores:

```text
$T3CODE_LHC_HOME/
  registry.sqlite
  t3code-lhc.sqlite
  threads/
    <uuid>.sqlite
```

Never point this integration at `~/.lhc`; hosts own separate state directories by design.

Provider-native rebuilt sessions remain in their real provider homes:

```text
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
~/.codex/sessions/YYYY/MM/DD/rollout-...-<thread-id>.jsonl
```

A complete backup policy for long-running use should therefore consider T3 Code state, LHC
state, provider rollout state, and project repositories separately. Do not copy Mac state into
the Linux deployment unless Lee explicitly wants thread migration; a fresh Linux deployment
can begin with empty T3/LHC state.

## Environment configuration

Recommended baseline variables for the persistent process:

```bash
T3CODE_HOME="$HOME/.t3code"
T3CODE_LHC_HOME="$HOME/.t3code-lhc"
T3CODE_LHC_CLAUDE_BIN="$(command -v claude)"
T3CODE_LHC_INFERENCE_CONCURRENCY=8
T3CODE_LHC_INFERENCE_TIMEOUT_MS=60000
```

Behavioral switches:

| Variable | Normal deployment | Meaning |
| --- | --- | --- |
| `T3CODE_LHC_DISABLE` | unset | `1` disables all LHC initialization and capture |
| `T3CODE_LHC_NO_INFERENCE` | unset | `1` uses manual deterministic derivations; diagnostic only |
| `T3CODE_LHC_SUPPRESS_AUTOCOMPACT` | unset | Suppression is on by default; set `0` only to let Claude native compaction compete with LHC |
| `T3CODE_LHC_CLAUDE_BIN` | absolute CLI path recommended | Executable used by the LHC inference lane |
| `T3CODE_LHC_INFERENCE_CONCURRENCY` | `8` | Host cap on concurrent `claude -p` calls |
| `T3CODE_LHC_INFERENCE_TIMEOUT_MS` | `60000` | Per-inference timeout |

Do not set `T3CODE_LHC_DISABLE=1`, `T3CODE_LHC_NO_INFERENCE=1`, or
`T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0` in the intended final deployment unless troubleshooting
a specific issue.

## Network/access modes

Choose the access mode that fits the already-established Linux network. T3 Code supports the
following without changing the LHC layer.

### Tailscale Serve HTTPS — preferred for tailnet and hosted-web access

The server has native Tailscale Serve support:

```bash
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve \
  --base-dir "$T3CODE_HOME" \
  --host 127.0.0.1 \
  --port 3773 \
  --tailscale-serve
```

This asks Tailscale Serve to proxy tailnet HTTPS (default port 443) to
`127.0.0.1:<actual-local-port>`. T3 Code logs whether configuration succeeded. The server
continues running if Tailscale configuration fails, so validate the advertised HTTPS endpoint
and log message rather than treating process liveness as proof.

An alternate HTTPS port is supported with `--tailscale-serve-port 8443`.

This mode is suitable for `https://app.t3.codes` pairing because an HTTPS page must connect to
an HTTPS/WSS backend. T3 Code's hosted app is not a proxy; the browser still connects directly
to the Linux server through the tailnet endpoint.

### Direct Tailnet HTTP

Binding directly to the Tailnet IP is supported:

```bash
--host "$(tailscale ip -4)" --port 3773
```

This is useful for a direct desktop client or a browser page opened over HTTP. A hosted HTTPS
page cannot connect to this plain HTTP/WS endpoint because browsers block mixed content.

### Trusted LAN

Binding to a selected LAN address or `0.0.0.0` makes the same built web app available directly
on the home network. Apply the machine's existing firewall and trusted-interface policy. This
handoff does not recommend exposing the raw T3 port to the public internet.

If LAN and Tailscale access are both required, select the bind/proxy combination consistent with
the network agent's existing design. LHC has no network-specific behavior.

## Pairing and browser access

Use the `serve` subcommand rather than `start` for headless operation. It does not open a local
browser and prints:

- connection string;
- one-time pairing token;
- pairing URL; and
- QR code.

Pairing flow:

1. Start the server and capture its headless output securely.
2. Open the direct built-web pairing URL from a reachable client, or use the hosted pairing URL
   with an HTTPS/WSS backend.
3. Exchange the one-time token.
4. The server creates a persistent authenticated session for that client.
5. Manage or revoke sessions later with the same fork's `t3 auth` command surface.

Treat pairing URLs/tokens as passwords. Do not put them in public logs or tickets.

The current remote UI may not support adding projects directly. Add projects on the Linux host
with the fork's CLI against the same base directory, for example:

```bash
cd "$HOME/code/t3code-lhc/t3code"
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts project add /absolute/path/to/project \
  --base-dir "$T3CODE_HOME" \
  --title "Optional title"
```

The command can find the live server through `server-runtime.json`; if the server is down it can
operate against the same local state. Use `project --help`/`project add --help` from the fork if
CLI syntax changes upstream.

## Suggested persistent service shape

Use the Linux service mechanism already selected for the server. The essential process contract
is:

- user: the provider-authenticated unprivileged account;
- working directory: `~/code/t3code-lhc/t3code`;
- command: Node 24 source entrypoint with the resolve hook and `serve`;
- environment: real `HOME`, non-interactive provider `PATH`, T3/LHC state variables;
- restart: on failure, with sensible backoff;
- logs: captured by the service manager plus T3's own state/log paths;
- shutdown: send normal termination and allow T3/LHC finalizers to flush queues and settle
  derivations; avoid routine SIGKILL; and
- deploy: build first, then restart only after static gates pass.

Do not copy a generated unit verbatim from this handoff: paths and the network access mode belong
to the Linux setup agent. The `ExecStart` equivalent should ultimately resemble:

```bash
/usr/bin/env node \
  --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve \
  --base-dir "$HOME/.t3code" \
  --host 127.0.0.1 \
  --port 3773 \
  --tailscale-serve
```

In a service manager, prefer absolute paths for Node and Claude and do not assume shell expansion
of `$HOME` or `$(command -v ...)` unless the unit explicitly invokes a shell.

## Deployment verification

### 1. Static and process checks

- `vp check` passes.
- `vp run typecheck` passes.
- `@t3tools/lhc-host` tests pass.
- `apps/web/dist/index.html` exists.
- The service remains up under the chosen manager.
- `$T3CODE_HOME/userdata/server-runtime.json` has the live pid, origin, port, and recent
  `startedAt`.
- The web root and an application asset return `200` through each intended endpoint.
- WebSocket connectivity succeeds through the same endpoint used by the browser.
- Tailscale Serve logs/configuration identify the correct local backend when enabled.

Do not accept “port returns 200” as proof that the new revision is running. The earlier dogfood
restart encountered an old process still owning the port. Check pid, `startedAt`, and a
revision-sensitive feature or endpoint.

### 2. Provider checks

From the service user's non-interactive environment:

- Claude authentication reports logged in.
- A tiny `claude -p` call succeeds.
- Codex authentication is valid and app-server can start.
- T3 Code shows Claude and Codex as available.
- A small turn completes in each provider.

### 3. LHC UI checks

For a new Claude thread and a new Codex thread:

- send at least one real turn;
- click the context-usage ring;
- verify an **LHC context** popover appears;
- verify it reports an LHC record size and provider kind;
- verify **Smart compact** and **Prune tool outputs** are present when the turn is idle;
- verify actions disable while a turn is running; and
- verify Cursor/Grok do not expose these actions.

### 4. LHC endpoint/state checks

The browser uses normal authenticated sessions. For operator diagnostics, mint or use an
appropriate bearer as documented in `docs/lhc/operations.md`, then verify:

```text
GET /lhc/status
GET /lhc/threads/<t3-thread-id>
```

Expected:

- `capture.enabled: true`;
- `mode: "background"`;
- Claude/Codex lineage rows exist;
- events and turns increase after activity;
- derivations have no persistent failed/blocked work; and
- per-thread SQLite files appear under `$T3CODE_LHC_HOME/threads/`.

### 5. Full sync-smoke certification

After normal build/provider checks, run the existing isolated real-provider certification from
the T3 fork root:

```bash
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/smoke/sync-smoke.ts
```

It uses scratch T3/LHC homes and an ephemeral port, so it must not touch production state or
collide with the persistent service. It performs up to eight paid provider turns and tests:

- server boot and process identity;
- auth;
- Claude and Codex turns;
- exact prompt/tool capture;
- Claude compact;
- Codex prune;
- resume recall from rebuilt sessions;
- cursor integrity; and
- derivation health.

Acceptance is exit code `0` and all 13 report rows `PASS`. The report is written under:

```text
docs/lhc/sync-reports/<YYYY-MM-DD-HHmm>.md
```

If model names or provider versions have changed, diagnose the failure before editing the smoke
bar. Do not weaken recall, artifact, cursor, or fidelity assertions merely to make deployment
green.

### 6. Small live dogfood acceptance

Only after the isolated smoke passes:

1. Use a disposable/scratch project visible in the real web app.
2. Create a Claude thread and seed a recognizable fact.
3. Run a small tool-heavy turn.
4. Compact from the context-ring UI while idle.
5. Ask for the seeded fact without restating it.
6. Confirm the answer and continued thread lineage.
7. Repeat with Codex using prune.
8. Inspect health and logs.

Do not send a new turn while a compact/prune request is in flight. `409 busy` or
`swap_in_progress` is a safe retry condition; `flip_contested` means the operation did not report
success and should be retried only after confirming quiescence.

## What is already proven

The Linux agent does not need to rediscover these points:

- T3 Code is a better LHC host than direct terminal wrapping because Claude, Codex, Cursor, and
  Grok all expose programmatic session APIs; there is no PTY injection in the implemented path.
- Claude capture preserves prompts, reasoning, assistant text, and full tool output after a narrow
  adapter enrichment.
- Codex's normalized event payload is sufficient for full capture.
- Claude can resume a hand-built rollout by setting the persisted `resume` cursor and restarting
  the SDK session.
- Codex app-server `thread/resume` accepts synthetic rollouts in both warm and fresh processes.
- Claude and Codex share a hardened swap controller with flip-last cursor semantics and contested
  flip detection.
- Real Claude compact/prune/resume and real Codex compact/prune/resume passed end to end.
- Organic Mac dogfooding successfully pruned a 96-tool-call Codex thread and compacted a large
  Claude thread while preserving recall.
- The context-ring UI actions are implemented and dogfooded.
- A post-upstream-merge sync-smoke passed 13/13 against both providers.

## Scope boundaries

For this deployment:

- Enable LHC only for Claude Code (`claudeAgent`) and Codex.
- Do not widen capture/UI gates for Cursor or Grok. Their rebuild feasibility is proven, but ACP
  assistant/tool fidelity and provider-specific renderers remain unimplemented.
- Do not make T3 rollback/fork semantics LHC-aware as part of Linux setup.
- Do not redesign the LHC state layout or move it into `~/.lhc`.
- Do not replace T3 Code's pairing/auth model with infrastructure-only trust.
- Do not expose the raw backend publicly merely to make remote access convenient; use the trusted
  LAN/tailnet architecture already being established.
- Do not automate daily upstream deployment until the initial Linux service and sync-smoke are
  stable. Fetch/report automation can precede automatic restart.

## Updating the fork later

Current maintenance model:

1. keep `origin/lhc` as the deployable LHC branch;
2. keep `upstream` pointed at `pingdotgg/t3code`;
3. fetch and inspect upstream changes;
4. merge upstream rather than rewriting the deployed branch history;
5. regenerate `pnpm-lock.yaml` carefully if pnpm reports an auto-merge;
6. explicitly check that no conflict markers remain;
7. rebuild the linked LHC SDK if its repository changed;
8. install/build T3 Code;
9. run `vp check`, `vp run typecheck`, LHC host tests, and web build;
10. run the full sync-smoke;
11. write/retain the report; and
12. restart the persistent service only after everything is green.

A prior headless pnpm merge attempted to leave conflict markers because it needed a TTY. The known
noninteractive recovery was:

```bash
CI=true pnpm install --no-frozen-lockfile
```

Afterward, check for conflict markers and review the lockfile before accepting it. Do not blindly
run this on every deploy; use it only when the lockfile genuinely needs regeneration.

Keep the last known-good Git revision and built web assets available for rollback. If an update
fails, leave the running Linux service pinned and produce a report rather than forcing the new
revision into service.

## Handoff completion report

When setup is complete, report at least:

- Linux user and checkout paths used;
- exact `liminal-context` and `t3code` commit hashes;
- Node and pnpm versions;
- service-manager unit/name and effective command (redact secrets);
- T3 and LHC state roots;
- chosen LAN/Tailscale endpoint types;
- whether Tailscale Serve HTTPS was enabled and verified;
- how pairing was completed;
- project-add workflow used;
- provider authentication/availability result;
- static gate results;
- sync-smoke report path and PASS/FAIL summary;
- live Claude/Codex LHC UI acceptance result; and
- any deviations from this document.
