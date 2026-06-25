# pi-lhc

The PI ↔ LHC connector: a [PI](https://github.com/earendil-works) coding-agent
extension that records a live PI thread into an [LHC](../lhc) thread. The
connector captures lifecycle events, messages, tool activity, runtime changes,
forks, replay verification, and can serve LHC thread-view context back into PI
for model calls.

## Status: Connector Core

The extension loads as a PI extension, resolves or creates the backing LHC
thread via explicit `--lhc-*` flags, captures PI hook activity into LHC intake,
serves LHC thread-view context into an in-memory PI session at startup, supports fork seeding
through replay, validates inference assignment config at startup, and provides a
replay verifier for captured corpora.

## Layout

```
src/
  index.ts             extension entry — registers the hook rail, holds no state
  pi/types.ts          local declarations of the verified PI extension surface
  launcher/            argv parse, LHC resolve+seed, runPiLhcLauncher entry
  lifecycle/           instance construct/dispose, thread resolution, picker,
                       fork, and the plain-data-only SessionState holder
  capture/             converter, message mapping, turn accumulation, idempotency
  inference/           the host ModelCall, assignment config, startup validation
  verify/              corpus replay + read-back compare
  shared/              fail-closed helpers, the LhcInstance + diagnostic types
test/
  fixtures/            corpus loader, synthetic builders, ModelCall fakes,
                       temp-thread factory
  smoke/               extension-load + verification-config smoke tests
```

## Launch

Use the **pi-lhc** bin to start PI with launcher-owned LHC startup (in-memory PI session seeded from LHC thread-view):

```sh
# From the workspace after build:
pnpm --filter pi-lhc build
pnpm --filter pi-lhc exec pi-lhc --lhc-help

# Attach to an existing thread
pnpm --filter pi-lhc exec pi-lhc --lhc-thread <thread-id>

# Cwd-scoped resume picker (TTY)
pnpm --filter pi-lhc exec pi-lhc --lhc-resume

# Most recently created thread
pnpm --filter pi-lhc exec pi-lhc --lhc-continue

# New LHC thread in cwd (no attach flag)
pnpm --filter pi-lhc exec pi-lhc
```

PI native `--session` / `--resume` / `--continue` are rejected in this mode; LHC attach uses only `--lhc-*` flags.

### Rehydrate from LHC

In launcher-owned mode the PI session is in-memory. Use `/lhc-rehydrate` from the PI TUI to replace the live session with a fresh in-memory session hydrated from the latest LHC thread-view. The command preserves the current model and thinking level, re-appends the durable `pi-lhc.thread` entry, and leaves the old session to PI's normal shutdown/dispose path. It fails clearly when no LHC thread is attached.

## Launch flags

LHC thread attach uses **extension-specific** flags registered via `pi.registerFlag` (not PI-native `--session` / `--resume` / `--continue`):

| Flag | Type | Effect |
|------|------|--------|
| `--lhc-thread <id>` | string | Attach to an LHC thread by full or partial id |
| `--lhc-resume` | boolean | Cwd-scoped picker over registry threads |
| `--lhc-continue` | boolean | Attach to the most recently created LHC thread |

Thread attach modes (`--lhc-thread`, `--lhc-resume`, `--lhc-continue`) are mutually exclusive; conflicting combinations fail loud at `session_start`.

PI-native session flags still control PI's own session file; they do not select the LHC recording thread.

## Verification

| Script | Composition |
|--------|-------------|
| `build` | TypeScript emit |
| `typecheck` | Source and test typecheck |
| `lint` | Biome check |
| `test` | Vitest suite |
| `format` | Biome format |

```sh
pnpm --filter pi-lhc test
```

> `@earendil-works/pi-coding-agent` is a build dependency for the launcher path;
> `src/pi/types.ts` still declares the extension hook slice for tests without a
> full PI import in every module.
