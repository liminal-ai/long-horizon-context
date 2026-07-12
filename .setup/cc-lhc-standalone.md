# Setup: cc-lhc standalone

Audience: an AI coding agent (or a person) setting up cc-lhc on a Linux or macOS machine that has Claude Code and will NOT use PI. (On Windows, use WSL; native Windows is not currently supported.) Follow the steps in order. Each step has a verification — do not continue past a failed verification; report what failed instead.

> Kickoff lives in the repo README ("Installing the Claude Code Harness"). Everything below assumes the agent is reading this file inside a completed clone.

## Step 1: Clone

If you are reading this, the clone likely already happened — confirm it was recursive:

```bash
git submodule status   # must list vendor/pi with a SHA, not be empty
```

If empty or you cloned without `--recursive`: `git submodule update --init`. The `vendor/pi` submodule is never built for cc-lhc, but its directories must exist for the workspace install to resolve.

cc-lhc is a PTY wrapper around Claude Code that records sessions into a durable local store (`~/.cc-lhc/`), adds a ctrl-] command modal inside Claude Code (status, stats, prune, compact), and runs background summarization through `claude -p`. It changes nothing about how Claude Code itself behaves.

## Step 2: Prerequisites

Run the checker from the repo root:

```bash
node .setup/scripts/check-prereqs.mjs
```

It verifies: **git**; **Node 24.x** (`>=24.17.0 <25` — if wrong, install via your version manager: `nvm install 24`, `mise use node@24`, etc.); **pnpm 11.x** (if missing: `corepack enable && corepack prepare pnpm@11.8.0 --activate`); **Claude Code on PATH**; and **Claude Code auth** via a real `claude -p` call (add `--skip-claude-call` to skip that one — but cc-lhc's background summarization uses `claude -p` under your existing login, so if it fails, fix Claude Code auth before continuing).

All lines must PASS before continuing. The script needs only Node, so if even Node is missing/wrong-version, fix that first by hand.

## Step 3: Install and build

From the repo root:

```bash
pnpm install
pnpm --filter lhc run build
pnpm --filter cc-lhc run build
```

Do not run the root `pnpm build` — it builds every package including PI-dependent ones you don't need.

**Verify:** `node packages/cc-lhc/dist/bin.js --version` prints the Claude Code version banner (it passes through to the real `claude`). If you want more confidence: `pnpm --filter cc-lhc test` should pass everything (134 tests at time of writing).

## Step 4: Put `cc-lhc` on PATH

```bash
node .setup/scripts/install-shim.mjs
```

Writes a launcher to `~/.local/bin/cc-lhc` pointing at this clone's built dist — it resolves the repo path itself. Use `--bin-dir <dir>` to install elsewhere. The script warns if the target directory is not on PATH; if it warns, add the directory in your shell profile.

**Verify:** `cc-lhc --version` from any directory prints the Claude Code version banner.

## Step 5: First run

> **If you are an agent doing this setup:** step 5 needs an interactive terminal (a real TTY), which you do not have headless. Do not treat that as a failure. Report that steps 1–4 passed and the install is complete, and ask the human to run step 5 themselves. Give them the PATH line for the shim directory you installed.

From a project directory (not this repo):

```bash
cc-lhc
```

This launches Claude Code normally, wrapped. First launch creates `~/.cc-lhc/` (registry, thread store). If you set `CC_LHC_HOME`, use an absolute path so launches from different project directories cannot resolve to different homes. Use Claude Code as usual for a few exchanges, then press **ctrl-]** — the screen switches to a command panel with a `long-horizon commands> ` prompt — and type `status` then Enter. Thread info appears as receipt rows in the panel; press Esc once to dismiss (Claude Code's screen comes back exactly as it was). Exit normally.

**Verify after exit:**
- `ls ~/.cc-lhc/threads/` shows at least one `.sqlite` file.
- Relaunch `cc-lhc`, press ctrl-] and run `stats` — `lines` and `events` counters are nonzero and `parse_fail=0`.

If ctrl-] does not open the command panel, capture a debug log (`CC_LHC_INPUT_DEBUG=/tmp/cc-input.log cc-lhc`), reproduce, and report with the log — a terminal emulator may be swallowing the byte, or an in-flight escape sequence may be misclassified. `CC_LHC_LEADER` can rebind the key (e.g. `CC_LHC_LEADER='^_'`).

## What to watch on a new machine

- **Claude Code version drift:** cc-lhc's rollout parser was built against Claude Code 2.1.201. On other versions it degrades safely — unknown record shapes are skipped and counted, never fatal. After a real session, check the modal `stats` command: a high `skipped_unknown` relative to `lines` means the local version writes shapes we don't map yet. Report the version and the counts.
- **Exit pause:** quitting can take up to ~30s if background summarization is still draining. It's a pause, not a hang.
- **Opting out:** `cc-lhc --no-capture` runs Claude Code wrapped but without recording, and plain `claude` is always untouched.

## Update

```bash
cd <repo> && git pull && git submodule update --init && pnpm install
pnpm --filter lhc run build && pnpm --filter cc-lhc run build
```

## Uninstall

Remove `~/.local/bin/cc-lhc`, delete the clone, and delete `~/.cc-lhc/` (this destroys recorded threads).
