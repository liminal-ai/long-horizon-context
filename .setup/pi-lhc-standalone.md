# Setup: pi-lhc standalone

Audience: an AI coding agent (or a person) setting up pi-lhc on a Linux or macOS machine that will use PI. (On Windows, use WSL; native Windows is not currently supported.) Follow the steps in order. Each step has a verification — do not continue past a failed verification; report what failed instead.

> Kickoff lives in the repo README ("Installing the PI Harness"). Everything below assumes the agent is reading this file inside a completed clone.

## Step 1: Recursive clone

If you are reading this, the clone likely already happened — confirm it was recursive:

```bash
git submodule status   # must list vendor/pi with a SHA, not be empty
```

If empty or you cloned without `--recursive`: `git submodule update --init`. Unlike cc-lhc, **pi-lhc requires the submodule built** (step 3) — it links against `vendor/pi`'s built `dist/`.

pi-lhc is a PI extension plus launcher binary: it captures every PI session into a durable LHC thread under `~/.pi-lhc/`, intercepts PI compaction with LHC smart compact, and seeds PI sessions from LHC thread views. Plain `pi` on the same machine keeps its own separate `~/.pi` — intentional.

## Step 2: Prerequisites

Run the checker from the repo root with the pi-lhc lane:

```bash
node .setup/scripts/check-prereqs.mjs --for pi-lhc
```

It verifies: **git**; **Node ≥ 24.17.0** (stable `node:sqlite` floor; newer majors pass with an untested note — if below, install via your version manager: `nvm install 24`, `mise use node@24`, etc.); **pnpm 11.x** (if missing: `corepack enable && corepack prepare pnpm@11.8.0 --activate`). Claude Code checks are skipped for this lane — pi-lhc needs no Claude Code. Model auth comes later via PI's own login (step 6).

All lines must PASS (or intentional SKIP) before continuing. The script needs only Node, so if even Node is missing/wrong-version, fix that first by hand.

## Step 3: Install and build

From the repo root. Build the vendored PI submodule **first** — `pi-lhc` links against its built `dist/`:

```bash
cd vendor/pi && npm ci && npm run build && cd ../..
pnpm install
pnpm --filter lhc run build
pnpm --filter pi-lhc run build
```

The order is mandatory on a clean clone: pnpm snapshots the local `file:` PI packages when it installs them, so their built `dist/` must already exist. Running `pnpm install` first produces incomplete package snapshots and pi-lhc will not compile.

Do not run the root `pnpm build` unless you want every package — the filtered builds above are enough.

**Workspace overrides gotcha:** root `pnpm-workspace.yaml` forces transitive `pi-ai` / `pi-agent-core` / `pi-tui` deps to the vendored packages under `vendor/pi`. Without those overrides, pnpm resolves those packages from the npm registry and the vendored patch never reaches the runtime. Do not remove them.

**Expected dirt after PI's build:** PI regenerates model-catalog files inside the submodule. If `git status` shows `vendor/pi` dirty after `npm run build`, that is expected and discardable.

**Verify:** `node packages/pi-lhc/dist/bin.js --lhc-help` prints the launcher help (or `node packages/pi-lhc/dist/bin.js --version` prints a version line). If you want more confidence: `pnpm --filter pi-lhc test` should pass.

## Step 4: Put `pi-lhc` on PATH

```bash
node .setup/scripts/install-shim.mjs --target pi-lhc
```

Writes a launcher to `~/.local/bin/pi-lhc` pointing at this clone's built dist — it resolves the repo path itself. Use `--bin-dir <dir>` to install elsewhere. The script warns if the target directory is not on PATH; if it warns, add the directory in your shell profile.

**Verify:** `pi-lhc --lhc-help` from any directory prints the launcher help.

## Step 5: First run + home creation

> **If you are an agent doing this setup:** steps 5–8 need an interactive terminal and/or model auth, which you may not have headless. Do not treat that as a failure. Report that steps 1–4 passed and the install is complete through the shim, and ask the human to run steps 5–8 themselves. Give them the PATH line for the shim directory you installed.

From a project directory (not this repo):

```bash
pi-lhc
```

This launches PI wrapped by the LHC launcher. First launch creates `~/.pi-lhc/` with `registry.sqlite`, `threads/`, and `pi/agent/` (PI's entire config directory, via `PI_CODING_AGENT_DIR`). Override the home location with `PI_LHC_HOME` if needed; use an absolute path so launches from different project directories cannot resolve to different homes. One precedence rule: if `PI_CODING_AGENT_DIR` is already set in your environment, pi-lhc respects it and PI config lands **there**, not under the home — `unset PI_CODING_AGENT_DIR` before this step unless you want that.

**Verify after first launch (even if you exit immediately):**
- `ls ~/.pi-lhc/` shows `registry.sqlite`, `threads/`, and `pi/agent/` (or the corresponding paths under `$PI_LHC_HOME`). If you deliberately kept a `PI_CODING_AGENT_DIR` preset, `pi/agent/` will be at that location instead — the other two entries still land in the home.

## Step 6: Auth setup into the new home

PI's persistent login flow runs inside pi-lhc and writes credentials into `~/.pi-lhc/pi/agent/auth.json` — **not** into `~/.pi`. From an interactive `pi-lhc` session use `/login`. (`--api-key` and provider env vars also work, but they are **per-session only** — PI does not persist them to `auth.json`, so they won't satisfy the verification below and must be re-supplied every launch.)

Plain `pi` on the same machine keeps its own separate `~/.pi` — intended divergence. Machines that already have state under `~/.lhc` and `~/.pi/agent` migrate instead via the migration script (see "Migrating an existing machine" below): LHC state is **moved**, PI agent config is copied.

**Verify (after a persistent `/login`, not the per-session alternatives):** confirm the auth file contains at least one provider entry (PI creates an empty `{}` file even before login, so existence alone is not enough):

```bash
AUTH="${PI_CODING_AGENT_DIR:-${PI_LHC_HOME:-$HOME/.pi-lhc}/pi/agent}/auth.json"
AUTH="$AUTH" node -e 'const a=JSON.parse(require("node:fs").readFileSync(process.env.AUTH,"utf8")); if (!Object.keys(a).length) process.exit(1)'
```

Finding the populated file under `~/.pi/agent/` instead means the session was not running under pi-lhc's home.

## Step 7: Backup rail install

Fresh installs never run the migration script, so without this step only migrated homes get a backup rail. Copy the repo script into the home and make it executable:

```bash
cp scripts/pi-lhc-backup.sh ~/.pi-lhc/backup.sh
chmod +x ~/.pi-lhc/backup.sh
```

(Use `$PI_LHC_HOME` instead of `~/.pi-lhc` if you overrode the home.)

The script runs from the home directory: it uses Node's built-in SQLite support to WAL-checkpoint `registry.sqlite` and every `threads/*.sqlite`, then `git add -A`, commits if there is anything new, and `git push -q origin main`. It assumes the home is already a git repo with a remote named `origin` and a `main` branch. If you want offsite snapshots, initialize that yourself before relying on the rail:

```bash
cd ~/.pi-lhc
git init
# add remote + first commit as you prefer, e.g.:
# git remote add origin <url>
# git add -A && git commit -m "init" && git branch -M main && git push -u origin main
```

If the home is not a git repo (or has no remote / nothing new), the script will fail or print `pi-lhc-backup: nothing new` rather than inventing a remote for you. Run it when no pi-lhc session is up for a clean snapshot; a mid-session run yields a slightly stale (not corrupt) copy.

**Verify:** `test -x ~/.pi-lhc/backup.sh` (or `$PI_LHC_HOME/backup.sh`) succeeds.

## Step 8: Verification launch

> Same agent note as step 5: this step needs a TTY and working model auth. Hand it to the human if you lack either.

From a project directory:

```bash
pi-lhc --print "reply with exactly: ok"
```

Or run interactive `pi-lhc`, exchange a message, and exit normally.

**Verify:**
- Print mode writes the bare thread id as the **first stdout line**; interactive mode announces
  `LHC thread: <id>` on stderr at exit. Either way you have the id.
- `ls ~/.pi-lhc/threads/` shows at least one `.sqlite` file for that session.
- The announced id resolves: `pi-lhc --lhc-thread <id> --print "ok"` attaches without "not found" / ambiguous-prefix errors.

## What to watch on a new machine

- **Vendored PI dirt:** after every submodule rebuild, model-catalog regen may dirty `vendor/pi` — discardable; do not commit it casually.
- **Overrides:** if installs suddenly miss the thinking-signature patch or other vendor fixes, check that `pnpm-workspace.yaml` still pins `pi-ai` / `pi-agent-core` / `pi-tui` to `vendor/pi`.
- **Home isolation:** plain `pi` writes `~/.pi`; pi-lhc writes `~/.pi-lhc`. Mixing them is a common first-day confusion when auth "disappears."
- **Backup rail:** without step 7 (and a git remote in the home), there is no automatic snapshot path for a fresh install.

## Update

```bash
cd <repo> && git pull && git submodule update --init
cd vendor/pi && npm ci && npm run build && cd ../..
pnpm install
pnpm --filter lhc run build && pnpm --filter pi-lhc run build
```

Rebuild `vendor/pi` whenever the submodule pin moves or you re-clone; pi-lhc links against its `dist/`.

## Uninstall

Remove `~/.local/bin/pi-lhc`, delete the clone, and delete `~/.pi-lhc/` (this destroys recorded threads, PI config under that home, and any local backup git history). Plain `~/.pi` is untouched.

## Migrating an existing machine

If this machine already has LHC state under `~/.lhc` and/or PI agent config under `~/.pi/agent`, do **not** re-copy by hand. Use the offline migration (operator-run; no pi-lhc process may be alive):

```bash
node scripts/migrate-to-pi-lhc.mjs --dry-run   # review the plan
node scripts/migrate-to-pi-lhc.mjs --yes       # execute
```

Defaults: from `~/.lhc`, to `$PI_LHC_HOME` or `~/.pi-lhc`, seed PI agent files from `~/.pi/agent`. See the script's `--help` for `--from` / `--to` / `--pi-agent`.
