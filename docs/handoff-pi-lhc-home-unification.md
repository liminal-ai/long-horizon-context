# Handoff: pi-lhc home unification (`~/.pi-lhc`)

Audience: a **cc-lhc agent** (Claude Code under the cc-lhc wrapper) orchestrating this work in the
LHC monorepo. You execute this instead of a pi-lhc agent deliberately: the work relocates pi-lhc's
harness state (`~/.lhc`, `~/.pi`), and a pi-lhc agent would be rewriting its own open files. Your
harness home is `~/.cc-lhc` and your inference lane is `claude -p` — zero overlap with the blast
radius. Keep it that way: never attach to a real pi-lhc thread, and run all live probes in scratch
directories.

## Mission

Unify everything pi-lhc needs at runtime into one deployment directory, `~/.pi-lhc` by default,
overridable via `PI_LHC_HOME`. Today that state is split across `~/.lhc` (LHC thread registry,
thread DBs) and `~/.pi/agent` (PI's auth, models, settings, sessions, extensions). After this work,
a fresh machine gets pi-lhc running with exactly one directory to create, back up, or delete, and a
setup doc gets a new agent from clone to working install unattended.

Four slices plus one operator-run live checkpoint. Work one slice at a time; each slice is one
commit; **never push** — the operator reviews and pushes.

## Onboard first, in this order

1. `memory/MEMORY.md` — per repo AGENTS.md; read any memory relevant to routing or process.
2. `docs/onboard/01-core-concepts.md` — vocabulary: threads, record vs derivation, thread views.
3. `docs/onboard/02-domain-design.md` — skim; focus on ThreadRef/registry and serving.
4. `docs/onboard/04-host-pi-lhc.md` — the host you are modifying. Read fully.
5. `docs/backlog.md` item 26 — this work closes it.

Read in detail (these are the exact surfaces the slices touch):

- `packages/pi-lhc/src/bin.ts` — `DEFAULT_LHC_DIR = ~/.lhc`, new-thread path creation.
- `packages/pi-lhc/src/launcher/run.ts` — launcher startup; note it calls PI's `getAgentDir()` and
  passes `agentDir` explicitly into `createAgentSessionRuntime` (lines ~115, ~153, ~167).
- `packages/pi-lhc/src/index.ts` — second `DEFAULT_LHC_DIR` constant (~line 261) and the
  `registryPath` flow into the SDK.
- `packages/lhc/src/threads/internal/registry.ts` — `DEFAULT_REGISTRY_PATH = ~/.lhc/registry.sqlite`.
- `packages/cc-lhc/src/intake/paths.ts` — the `CC_LHC_HOME` override pattern. Imitate it exactly.
- `vendor/pi/packages/coding-agent/src/config.ts` lines ~490–570 — how PI resolves its home.
  **Read-only; vendor/pi is never modified in this work.**
- `.setup/cc-lhc-standalone.md` and `.setup/scripts/` — the setup-doc shape slice 4 imitates.

## Research findings (verified 2026-07-11 against the live tree — trust but re-verify cheaply)

**PI is fully relocatable without patching.** `getAgentDir()`
(`vendor/pi/packages/coding-agent/src/config.ts:515`) honors the env var `PI_CODING_AGENT_DIR`
(built as `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, config.ts:495) at **call time**, defaulting
to `~/.pi/agent`. Every PI-owned path routes through it as a defaulted parameter: auth
(`auth-storage.ts:63,216`), models (`model-registry.ts:379`), settings (`settings-manager.ts:311`),
skills (`skills.ts:392`), extensions (`extensions/loader.ts:654`), keybindings
(`keybindings.ts:343`), session services (`agent-session-services.ts:141`), plus sessions dir,
themes, tools, bin, prompts, debug log inside config.ts itself. No hardcoded `~/.pi` escapes it in
runtime paths (remaining literals are comments, an old-bug migration, and project-local `.pi/`
discovery, which is cwd-relative and unaffected).

**pi-lhc already passes `agentDir` explicitly** into the runtime it creates (`launcher/run.ts`,
`launcher/runtime-factory.ts`). So the unification is: resolve our own home, derive
`<home>/pi/agent`, set `PI_CODING_AGENT_DIR` early in `bin.ts` (before any PI import executes
path-resolving code — the env is read at call time, so ordering is forgiving, but set it first
anyway), and pass the same value explicitly. Belt and suspenders; no vendor change.

**Current `~/.lhc` inventory:** `registry.sqlite` (rows store **absolute** thread file paths —
migration must rewrite them, not just move files); `threads/` (~290 thread DBs plus WAL/SHM
sidecars); `.env` (OpenRouter/OpenAI/WandB/Cerebras keys — **no runtime consumer found in pi-lhc or
lhc source**; likely prompt-lab-era. Slice 1 confirms; if genuinely unused at runtime, migration
copies it and nothing routes it); `backup.sh` + `.git` (snapshot repo — migration moves the git
history so the snapshot chain stays unbroken); `cc-sessions.json` (dead since cc-lhc moved to
`~/.cc-lhc`; do not migrate).

**Current `~/.pi/agent` inventory worth copying:** `auth.json`, `models.json`, `settings.json`,
`extensions/`, `skills/`, `trust.json`. Do **not** copy: `sessions/` (pi-lhc reseeds PI sessions
from the thread record on every launch; old JSONL only matters to plain `pi`), the `*.bak*`/backup
graveyard, `npm/`, `bin/`.

**Cosmetic:** `pi-extensions/exa-search.ts` error strings mention `~/.pi/agent/...` paths; update
the wording when the new home lands (slice 2).

## Design rulings (Lee, 2026-07-11)

1. **Self-contained beats shared.** PI config under `~/.pi-lhc/pi/agent` means plain `pi` on the
   same machine keeps its own separate `~/.pi`. They diverge after a one-time copy. Intended.
2. **Clean cut, no dual-read.** No legacy `~/.lhc` fallback branch in code. One offline migration
   script does the cutover; until the operator runs it, old threads are simply not visible to the
   new build. This follows the standing ruling that edge-case branches must pull their weight.
3. **Old PI sessions don't migrate.** See inventory above.
4. Env override name: `PI_LHC_HOME` (mirrors `CC_LHC_HOME`). Layout:

```
~/.pi-lhc/
├── registry.sqlite
├── threads/
├── .env                # copied if present; not routed unless slice 1 finds a real consumer
├── backup.sh           # snapshot rail, git repo (history moved from ~/.lhc)
└── pi/agent/           # PI's entire config dir via PI_CODING_AGENT_DIR
```

## The slices

Sequential: 1 → 2 → 3; slice 4 may overlap slice 3. One commit per slice, suites green, no push.

### Slice 1 — home module + lhc-state rerouting

A single home-resolution module in pi-lhc (`PI_LHC_HOME` override → `~/.pi-lhc` default), imitating
`packages/cc-lhc/src/intake/paths.ts`. Route through it: `bin.ts` new-thread dir, both
`DEFAULT_LHC_DIR` constants, the `registryPath` handed to the SDK, and first-run bootstrap
(mkdirs). The lhc SDK's own `DEFAULT_REGISTRY_PATH` stays as-is — pi-lhc always passes its registry
path explicitly (verify this is true everywhere; if a call site relies on the SDK default, fix the
call site, don't change the SDK). Chase the `~/.lhc/.env` question to a definitive answer and
record it in the slice report. Tests: default home, env override, bootstrap idempotence.

### Slice 2 — PI config unification

`bin.ts` sets `PI_CODING_AGENT_DIR = <home>/pi/agent` **unless the user already set it**, before
importing the launcher; launcher keeps passing `agentDir` explicitly (now identical). First-run
bootstrap creates `pi/agent/`. Update exa-search message strings. **The one real risk in this
project lives here**: some PI code path resolving config before our env set, or a surface that
ignores the passed `agentDir`. That is why this slice's acceptance is empirical, not unit-only:
launch `pi-lhc --print "say ok"` in a scratch dir with a scratch `PI_LHC_HOME`, then prove by
directory inspection that **nothing** under the real `~/.pi` or `~/.lhc` was created or modified
and that auth/settings/sessions/extension state landed inside the scratch home. Snapshot mtimes
before, compare after. Auth note: a scratch home has no `auth.json`; PI's normal login/API-key flow
writes into the relocated dir — for the headless probe, seed a minimal `auth.json` copy or accept
an auth error *as long as the paths prove out* (the probe is about where files land, not whether
inference succeeds).

### Slice 3 — migration script + backup rail

`scripts/migrate-to-pi-lhc.mjs` (repo-level, like `.setup/scripts/`): offline, requires `--yes`,
has `--dry-run`, and **refuses to run if any pi-lhc process is alive** (check for running
`pi-lhc/dist/bin.js` processes). It: moves `registry.sqlite` (checkpoint WAL first, then rewrite
thread `file_path` rows from `~/.lhc/threads/...` to the new home), moves `threads/`, copies
`.env`, seeds `pi/agent/` from `~/.pi/agent` per the copy list above, moves the `~/.lhc/.git`
snapshot history and installs `backup.sh` in the new home, prints a summary, and leaves whatever
remains of `~/.lhc` in place as rollback. **Known data hazard:** the real registry contains rows
whose `file_path` points at `/var/folders/...` temp-dir test threads from early development that no
longer exist on disk. Skip those rows with a per-row line in the summary; do not fail the migration
on them and do not invent repair logic. The `backup.sh` the script installs must come from a repo
source (add `scripts/pi-lhc-backup.sh`, adapted from the one in `~/.lhc`) so the migration path and
the fresh-install path (slice 4) install the identical script rather than two drifting copies. Tests run against fixture homes built in temp dirs —
never against the real `~/.lhc`. Include an underscore-level path edge or two (spaces, dots) in
fixtures; cheap insurance, not a guard farm.

### Slice 4 — setup doc + docs sync

`.setup/pi-lhc-standalone.md` in the exact shape of `cc-lhc-standalone.md` (stepwise, each step
with a verification, failure = stop and report). Differences from the cc-lhc doc that must be
covered: recursive clone with `vendor/pi` **built** (cc-lhc never builds it; pi-lhc requires it),
the `pnpm-workspace.yaml` overrides gotcha (`pi-ai`/`pi-agent-core`/`pi-tui` forced to
`vendor/pi` — see root README), shim install, first run creating `~/.pi-lhc`, auth setup writing
into the new home, and a verification launch. Extend `.setup/scripts/check-prereqs.mjs` with a
pi-lhc lane if needed. The setup doc must include a step installing the backup rail into the fresh
home from `scripts/pi-lhc-backup.sh` — fresh installs never run the migration, so without this step
only migrated homes get backups. Root README gets a kickoff section mirroring the cc-lhc one.
Finally, the setup doc earns trust the way the cc-lhc one did — a cold run by a fresh agent against
a fresh clone. That cold run is **not part of this slice** (it needs operator-provided auth on a
clean environment); name it explicitly in your final report as the required follow-up so it does
not silently drop.
`docs/onboard/04-host-pi-lhc.md` and `packages/pi-lhc/README.md` get the new home story. Close
backlog item 26 (delete or rewrite the entry to reflect what shipped).

### Live checkpoint — operator-run, not yours

The real migration on Lee's machine happens between pi-lhc sessions, run by Lee (or by you only if
Lee explicitly says so, after confirming no pi-lhc process is running). Acceptance: relaunch a real
thread from the new home. You prepare the exact command sequence in the slice-3 report; you do not
execute it against the real homes.

## Orchestration doctrine (how we run subagents here)

Current roster ruling (Lee, 2026-07-10): **Grok 4.5 high builds. GPT-5.6-sol high verifies —
verification only, no implementation seats** (community reports of over-tenacious behavior; ruling
stands until Lee revisits). Composer remains available for trivial dictated diffs. You are the
orchestrator: write briefs, monitor, consolidate reviews, make the call on fix rounds, do the final
full-context review yourself.

Dispatch commands (from repo root):

```bash
# builder
grok-subagent start - --model grok-4.5 --reasoning-effort high < /tmp/<slice>-brief.md
# verifier
codex-subagent start --prompt-file /tmp/verify-<sha>.md --model gpt-5.6-sol -c model_reasoning_effort=high
# status / result
grok-subagent status <run_id>; grok-subagent result <run_id>
codex-subagent status <run_id>; codex-subagent result <run_id>
```

If a wrapper behaves unexpectedly, the full flag surface is documented in the skill files at
`~/.agents/skills/<name>-subagent/SKILL.md` and via `<cli> --help` — check those before improvising.

Known wrapper facts: grok's envelope returns `session_id: null` — **grok runs are not resumable**;
fix rounds go to a *fresh* grok session whose brief points at the verifier's report file and names
the commit to amend on top of. Grok typically finishes small slices in 1.5–3.5 minutes — poll at
~90s. 5.6-sol verification runs take ~5–10 minutes — first poll at 3 minutes. Grok has skipped the
Biome formatter before: every builder brief should require `biome check` clean on changed files,
and every verify brief should check it.

Brief shape (Lee's ruling): open with what the agent **is doing**; detail in the middle; a single
closing line for what not to do ("Do not make edits, updates, or deletes" for verifiers; "Do not
push" for builders). Don't front-load prohibition lists. Verifier briefs state the role in the
first sentence ("You are the verification reviewer for commit X").

Acceptance-criteria hygiene, learned the hard way: never hand a verifier criteria that contradict
the builder's brief (e.g., "confirm all prior findings resolved" when one was deliberately ruled
out of scope). List ruled-out items explicitly as ruled out.

Process rules that bind you: work stays uncommitted until a slice is settled, one logical commit
per slice, **push only when Lee says push**. Do not expand scope on your own judgment — if a slice
uncovers something bigger (e.g., a real `.env` runtime consumer, or a PI surface that escapes
`agentDir`), stop and report rather than improvising. Edge cases must pull their weight: no
unrequested guards, no no-op detection, no defensive branches for shapes the producers cannot
produce. When a review returns findings, classify don't-fix candidates against that rule before
dispatching a fix round.

## Suites and gates

Per slice: `pnpm --filter pi-lhc test` and typecheck; `pnpm --filter lhc test` if lhc was touched
(it should not be, per slice 1's note); cc-lhc/codex-lhc only if lhc changed. Biome check on
changed files. Parallel suite runs can produce unrelated 5-second timeouts under load — rerun
serially before believing a failure. codex-lhc has 8 known date-pinned intake fixture failures;
they are pre-existing and not yours.

## Report back

At the end (or when blocked): per-slice commit SHAs with one-line what/why, verifier verdicts and
how findings were dispositioned, the `.env` answer, any PI surface that resisted relocation, the
prepared migration command sequence for the checkpoint, the cold-run follow-up called out
explicitly, and anything you deliberately did not do.
