---
name: verify-lhc
description: Verify core lhc (Long Horizon Context SDK) end to end: thread round trip through the SDK and lhc CLI, retrieval (getTurns/getMessages), and host rollback. Use when asked to verify, smoke-test, or regression-check packages/lhc.
---

# verify-lhc

Drives core `lhc` only (`packages/lhc`): the SDK surface from `initLhc` and the thin `lhc thread` CLI (`packages/lhc/bin/lhc`, verbs in `src/cli.ts`). Hosts (`claude-lhc`, `cc-lhc`) have their own skills; do not drive them from here.

Surface facts (from the code, re-check if a drive breaks):

- A home is `<dir>/registry.sqlite` plus `<dir>/threads/*.sqlite`. The CLI takes `--home <dir>`; the SDK takes explicit `filePath` + `registryPath`.
- Seeding is `threads.newThread` then `intakeStream.messageEvents` then `work.drain` (manual mode). Events need `eventKind`, unique `idempotencyKey`, `actor`, `harness`, and a per-kind `payload`.
- Deterministic inference: `createDeterministicInferenceCallbacks()` with `tokenFamily: "o200k"`, `mode: "manual"`. No network, no real model.
- Serving is `threadView.getLlmRequestContext` / `getSessionThreadView`; compact is `threadView.compact`; retrieval is `retrieval.getTurns` / `getMessages` by `t…` / `m…` id.
- A host rollback is one `rollback` intake event with payload `{ keepThroughEventOrder }`. Every served view and the CLI export drop what was recorded after the anchor, except that the open turn survives as an empty turn; `messages.list({ includeDeleted: true })` still shows hidden messages as `deleted: true`.

## Launch

From the repo root, in a clean shell (nothing inherited):

```sh
pnpm install --filter lhc
pnpm --filter lhc run build
node .agents/skills/verify-lhc/helpers/doctor.mjs
```

Launch reaches a usable state from an empty data dir because every drive creates its own temp home under the run folder (see Evidence); there is no server to start and no port to wait on. Ready line: `verify-lhc doctor: PASS`.

## Doctor

One read-only worth-driving check: node >= 24, `packages/lhc/dist/index.js` exists, `node packages/lhc/bin/lhc` prints the usage block, and the SDK exports `initLhc` + `createDeterministicInferenceCallbacks`.

```sh
node .agents/skills/verify-lhc/helpers/doctor.mjs
```

If doctor fails on a missing dist, run the Launch build. Do not drive on a failed doctor.

## Drive

Three seeded drives. Each prints one `PASS` line and exits non-zero on any failed assertion.

Round trip — create, append, compact, serve ([features/thread-round-trip.md](features/thread-round-trip.md)):

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs
```

- User-only check: after compact, `getLlmRequestContext` still serves the seeded conversation a host would send to a model.
- Outcome check: the same home passes `lhc thread health --home <dir> --thread-id <id>` through the real CLI binary.

Retrieval — `getTurns` / `getMessages` ([features/retrieval.md](features/retrieval.md)):

```sh
node .agents/skills/verify-lhc/helpers/retrieval.mjs
```

- User-only check: `getMessages` returns the seeded prompt verbatim.
- Outcome check: an unknown id (`t999`) comes back as an explicit unserved receipt, never silently empty.

Rollback — rewind, append, recompact, export ([features/rollback.md](features/rollback.md)):

```sh
node .agents/skills/verify-lhc/helpers/rollback.mjs
```

- User-only check: after the rollback, the served views and the `lhc thread export` file hold the kept turn and the new turn in order, and no discarded text, including text that sat behind the compact point.
- Outcome check: the record still holds the four hidden messages under the deleted contract. Any refused rollback batch exits 3 with `verify-lhc rollback: UNSUPPORTED (this build has no rollback event)`. A build from before the event (PR #25) gives that result, and so does an anchor at or past the rollback's own event order.

CLI thread ops against an existing home are covered in [features/cli-thread-ops.md](features/cli-thread-ops.md). Use `--keep` on the round trip to leave its home in place for manual CLI poking:

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs --keep
node packages/lhc/bin/lhc thread health --home <printed-dir> --thread-id <printed-id>
```

## Evidence

Drives make their temp homes under `<run>/scratch/`, where `<run>` is `$VERIFY_RUN_DIR`, default `.pstack/runs/verify-lhc` in the main checkout (the first entry of `git worktree list`; `.pstack/` is git-ignored). Nothing goes to `/tmp`. Save drive output under `<run>/proof/` so it survives cleanup:

```sh
RUN="${VERIFY_RUN_DIR:-$(git worktree list --porcelain | sed -n '1s/^worktree //p')/.pstack/runs/verify-lhc}"
EVIDENCE="${VERIFY_LHC_EVIDENCE:-$RUN/proof}"
mkdir -p "$EVIDENCE"
node .agents/skills/verify-lhc/helpers/doctor.mjs > "$EVIDENCE/doctor.txt" 2>&1
node .agents/skills/verify-lhc/helpers/round-trip.mjs > "$EVIDENCE/round-trip.txt" 2>&1
node .agents/skills/verify-lhc/helpers/retrieval.mjs > "$EVIDENCE/retrieval.txt" 2>&1
node .agents/skills/verify-lhc/helpers/rollback.mjs > "$EVIDENCE/rollback.txt" 2>&1
node .agents/skills/verify-lhc/helpers/check-links.mjs > "$EVIDENCE/check-links.txt" 2>&1
grep -h PASS "$EVIDENCE"/*.txt
```

Pass lines: `verify-lhc doctor: PASS`, `verify-lhc round-trip: PASS`, `verify-lhc retrieval: PASS`, `verify-lhc rollback: PASS`, `verify-lhc check-links: PASS`. For a lane or PR, also record `git rev-parse HEAD` beside the logs. Terminal screenshots of these runs satisfy the plan's `.png` evidence names where a harness captures them.

Regression companion (existing checks, not a substitute for the drives):

```sh
pnpm --filter lhc run typecheck
pnpm --filter lhc exec vitest run test/retrieval.test.ts test/threads.test.ts
```

`pnpm --filter lhc run test -- <files>` ignores the files and runs the whole suite. Tests that spawn tsx open a socket at `$TMPDIR/tsx-<uid>/<pid>.pipe`, which fails with `listen EINVAL` once that path passes 108 bytes. A `TMPDIR` under the run folder can push it past, so use a short one such as `~/.local/state/verify-lhc-tmp`.

## Cleanup

Drives delete their temp homes in a `finally` block. Remove a `--keep` home with the helper, not a raw `rm` (it refuses anything but a `verify-lhc-*` home directly under `<run>/scratch/`):

```sh
node .agents/skills/verify-lhc/helpers/cleanup.mjs <printed-dir>
```

Nothing writes outside the temp home except evidence you redirect yourself. No processes are left running; there is no server.

## Helpers

All under [helpers/](helpers/), plain node ESM, importing the built SDK from `packages/lhc/dist/index.js`:

- `helpers/lib.mjs` — temp home under `<run>/scratch/`, SDK construction, seeded events (6 closed turns, one tool run).
- `helpers/doctor.mjs` — read-only readiness check (see Doctor).
- `helpers/round-trip.mjs` — create/append/compact/serve + CLI health. Flags: `--keep`, `--home DIR`.
- `helpers/retrieval.mjs` — `getTurns`/`getMessages` served + unserved assertions.
- `helpers/rollback.mjs` — rollback behind the compact point, append, recompact, CLI export. Flag: `--keep`.
- `helpers/cleanup.mjs` — removes `--keep` homes. Args: one or more printed dirs.
- `helpers/check-links.mjs` — every relative link and `helpers/*.mjs` path in this skill resolves on disk.

Feature map: [features/README.md](features/README.md).

## Re-verification

Every lane here runs only `packages/lhc`, through its built `dist/` and `bin/lhc`.

- **Reruns every lane:** a change in `packages/lhc/` outside `test/` and Markdown, to the lockfile entries lhc resolves, or to `helpers/lib.mjs`. A change to the root `package.json` or `pnpm-workspace.yaml`, or to the Node or pnpm version `.github/workflows/pr-checks.yml` pins, counts too. A rebase onto a trunk that changed any of these counts.
- **Reruns one lane:** a change to that lane's helper or its block in Drive.
- **Carries:** a change only in other packages, `packages/lhc/test/`, or text in this skill and its `features/` that changes no lane's setup, actions, assertions, expected outcomes, evidence or cleanup. `doctor.mjs` and `check-links.mjs` always rerun.
