# Host integrations — how LHC stays attached to its harnesses

Last verified against code: 2026-08-14. Precedence when facts disagree: code,
then each fork's `FORK.md`, then this doc.

LHC is an SDK; every harness it serves needs an integration surface. Because
the harnesses are other people's actively developed projects, each integration
carries a maintenance obligation, and the shape of that obligation depends on
what the harness offers. Three patterns exist:

1. **Native fork** — the harness is open source but has no extension surface
   rich enough for LHC, so we maintain a fork with LHC compiled in-process and
   a patch process that survives upstream's velocity. Hosts: **codex**,
   **grok**, **hermes**.
2. **Extension** — the harness has a real extension API, so LHC rides it with
   no fork to maintain. Host: **pi**.
3. **Wrapper** — the harness is closed source, so LHC takes the outside
   position around the process. Host: **claude code** (cc-lhc).

## The fork-maintenance doctrine (pattern 1)

All three forks follow the same discipline, tuned per upstream. The point of
every rule is the same: make the fork's footprint in upstream-owned files so
small, so marked, and so verified that thousands of upstream commits reduce to
a small, mechanical repair job.

- **Two branches.** `main` is an untouched upstream mirror, fast-forwarded at
  every sync. The integration branch (`lhc` / `lhc-engine`) is the default
  branch and carries the patch as ordinary commits.
- **Tiny marked touchpoints.** Every fork-owned line in an upstream file is a
  small additive insertion with a counted marker (`LHC-HOOK n/total`,
  `LHC-FORK HOOK`). Everything substantial lives in a self-contained adapter
  directory upstream never touches.
- **A tripwire gate.** A script or test that asserts the marker count, builds
  the adapter, and runs its suites. Run after every sync, before every push.
- **A sync drill.** Written steps in `FORK.md`, including the expected
  recurring conflicts and their resolution rules. Sync results are appended
  to a sync-record log in the same file.
- **A recovery model matched to upstream's history discipline:**
  - *State-diff patches from a recorded base* (codex, grok): one `git diff`
    per touchpoint area (codex) or one total (grok), generated from the
    upstream commit named in `patches/…/BASE`, applied with
    `git apply --3way`. Chosen because these upstreams squash-sync or may
    reset history — ancestry is a convenience, not a guarantee, so the patch
    files are the durable representation of the fork. Commit-anchored
    `format-patch` series were tried and failed in both forks (they rot at
    every sync); the state-diff ruling is recorded in each `patches/README`.
    **Advancing `BASE` and regenerating is part of every sync, not cleanup.**
  - *Merge-forward, no patch files* (hermes): upstream keeps real,
    never-rewritten history, so plain merges carry the hook commits and a
    patch mechanism would be dead weight. Recovery worst-case is re-applying
    three small marked insertions by hand from the `FORK.md` inventory.
- **Vendored LHC port pins.** The Rust forks vendor `lhc-rs` as a submodule
  pinned to certified `lhc-rs-port` commits only; hermes consumes `lhc-py`.
  Pin bumps are recorded in `FORK.md` alongside the sync that made them.

## Host inventory

| Host | Upstream | Fork / integration | Local | Patch model | Gate | Launcher |
|---|---|---|---|---|---|---|
| codex | openai/codex (~760 commits/mo) | liminal-ai/codex-lhc, branch `lhc` | `/srv/work/codex` | state diffs from `patches/lhc/BASE` | `scripts/check-lhc-hooks.sh` (52 markers + full matrix) | `codex-lhc` (LHC on by default; `lhc_capture = false` is the kill switch) |
| grok | xai-org/grok-build (daily monorepo squash-syncs; may reset history) | liminal-ai/grok-build-lhc, branch `lhc` | `/srv/work/grok-build` | one state diff from `patches/BASE` | `scripts/check-lhc-hooks.sh` (10 markers + suites) | `grok` (LHC on by default; `GROK_LHC=0` is the kill switch) |
| hermes | NousResearch/hermes-agent (~150 commits/day, stable history) | liminal-ai/hermes-lhc, branch `lhc-engine` | `/srv/work/hermes-agent` | merge-forward, no patch files | plugin pytest suite incl. hook tripwire + host-contract tests | `hermes` (editable install; `context.engine: lhc`) |
| pi | earendil-works/pi | none needed — extension | `packages/pi-lhc` + `vendor/pi` submodule | n/a (stock upstream pin) | `pnpm --filter pi-lhc run verify` | `pi-lhc` |
| claude code | closed source | none possible — wrapper | `packages/cc-lhc` | n/a | `pnpm --filter cc-lhc` verify | `cc-lhc` |

Per-fork SOPs: `/srv/work/codex/FORK.md`, `/srv/work/grok-build/FORK.md`,
`/srv/work/hermes-agent/FORK.md`. Each documents its touchpoint inventory,
sync drill, recovery drill, and sync record; those files are canonical for
their fork.

## Quick status assessment (start here when returning cold)

How far behind is each fork, and is anything stranded locally:

```bash
for d in /srv/work/codex /srv/work/grok-build /srv/work/hermes-agent; do
  git -C $d fetch upstream -q
  echo "$d: behind=$(git -C $d rev-list --count HEAD..upstream/main) \
       unpushed=$(git -C $d log --oneline @{u}.. | wc -l) \
       dirty=$(git -C $d status --porcelain | wc -l)"
done
cd /srv/work/long-horizon-context/vendor/pi && git fetch origin -q && \
  echo "vendor/pi: behind=$(git rev-list --count HEAD..origin/main)"
```

Then: if a fork needs a sync, open its `FORK.md` and execute its **Sync
drill** section verbatim — do not improvise the steps from memory; the drills
encode failure modes already paid for (BASE advancement, expected conflicts,
test invocation quirks, the smoke procedures). After any `lhc-rs`/`lhc-py`
change, the vendored pins in the Rust forks are bumped as part of a sync,
never casually.

## codex (native fork)

Adapter crate `codex-rs/lhc/codex-lhc-host` plus vendored `lhc-rs` submodule
(`codex-rs/lhc/vendor/long-horizon-context`). LHC capture and compact are on
by default because this is the product fork. The troubleshooting kill switch
is `lhc_capture = false`. Storage is under `~/.codex/lhc/`. The launcher
`codex-lhc` runs the fork's release binary. The retired
TypeScript wrapper (`packages/codex-lhc`) was deleted 2026-08-06 — this fork
is the sole Codex integration.

## grok (native fork)

Adapter crate `crates/lhc/grok-lhc-host` plus vendored `lhc-rs`. Capture,
serving, and Replace compact are on by default in the product fork. Disable
LHC only for troubleshooting with `GROK_LHC=0` or
`[lhc] enabled = false`. There is no Shadow compact path. Storage defaults to
`~/.grok-lhc` (override with `GROK_LHC_ROOT` or `[lhc].root`). Derivation
inference defaults to grok-4.5 at low thinking.
Upstream accepts no external PRs and may rewrite history — the patch file is
the fork's durable form; the recovery drill is rehearsed.

## hermes (native fork)

Integration is `plugins/context_engine/lhc/` (built on `lhc-py`) plus three
`LHC-FORK HOOK` insertions in core: per-turn capture at the session-DB flush,
turn host facts in the finalizer, and verbatim provider usage on the
response-usage seam. Selected per profile with `context.engine: lhc`. The
production install runs editable from the tree — merges go live at the next
process start; running gateways need a restart. Never run `hermes update`.

## pi (extension — no fork maintenance)

PI's extension API is rich enough to host LHC outright: `packages/pi-lhc`
registers hooks for capture, intercepts `session_before_compact` to replace
native compaction with LHC smart compact, seeds sessions from thread views,
and owns per-model auto-compact triggers at the settled boundary. PI itself is
vendored as the `vendor/pi` submodule **pinned to stock upstream** — the pin
exists for build reproducibility (pnpm `file:` overrides), not for carrying
patches. A fork of pi exists (`leegmoore/pi`) but carries no live patches:
the 2026-08-06 OAuth patch stack was retired to branch
`archive/oauth-patches-2026-08` after the underlying issue proved not to be a
bug. Upgrading PI is a submodule pin bump + rebuild + `pi-lhc` verify, with
migration fixes in `pi-lhc` when the extension surface moves — host docs:
`docs/onboard/04-host-pi-lhc.md`.

## claude code (wrapper — no fork possible)

Claude Code is closed source with hooks too limited to host LHC, so `cc-lhc`
takes the outside position: it owns the `claude` process under a PTY with
transparent passthrough, **watches the rollout JSONL** Claude Code writes and
captures those records into the LHC thread, and exposes LHC commands through a
leader-key modal (ctrl-]). Compact/prune **rebuilds a fresh rollout file** from
the thread view. For a respawn-safe launch, the wrapper terminates the old
child and starts a new child with external `--resume <new-id>` after lineage,
capture, and liveness checks succeed. User-issued in-app `/resume` is not a
supported handoff path. A launch form that cannot be replayed safely receives
an explicit external-resume receipt instead. Maintenance obligation: none
against a fork — but the rollout format and resume mechanics are
reverse-engineered, so Claude Code releases can move them silently; the
wrapper's format mapping is the brittle seam. Host docs:
`docs/onboard/05-host-cc-lhc.md`.

## t3code (external fork, docs here)

`packages/t3code-lhc` is documentation only; the working integration lives in
the maintained T3 Code fork (`liminal-ai/t3code`, branch `lhc`, upstream
`pingdotgg/t3code`). It follows the native-fork pattern but is tracked in its
own repo.
