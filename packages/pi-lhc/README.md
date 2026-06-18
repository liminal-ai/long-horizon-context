# pi-lhc

The PI ↔ LHC connector: a [PI](https://github.com/earendil-works) coding-agent
extension that records a live session into a [LHC](../lhc) thread. **Epic 1
(Connector Core) is observe-only** — the extension captures everything PI does
and changes nothing the model sees. Context serving is Epic 2.

## Status: Story 0 — Extension Foundation

This is the walking skeleton. It loads as a PI extension, registers the Epic 1
observe-only hook rail, and exposes typed module boundaries — but every behavior
stub is **fail-closed** until its owning story lands (no stub reports successful
capture, derivation, validation, fork seeding, or replay).

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
