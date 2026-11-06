---
name: verify-lhc
description: Verify core lhc (Long Horizon Context SDK) end to end: thread round trip through the SDK and lhc CLI, retrieval (getTurns/getMessages), host rollback, the thread's compact policy, and the membank domain against a live membase. Use when asked to verify, smoke-test, or regression-check packages/lhc.
---

# verify-lhc

Drives core `lhc` only (`packages/lhc`): the SDK surface from `initLhc` and the thin `lhc thread` CLI (`packages/lhc/bin/lhc`, verbs in `src/cli.ts`). Hosts (`claude-lhc`, `cc-lhc`) have their own skills; do not drive them from here.

Surface facts (from the code, re-check if a drive breaks):

- A home is `<dir>/registry.sqlite` plus `<dir>/threads/*.sqlite`. The CLI takes `--home <dir>`; the SDK takes explicit `filePath` + `registryPath`.
- Seeding is `threads.newThread` then `intakeStream.messageEvents` then `work.drain` (manual mode). Events need `eventKind`, unique `idempotencyKey`, `actor`, `harness`, and a per-kind `payload`.
- Deterministic inference: `createDeterministicInferenceCallbacks()` with `tokenFamily: "o200k"`, `mode: "manual"`. No network, no real model.
- Serving is `threadView.getLlmRequestContext` / `getSessionThreadView`; compact is `threadView.compact`; retrieval is `retrieval.getTurns` / `getMessages` by `t…` / `m…` id.
- The compact policy is `threads.getCompactPolicy` / `threads.setCompactPolicy`, two nullable columns on `thread_metadata` (thread schema 14). Opening a schema-13 file through the SDK or the CLI migrates it in place.
- Membank is `sdk.membank.attach` / `detach` / `attachment` / `list` / `get`. It needs a running membase: `initLhc({ ...config, membase: { socketPath } })` returns a promise that rejects with `MembaseHandshakeError` (`code` `membase_unreachable`, `membase_version_mismatch` or `membase_unavailable`) unless membase answers `Health`. Without `membase`, every `membank` op answers `membank_not_configured`.
- A host rollback is one `rollback` intake event with payload `{ keepThroughEventOrder }`. Every served view and the CLI export drop what was recorded after the anchor. `turns.listTurns` and the export keep the open turn, empty when every member was hidden; `messages.list({ includeDeleted: true })` still shows hidden messages as `deleted: true`.

## Launch

From the repo root, in a clean shell (nothing inherited):

```sh
pnpm install --filter lhc
pnpm --filter lhc run build
node .agents/skills/verify-lhc/helpers/doctor.mjs
```

Launch reaches a usable state from an empty data dir because every drive creates its own temp home under the run folder (see Evidence); there is no server to start and no port to wait on. Ready line: `verify-lhc doctor: PASS`.

## Doctor

One read-only worth-driving check: node >= 24.3 (the `engines` floor of `packages/lhc`), `packages/lhc/dist/index.js` exists, `node packages/lhc/bin/lhc` prints the usage block, and the SDK exports `initLhc` + `createDeterministicInferenceCallbacks`.

```sh
node .agents/skills/verify-lhc/helpers/doctor.mjs
```

If doctor fails on a missing dist, run the Launch build. Do not drive on a failed doctor.

## Drive

Four seeded drives need nothing running. The membank drive needs a membase lane. Each drive prints one `PASS` line and exits non-zero on any failed assertion.

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

Compact policy: read, set, refuse, copy, fork ([features/compact-policy.md](features/compact-policy.md)):

```sh
node .agents/skills/verify-lhc/helpers/compact-policy.mjs
node .agents/skills/verify-lhc/helpers/compact-policy.mjs --migrate <schema-13 thread file>
```

- User-only check: a new thread reads `null`, and after `setCompactPolicy` it, its copy and its fork read back the same pair.
- Outcome check: `--migrate` backs up a real thread file into the temp home, opens the copy, and shows `user_version` 14, a `null` policy and the source's event count. The source is opened read-only and never changes.

Membank: attach, list, get, detach against membase ([features/membank.md](features/membank.md)). Start and seed a membase lane through the membase repo's `verify-membase` skill first. The feature file gives the steps.

```sh
node .agents/skills/verify-lhc/helpers/membank.mjs --socket <membase socket> --bank <seeded bank>
node .agents/skills/verify-lhc/helpers/membank.mjs --socket <stopped membase socket> --expect-unreachable
node .agents/skills/verify-lhc/helpers/membank-perf.mjs --socket <membase socket> --bank <seeded bank> --trunk-dist <trunk>/packages/lhc/dist/index.js
```

- User-only check: every item the bank holds comes back through `list` and `get` with the text membase stored (`--expect <items.json>` checks it exactly).
- Outcome check: with membase stopped, `initLhc` rejects with `membase_unreachable` in under 5 seconds.

The headless e2e drives every membank operation and error code against a real membase and dev Convex. It boots its own lane with `lane.sh` from `$MEMBASE_REPO` (default `~/lim-v2/code/membase`, which must be installed with `scripts/offline-install.sh`), and runs a second membase service at API version 2 for the mismatch case. It needs Docker, so CI does not run it:

```sh
MEMBASE_REPO=<membase checkout> pnpm --filter lhc e2e
```

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
node .agents/skills/verify-lhc/helpers/compact-policy.mjs > "$EVIDENCE/compact-policy.txt" 2>&1
node .agents/skills/verify-lhc/helpers/check-links.mjs > "$EVIDENCE/check-links.txt" 2>&1
grep -h PASS "$EVIDENCE"/*.txt
```

Receipts in a verdict, a PR or a report cite files under `<run>/proof/` only, never `<run>/scratch/`.

Pass lines: `verify-lhc doctor: PASS`, `verify-lhc round-trip: PASS`, `verify-lhc retrieval: PASS`, `verify-lhc rollback: PASS`, `verify-lhc compact-policy: PASS`, `verify-lhc check-links: PASS`. With a membase lane up, also save `membank.mjs` and `membank-perf.mjs` output, which print `verify-lhc membank: PASS`, `verify-lhc membank unreachable: PASS` and `verify-lhc membank-perf: PASS`. For a lane or PR, also record `git rev-parse HEAD` beside the logs. Terminal screenshots of these runs satisfy the plan's `.png` evidence names where a harness captures them.

Regression companion (existing checks, not a substitute for the drives):

```sh
pnpm --filter lhc run typecheck
pnpm --filter lhc exec vitest run test/retrieval.test.ts test/threads.test.ts test/sqlite-concurrent-open.test.ts test/registry-alias-concurrency.test.ts
```

`registry-x20`, the registry multi-process test 20 times in a row, for the changes Re-verification names. It stops at the first failed run, keeps every run's output in the log, and prints `verify-lhc repeat-test: PASS 20 of 20` or a `FAIL:` line naming the run. A run fails when vitest exits non-zero or prints `No test files found`, which vitest otherwise exits 0 on. Twenty passes show the race did not reproduce in 20 runs. They do not measure a flake rate.

```sh
node .agents/skills/verify-lhc/helpers/repeat-test.mjs --runs 20 --log "$EVIDENCE/registry-x20.log" test/registry-alias-concurrency.test.ts
```

Promote the WAL stress script (`.pstack/runs/membase-slice1/proof/WAL-RACE/verifier/stress.mjs` in the main checkout) only after one of these tests flakes in CI or in a suite run, and fix its exit status and timeout first.

`pnpm --filter lhc run test -- <files>` ignores the files and runs the whole suite. Tests that spawn tsx, `registry-alias-concurrency.test.ts` among them, open a socket at `$TMPDIR/tsx-<uid>/<pid>.pipe`, which fails with `listen EINVAL` once that path passes 108 bytes. A `TMPDIR` under the run folder can push it past, so use a short one such as `~/.local/state/verify-lhc-tmp`.

## Cleanup

Drives delete their temp homes in a `finally` block, also when an assertion fails: `fail()` throws, and each helper's outer catch prints `FAIL: <reason>` and exits 1 after the `finally` ran. Remove a `--keep` home with the helper, not a raw `rm` (it refuses anything but a `verify-lhc-*` home directly under `<run>/scratch/`):

```sh
node .agents/skills/verify-lhc/helpers/cleanup.mjs <printed-dir>
```

Nothing writes outside the temp home except evidence you redirect yourself. No processes are left running; there is no server. A membase lane is the exception: stop it with `lane.sh down <lane-dir>` from the membase checkout, which stops only that lane's service and Convex container.

## Helpers

All under [helpers/](helpers/), plain node ESM, importing the built SDK from `packages/lhc/dist/index.js`:

- `helpers/lib.mjs` — temp home under `<run>/scratch/`, SDK construction, seeded events (6 closed turns, one tool run).
- `helpers/doctor.mjs` — read-only readiness check (see Doctor).
- `helpers/round-trip.mjs` — create/append/compact/serve + CLI health. Flags: `--keep`, `--home DIR`.
- `helpers/retrieval.mjs` — `getTurns`/`getMessages` served + unserved assertions.
- `helpers/rollback.mjs` — rollback behind the compact point, append, recompact, CLI export. Flag: `--keep`.
- `helpers/compact-policy.mjs` — get, set, refuse, copy and fork the compact pair. Flag: `--migrate FILE` backs up a real thread file and migrates the copy.
- `helpers/membank.mjs` — attach, list, get and detach against a membase socket. Flags: `--socket PATH`, `--bank NAME`, `--expect FILE`, `--expect-unreachable`.
- `helpers/membank-perf.mjs` — construction time with and without membase, warm and in fresh processes, and `membank.get` latency. Flags: `--socket PATH`, `--bank NAME`, `--trunk-dist FILE`, `--runs N`, `--cold-runs N`, `--calls N`.
- `helpers/repeat-test.mjs` — runs `pnpm --filter lhc exec vitest run <files>` up to `--runs N` times (default 20), stops at the first run that exits non-zero or finds no test files, and appends each run's output to `--log FILE`. Files are relative to `packages/lhc`.
- `helpers/cleanup.mjs` — removes `--keep` homes. Args: one or more printed dirs.
- `helpers/check-links.mjs` — every relative link and `helpers/*.mjs` path in this skill resolves on disk.

Feature map: [features/README.md](features/README.md).

## Re-verification

Every lane here runs only `packages/lhc`, through its built `dist/` and `bin/lhc`. Which other skills a `packages/lhc` change reruns is in the table in `.agents/merge-brief.md`.

- **Reruns every lane:** a change in `packages/lhc/` outside `test/` and Markdown, or to `helpers/lib.mjs`. When the brief routes a root change here (the root `package.json`, `pnpm-workspace.yaml`, the lockfile, or the Node or pnpm version `.github/workflows/pr-checks.yml` pins), rerun every lane too. A rebase onto a trunk that changed any of these counts.
- **Reruns one lane:** a change to that lane's helper or its block in Drive.
- **Reruns the membank drive, its perf probe and `pnpm --filter lhc e2e`:** a change to `packages/lhc/e2e/` or to the membase checkout they run against. When the brief routes a `vendor/membase/` change here, rerun the same three.
- **Reruns `registry-x20`:** a change to `packages/lhc/src/shared-tech/storage.ts`, to the callers that open databases through it (`threads/internal/create.ts`, `threads/internal/registry.ts`, `shared-tech/logging/`), or to the Node version `pr-checks.yml` pins, on top of what the rules above rerun. Also a change to `helpers/repeat-test.mjs`.
- **Carries:** the rerun rules above take precedence. A change only in packages the brief does not route here, or in `packages/lhc/test/`, carries. Markdown that is test input, such as fixtures and goldens, follows the `test/` rule. Prose-only Markdown anywhere, top-level `docs/` and this skill included, carries only when it changes no lane's setup, actions, assertions, expected outcomes, evidence or cleanup. Any path no rule here names reruns every lane. `doctor.mjs` and `check-links.mjs` always rerun.
