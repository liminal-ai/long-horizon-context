# Setup: cc-lhc standalone

Audience: an AI coding agent (or a person) setting up cc-lhc on a machine that has Claude Code and will NOT use PI. Follow the steps in order. Each step has a verification — do not continue past a failed verification; report what failed instead.

> **Kickoff (for the human):** this doc lives inside the repo, so the only thing an agent on a fresh machine needs is one line containing the repo URL. Paste this to the agent:
>
> ```
> Clone --recursive <repo-url>, then read .setup/cc-lhc-standalone.md in the clone and follow it to set up cc-lhc.
> ```
>
> Everything below assumes the agent is reading this file inside a completed clone.

## Step 1: Clone

If you are reading this, the clone likely already happened — confirm it was recursive:

```bash
git submodule status   # must list vendor/pi with a SHA, not be empty
```

If empty or you cloned without `--recursive`: `git submodule update --init`. The `vendor/pi` submodule is never built for cc-lhc, but its directories must exist for the workspace install to resolve.

cc-lhc is a PTY wrapper around Claude Code that records sessions into a durable local store (`~/.cc-lhc/`), adds `/lhc-*` commands inside Claude Code (status, stats, prune, compact), and runs background summarization through `claude -p`. It changes nothing about how Claude Code itself behaves.

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

Writes a launcher to `~/.local/bin/cc-lhc` (or `cc-lhc.cmd` on Windows) pointing at this clone's built dist — it resolves the repo path itself. Use `--bin-dir <dir>` to install elsewhere. The script warns if the target directory is not on PATH; if it warns, add the directory in your shell profile.

**Verify:** `cc-lhc --version` from any directory prints the Claude Code version banner.

## Step 5: First run

From a project directory (not this repo):

```bash
cc-lhc
```

This launches Claude Code normally, wrapped. First launch creates `~/.cc-lhc/` (registry, thread store). Use Claude Code as usual for a few exchanges, then type `/lhc-status` inside the session — it should print thread info instead of Claude Code complaining about an unknown command. Exit normally.

**Verify after exit:**
- `ls ~/.cc-lhc/threads/` shows at least one `.sqlite` file.
- Relaunch `cc-lhc`, run `/lhc-stats` — `lines` and `events` counters are nonzero and `parse_fail=0`.

If `/lhc-*` commands reach Claude Code as unknown commands instead of being intercepted, capture a debug log (`CC_LHC_INPUT_DEBUG=/tmp/cc-input.log cc-lhc`), reproduce, and report with the log — terminal emulators inject escape sequences the interceptor may not know yet.

## What to watch on a new machine

- **Claude Code version drift:** cc-lhc's rollout parser was built against Claude Code 2.1.201. On other versions it degrades safely — unknown record shapes are skipped and counted, never fatal. After a real session, check `/lhc-stats`: a high `skipped_unknown` relative to `lines` means the local version writes shapes we don't map yet. Report the version and the counts.
- **Exit pause:** quitting can take up to ~30s if background summarization is still draining. It's a pause, not a hang.
- **Opting out:** `cc-lhc --no-capture` runs Claude Code wrapped but without recording, and plain `claude` is always untouched.

## Update

```bash
cd <repo> && git pull && git submodule update --init && pnpm install
pnpm --filter lhc run build && pnpm --filter cc-lhc run build
```

## Uninstall

Remove `~/.local/bin/cc-lhc`, delete the clone, and delete `~/.cc-lhc/` (this destroys recorded threads).
