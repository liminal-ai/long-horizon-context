# Membank

## Sub-features

- `handshake`: `await initLhc({ ...config, membase: { socketPath } })` calls membase's `Health` RPC and resolves to the SDK only when it answers. Otherwise it rejects with a `MembaseHandshakeError` whose `code` is `membase_unreachable`, `membase_version_mismatch` or `membase_unavailable`.
- `attach`, `attachment`, `detach`: `sdk.membank.attach(ref, bank)` attaches the thread to a membase bank, `attachment(ref)` reads it back, and `detach(ref)` removes it.
- `list`, `get`: `sdk.membank.list(ref, kind?)` returns the attached bank's item summaries, and `sdk.membank.get(ref, id)` returns one item with its body.
- `not-configured`: an SDK built without `membase` answers `membank_not_configured` on every `membank` operation.

## How to get to it (user POV)

A person keeps lessons and skills in a membase bank and attaches a session's thread to that bank, so the agent on that thread can see the bank's items. LH-3 gives claude-lhc agents the tools. In core, a host reaches the bank through `sdk.membank`. Membase runs as a per-machine service on a Unix socket, started and seeded through the `verify-membase` skill in the membase repo.

## Driving it with the harness

1. In a membase checkout (`$MEMBASE_REPO`, default `~/lim-v2/code/membase`), follow `verify-membase` Launch: `scripts/offline-install.sh`, then `.agents/skills/verify-membase/scripts/lane.sh up <lane-dir>`, then enroll and approve the lane's machine. `up` prints `service pid <pid> socket <path>`. That path is the socket for every step below.
2. Seed a bank with the membase CLI, for example `pnpm exec membase bank create books --description "Fiction craft"`, then `pnpm exec membase lesson add --bank books ...` and `pnpm exec membase skill add --bank books ...`.
3. From this repo, after the Launch build:

```sh
node .agents/skills/verify-lhc/helpers/membank.mjs --socket <path> --bank books
node .agents/skills/verify-lhc/helpers/membank.mjs --socket <path> --bank books --expect <items.json>
```

Pass line: `verify-lhc membank: PASS`. The drive creates a thread in a temp home, checks that `attachment` answers `not_attached`, attaches the thread to the bank, lists every item, gets each one, and checks that `get` returns the same `id`, `kind`, `title`, `description` and `status` as `list`. It prints one line per item with its body, checks that `L999999` answers `item_not_found`, detaches, and checks that `list` then answers `not_attached`. `--expect` takes a JSON array of `{ id, title, description, body }` in list order, and the drive fails unless the items match it exactly.

4. Stop membase with `lane.sh down <lane-dir>`, then:

```sh
node .agents/skills/verify-lhc/helpers/membank.mjs --socket <path> --expect-unreachable
```

Pass line: `verify-lhc membank unreachable: PASS`. It prints the rejection and its time, and fails unless `initLhc` rejects with `MembaseHandshakeError` `membase_unreachable` in under 5,000 ms.

5. Perf, with the lane up and the bank seeded:

```sh
node .agents/skills/verify-lhc/helpers/membank-perf.mjs --socket <path> --bank books --trunk-dist <trunk checkout>/packages/lhc/dist/index.js
```

Pass line: `verify-lhc membank-perf: PASS`. It constructs the SDK 20 times each at trunk and at head without membase and at head with membase, interleaved, in one process. Then it runs 5 fresh Node processes that each construct the SDK once without membase and once with it, and it calls `membank.get` 500 times on the bank's first item. It fails when the head construction median without membase is more than 5 ms above trunk's, when the cold handshake (first construction with membase in a fresh process, minus the first without) has a median over 250 ms, or when the `membank.get` p95 is over 10 ms. It prints the warm handshake from the one-process runs without a rule. `--runs`, `--cold-runs` and `--calls` change the counts. Without `--trunk-dist` it skips the trunk comparison.

The full set of codes, a membase run at another API version included, runs headless in `pnpm --filter lhc e2e` (see the skill's Drive section).

## Gotchas

- `initLhc` with `membase` set returns a promise. Without it, `initLhc` stays synchronous. Passing a config typed with an optional `membase` does not compile. Branch on it.
- Keep the socket path to 103 characters or fewer. verify-membase's Launch step 2 says Node clients cannot connect to a longer one, which is why `lane.sh` puts the socket under `${XDG_RUNTIME_DIR:-/tmp}`.
- Health fails with `membase_unavailable` (reason `NotEnrolled`) until the lane's machine is enrolled and approved.
- Item ids are `L<n>` and `S<n>`. Bank names follow membase's rule, 1 to 63 letters, digits, `.`, `_` or `-`, starting with a letter or digit. Thread ids must be 1 to 128 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit, which every `th_` id is but a `copyThread` `newThreadId` may not be. LHC refuses anything else with `invalid_membank_input` before calling membase.
