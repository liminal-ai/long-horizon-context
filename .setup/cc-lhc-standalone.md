# Setup: cc-lhc standalone

Audience: an AI coding agent (or a person) setting up cc-lhc on a machine that has Claude Code and will NOT use PI. Supported platforms are exactly the six native targets in `packages/cc-lhc-native/targets.json`: Linux (x64, arm64), macOS (x64, arm64), and Windows (x64, arm64) — native Windows, no WSL required. Follow the steps in order. Each step has a verification — do not continue past a failed verification; report what failed instead.

> Kickoff lives in the repo README ("Installing the Claude Code Harness"). Everything below assumes the agent is reading this file inside a completed clone. Commands are written for a POSIX shell. The plain `git`/`node`/`pnpm` invocations work verbatim in PowerShell and cmd as well; the one place the syntax genuinely differs (setting an environment variable for a single command) gives explicit POSIX, PowerShell, and cmd forms.
>
> Known issue: pnpm 11.8.0 can crash in its pre-run dependency verification (`Cannot destructure property 'importMethod'`) before running anything — tracked as open bug `long-horizon-context-52k`. Every `pnpm … run …` command below therefore passes `--config.verify-deps-before-run=false` to bypass that broken pre-run check (it does not weaken the install itself). If a pnpm command still fails before your script starts, invoke the underlying tool directly (e.g. `node node_modules/typescript/bin/tsc -p packages/<pkg>/tsconfig.json`, `npx vitest run` from the package directory).

## Step 1: Clone

If you are reading this, the clone likely already happened — confirm it was recursive:

```bash
git submodule status   # must list vendor/pi with a SHA, not be empty
```

If empty or you cloned without `--recursive`: `git submodule update --init`. The `vendor/pi` submodule is never built for cc-lhc, but its directories must exist for the workspace install to resolve.

cc-lhc is a PTY wrapper around Claude Code that records sessions into a durable local store (`~/.cc-lhc/`), adds a ctrl-] command panel inside Claude Code (status, stats, compact, prune, export, auto, bounds), runs background summarization through `claude -p`, and performs wrapper-controlled context handoff when the served context outgrows its bounds. The wrapper boundary, precisely: inside a running session it never alters Claude Code's own behavior — every byte between your terminal and Claude Code passes through unchanged, except the ctrl-] leader byte (which the wrapper consumes to open its panel). What the wrapper does own is the session lifecycle around Claude Code: it selects the session id at launch, consumes the `--lhc-*` flag namespace, and at a confirmed turn boundary a compact may terminate the `claude` child and respawn `claude --resume <new-id>` to hand off context.

## Step 2: Prerequisites

Run the checker from the repo root:

```bash
node .setup/scripts/check-prereqs.mjs
```

It verifies: **git**; **Node ≥ 24.17.0** (stable `node:sqlite` floor; newer majors pass with an untested note — if below, install via your version manager: `nvm install 24`, `mise use node@24`, etc.); **pnpm 11.x** (if missing: `corepack enable && corepack prepare pnpm@11.8.0 --activate`); **OS/arch support** against the native-target manifest (an unsupported platform fails here, before anything is built); **Claude Code on PATH**; and **Claude Code auth** via a real `claude -p --no-session-persistence` call (non-persistent so the probe never writes a session file into your directory; add `--skip-claude-call` to skip it — but cc-lhc's background summarization uses `claude -p` under your existing login, so if it fails, fix Claude Code auth before continuing).

All lines must PASS before continuing. The script needs only Node, so if even Node is missing/wrong-version, fix that first by hand.

## Step 3: Install and build

From the repo root:

```bash
pnpm install
pnpm --config.verify-deps-before-run=false --filter lhc run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc run build
```

Do not run the root `pnpm build` — it builds every package including PI-dependent ones you don't need.

## Step 4: Build the native identity addon

cc-lhc's single-ownership invariant uses a small native Node-API addon (`cc-lhc-native`) for exact process identity. Until npm packaging exists, build that addon from the checkout:

```bash
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild
```

This pre-publication checkout builds the addon from source. `node-gyp` needs Python plus the native compiler toolchain: GCC/Make on Linux, Xcode Command Line Tools on macOS, or Visual Studio Build Tools with the Desktop C++ workload on Windows. The eventual npm package will install the matching prebuilt addon; that packaging is intentionally deferred until the source version has been dogfooded and signed off.

**Verify:** `node packages/cc-lhc/dist/bin.js --version` prints the Claude Code version banner (it passes through to the real `claude`). For full confidence run the deterministic suite with the compiled addon made mandatory:

```bash
# POSIX shells:
CC_LHC_NATIVE_REQUIRE_ADDON=1 pnpm --config.verify-deps-before-run=false --filter cc-lhc run test
# PowerShell (the variable stays set for the session; Remove-Item Env:CC_LHC_NATIVE_REQUIRE_ADDON to clear it):
$env:CC_LHC_NATIVE_REQUIRE_ADDON="1"; pnpm --config.verify-deps-before-run=false --filter cc-lhc run test
# cmd (note: no space before &&, or the variable's value gains a trailing space):
cmd /c "set CC_LHC_NATIVE_REQUIRE_ADDON=1&& pnpm --config.verify-deps-before-run=false --filter cc-lhc run test"
```

The current suite contains 658 tests. Platform-specific tests may skip where they do not apply; zero failures is the bar on every platform.

## Step 5: Put `cc-lhc` on PATH

```bash
node .setup/scripts/install-shim.mjs
```

Writes a launcher to `~/.local/bin/cc-lhc` pointing at this clone's built dist — it resolves the repo path itself. On Linux/macOS that is a single bash shim; on Windows it is a pair: `cc-lhc.cmd` (stable batch text, runnable from PowerShell and cmd) plus `cc-lhc.launcher.js` beside it, which holds the repo paths JSON-encoded so a clone path containing cmd metacharacters (`&`, `%`, parentheses, spaces) is never parsed as batch source. Use `--bin-dir <dir>` to install elsewhere. If the target directory is not on PATH, the script prints the exact platform-correct command to add it (shell profile line on POSIX; on Windows a persistent user-PATH PowerShell command built from single-quoted literals, so directories containing `$` or other PowerShell metacharacters are appended verbatim); run that, then open a new terminal.

**Verify:** `cc-lhc --version` from any directory prints the Claude Code version banner.

## Step 6: First run

> **If you are an agent doing this setup:** step 6 needs an interactive terminal (a real TTY), which you do not have headless. Do not treat that as a failure. Report that steps 1–5 passed and the install is complete, and ask the human to run step 6 themselves. Give them the PATH line for the shim directory you installed.

From a project directory (not this repo):

```bash
cc-lhc
```

This launches Claude Code normally, wrapped. First launch creates `~/.cc-lhc/` (registry, thread store). If you set `CC_LHC_HOME`, use an absolute path so launches from different project directories cannot resolve to different homes. Use Claude Code as usual for a few exchanges, then press **ctrl-]** — the screen switches to a command panel with a `long-horizon commands> ` prompt — and type `status` then Enter. Thread info appears as receipt rows in the panel; note the thread id, you will compare it after resume. Press Esc once to dismiss (Claude Code's screen comes back exactly as it was).

Still inside the session, prove in-session retrieval: ask Claude to run `cc-lhc get-turns t1` in its Bash tool, directly and unpiped — the bare command, no `| head`, no redirection, not wrapped in another shell. The tool output Claude sees (and will normally quote back) must be a `<recalled-history>` block containing the recorded first turn. Then exit normally.

**Verify after exit — resume must be the wrapper's, on the same thread:**
- `~/.cc-lhc/threads/` contains at least one `.sqlite` file.
- Relaunch with `cc-lhc --continue` (or `cc-lhc --resume <session-id>`), which resumes the recorded session through the wrapper. Press ctrl-] and run `status`: the thread id must equal the one from the first launch — that is the proof of same-thread wrapper resume. Then run `stats` — `lines` and `events` counters are nonzero and `parse_fail=0`. (A plain `cc-lhc` relaunch starts a fresh thread and proves nothing about resume; do not use it for this verification.)

If ctrl-] does not open the command panel, capture a debug log — POSIX: `CC_LHC_INPUT_DEBUG=/tmp/cc-input.log cc-lhc`; PowerShell: `$env:CC_LHC_INPUT_DEBUG="$env:TEMP\cc-input.log"; cc-lhc` — reproduce, and report with the log; a terminal emulator may be swallowing the byte, or an in-flight escape sequence may be misclassified. The `CC_LHC_LEADER` environment variable can rebind the key (e.g. to `^_`).

## What to expect in real use

- **Automatic context handoff (wrapper-controlled resume).** Provider-reported usage drives automatic compact at confirmed turn boundaries (built-in policy: 180k target, 360k trigger, 50k runway, Claude's native 1M compact retained as emergency backstop, automatic prune off). On a respawn-safe interactive launch the wrapper rebuilds a new rollout, terminates the old child, and respawns `claude --resume <new-id>` itself — your screen continues in place and buffered input is delivered exactly once. When a launch is not respawn-safe (certain passthrough argv), compact instead prints explicit guidance to exit and relaunch with `cc-lhc --resume <new-id>` — it never injects `/resume` into the live session. Verify a handoff worked from the panel: `status` shows the same thread continuing across the new session id.
- **Retrieval.** The model can recall full-fidelity history through its own Bash tool (`cc-lhc get-turns <tN>` / `get-messages <mN>`); the wrapper binds every retrieval to the exact live session and refuses on any mismatch.
- **Claude Code version drift — the precise policy:** the integration is certified against Claude Code **2.1.226** exactly, and against no other version. The wrapper does not detect or block other versions; drift is handled by classifying what changed, not by blanket tolerance. Two tiers:
  - *Telemetry (skip-and-count, no degradation):* known harmless metadata — meta/local-command noise, sidechain records, image placeholders — and **unknown top-level host-chrome record types** (Claude's bookkeeping records that are neither user nor assistant lines). These are skipped and tallied in panel `stats` and do not affect capture health.
  - *Capture-degrading:* an unknown shape **inside a user or assistant conversational record** (it could conceal conversational content), a line that fails to parse, a session-id mismatch, or a rollout discontinuity/storage/integrity failure. Any of these latches capture **degraded** for the session generation. The wrapped Claude session itself stays fully usable, but the wrapper refuses what requires a trustworthy record: context mutation (compact/prune — refused with an explicit receipt, and automatic compact stops arming) and retrieval bound to a degraded runtime descriptor.

  After a real session on any other version, check panel `stats`: high `skipped_unknown` relative to `lines` means the local version writes shapes we don't map, and a `capture degraded` line in the wrapper log or a mutation refusal means the drift crossed into the second tier — report the Claude Code version and the counters either way.
- **Exit pause:** quitting can take up to ~30s if background summarization is still draining. It's a pause, not a hang.
- **Opting out:** `cc-lhc --lhc-no-capture` runs Claude Code wrapped but without recording, and plain `claude` is always untouched. (cc-lhc owns the `--lhc-*` flag namespace and consumes those flags; all other arguments pass through to `claude` verbatim. `cc-lhc --lhc-help` lists all wrapper flags and panel commands.)

## Update

```bash
cd <repo>
git pull
git submodule update --init
pnpm install
pnpm --config.verify-deps-before-run=false --filter lhc run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild
pnpm --config.verify-deps-before-run=false --filter cc-lhc run build
```

Then **restart any running `cc-lhc` sessions** — a live wrapper keeps executing the old dist until relaunched, and mixed old/new generations are not a supported state.

## Uninstall

Remove the shim (`~/.local/bin/cc-lhc` on Linux/macOS; both `~/.local/bin/cc-lhc.cmd` and `~/.local/bin/cc-lhc.launcher.js` on Windows), delete the clone, and delete `~/.cc-lhc/` (this destroys recorded threads).
