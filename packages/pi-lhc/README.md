# pi-lhc

The PI ↔ LHC connector: a [PI](https://github.com/earendil-works) coding-agent
extension that records a live PI thread into an [LHC](../lhc) thread. The
connector captures lifecycle events, messages, tool activity, runtime changes,
forks, and replay verification without changing what the model sees.

## Status: Connector Core

The extension loads as a PI extension, resolves or creates the backing LHC
thread, captures PI hook activity into LHC intake events, supports fork seeding
through replay, validates inference assignment config at startup, and provides a
replay verifier for captured corpora.

## Layout

```
src/
  index.ts             extension entry — registers the hook rail, holds no state
  pi/types.ts          local declarations of the PI extension surface (v0.79.2)
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

> The PI packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`)
> are not yet a build-time dependency of this workspace; `src/pi/types.ts`
> declares the slice of their v0.79.2 contract the connector consumes (verified
> by `docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md`) and is swapped
> for the real imports when the dependency lands.
