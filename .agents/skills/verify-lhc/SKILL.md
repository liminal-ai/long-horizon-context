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
- A host rollback is one `rollback` intake event with payload `{ keepThroughEventOrder }`. Every served view and the CLI export drop what was recorded after the anchor; `messages.list({ includeDeleted: true })` still shows it as `deleted: true`.

## Launch

From the repo root, in a clean shell (nothing inherited):

```sh
pnpm install --filter lhc
pnpm --filter lhc run build
node .agents/skills/verify-lhc/helpers/doctor.mjs
```

Launch reaches a usable state from an empty data dir because every drive creates its own temp home; there is no server to start and no port to wait on. Ready line: `verify-lhc doctor: PASS`.

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
- Outcome check: the record still holds the four hidden messages under the deleted contract. A build without the event exits 3 with `verify-lhc rollback: UNSUPPORTED`, which is the trunk result for a regression lane.

CLI thread ops against an existing home are covered in [features/cli-thread-ops.md](features/cli-thread-ops.md). Use `--keep` on the round trip to leave its home in place for manual CLI poking:

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs --keep
node packages/lhc/bin/lhc thread health --home <printed-dir> --thread-id <printed-id>
```

## Evidence

Save drive output outside the temp home so it survives cleanup:

```sh
mkdir -p /tmp/verify-lhc-evidence
node .agents/skills/verify-lhc/helpers/doctor.mjs > /tmp/verify-lhc-evidence/doctor.txt 2>&1
node .agents/skills/verify-lhc/helpers/round-trip.mjs > /tmp/verify-lhc-evidence/round-trip.txt 2>&1
node .agents/skills/verify-lhc/helpers/retrieval.mjs > /tmp/verify-lhc-evidence/retrieval.txt 2>&1
node .agents/skills/verify-lhc/helpers/rollback.mjs > /tmp/verify-lhc-evidence/rollback.txt 2>&1
node .agents/skills/verify-lhc/helpers/check-links.mjs > /tmp/verify-lhc-evidence/check-links.txt 2>&1
grep -h PASS /tmp/verify-lhc-evidence/*.txt
```

Pass lines: `verify-lhc doctor: PASS`, `verify-lhc round-trip: PASS`, `verify-lhc retrieval: PASS`, `verify-lhc rollback: PASS`, `verify-lhc check-links: PASS`. For a lane or PR, also record `git rev-parse HEAD` beside the logs. Terminal screenshots of these runs satisfy the plan's `.png` evidence names where a harness captures them.

Regression companion (existing checks, not a substitute for the drives):

```sh
pnpm --filter lhc run typecheck
pnpm --filter lhc run test -- test/retrieval.test.ts test/threads.test.ts
```

## Cleanup

Drives delete their temp homes in a `finally` block. A `--keep` home is yours to remove:

```sh
rm -rf <printed-dir>
```

Nothing writes outside the temp home except evidence you redirect yourself. No processes are left running; there is no server.

## Helpers

All under [helpers/](helpers/), plain node ESM, importing the built SDK from `packages/lhc/dist/index.js`:

- `helpers/lib.mjs` — temp home, SDK construction, seeded events (6 closed turns, one tool run).
- `helpers/doctor.mjs` — read-only readiness check (see Doctor).
- `helpers/round-trip.mjs` — create/append/compact/serve + CLI health. Flags: `--keep`, `--home DIR`.
- `helpers/retrieval.mjs` — `getTurns`/`getMessages` served + unserved assertions.
- `helpers/rollback.mjs` — rollback behind the compact point, append, recompact, CLI export. Flag: `--keep`.
- `helpers/check-links.mjs` — every relative link and `helpers/*.mjs` path in this skill resolves on disk.

Feature map: [features/README.md](features/README.md).
