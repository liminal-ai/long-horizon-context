# Vendored agent skills

Copied from [get-convex/agent-skills](https://github.com/get-convex/agent-skills) @ `ec1e6ba` (2026-06-22).
Official Convex skills, unmodified. Only `SKILL.md` and `references/` are kept — the upstream
`agents/openai.yaml` (UI metadata) and `assets/` (icons) are dropped as noise.

## What's here, and why

| Skill | Use it for |
|---|---|
| `convex-create-component` | The component shape itself. Read `references/packaged-components.md` — `lhc-convex` is a reusable npm package, not a local component. `advanced-patterns.md` covers a component using other components. |
| `convex-performance-audit` | `references/function-budget.md` is the 1s / 1MB / 32K transaction limits. `references/occ-conflicts.md` matters for the claim mutation. `hot-path-rules.md` for read amplification. |

## What was deliberately not copied

- **`convex-setup-auth`** — components have no `ctx.auth`. LHC takes ids from its host. Would only invite auth work that doesn't belong here.
- **`convex-migration-helper`** — widen-migrate-narrow for existing Convex data. This is greenfield; there is no Convex data to migrate. Would invite migration machinery nobody needs.
- **`convex-quickstart`** — for new apps or adding Convex to a React/Next app. Wrong shape; would invite full-app scaffolding.
- **`convex`** (router) — a routing skill. The task brief does the routing. Its one useful pointer, `npx convex ai-files install`, is called out in the brief directly.

## Note

`convex-create-component`'s workflow opens with "ask the user what they are building." There is no user. What is being built, and why a component is justified, is already settled in the task brief. Skip that step; take the rest.
