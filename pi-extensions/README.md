# PI extensions (host machine)

TypeScript extensions for global PI (`~/.pi/agent`). Source lives in this repo; global PI loads them via symlinks.

## Extensions

| File | Purpose |
|------|---------|
| `exa-search.ts` | Exa tools via direct HTTP to `api.exa.ai` — `web_search_exa` and `web_fetch_exa` always on; advanced search and agent tools opt-in via `exa-search.json` |
| `fast.ts` | OpenAI/Codex Fast Mode (`/fast` command, status frame, service-tier stream wrapping) — port of `pi-codex-fast` |
| `exit-alias.ts` | `/exit` command alias for `/quit` |
| `honcho-memory.ts` | Honcho memory provider — cross-session user/project memory via direct HTTP to `api.honcho.dev`. Two-layer context injection (base context + dialectic supplement) plus 5 tools (`honcho_profile`, `honcho_search`, `honcho_context`, `honcho_reasoning`, `honcho_conclude`) and `/honcho-status`. v1 deliberately duplicates the Hermes honcho plugin's behavior (see `plugins/memory/honcho` in hermes-agent) |

## Registration

Symlinks in `~/.pi/agent/extensions/` point at files in this directory:

```bash
ln -sf /Users/leemoore/code/pi-long-horizon/liminal-context/pi-extensions/exa-search.ts ~/.pi/agent/extensions/exa-search.ts
ln -sf /Users/leemoore/code/pi-long-horizon/liminal-context/pi-extensions/fast.ts ~/.pi/agent/extensions/fast.ts
ln -sf /Users/leemoore/code/pi-long-horizon/liminal-context/pi-extensions/exit-alias.ts ~/.pi/agent/extensions/exit-alias.ts
```

PI's extension loader (`discoverExtensionsInDir`) treats symlinks to `.ts` files as first-class extension entries (`entry.isFile() || entry.isSymbolicLink()`), so symlinks are the cleanest registration: edit in-repo, reload PI, no copy step.

Config lives where it already lives:

- Exa API key: `"exa": { "type": "api-key", "key": "..." }` entry in `~/.pi/agent/auth.json`
- `~/.pi/agent/extensions/exa-search.json` — optional tool flags (file optional; both default off):
  - `enableAdvancedSearch` — registers `web_search_advanced_exa`
  - `enableAgentTools` — registers `agent_create_run`, `agent_wait_for_run`, `agent_get_run_output`, `agent_cancel_run`
- `~/.pi/agent/extensions/pi-codex-fast.json` — Fast Mode settings (unchanged from npm package era)
- Honcho API key: `"honcho": { "type": "api-key", "key": "..." }` entry in the agent dir's `auth.json` (or `HONCHO_API_KEY` env)
- `~/.pi/agent/extensions/honcho-memory.json` — Honcho settings (see `honcho-memory.json.example`; unknown keys warn loudly at session start). Key settings: `workspace`, `peerName`, `aiPeer`, `recallMode` (`hybrid`/`context`/`tools`), `sessionStrategy` (`per-directory`/`per-repo`/`global`), cadences and budgets. `HONCHO_WORKSPACE` env var overrides `workspace` — point smoke tests and host-integration testing at the disposable `lhc-test` workspace so test traffic never pollutes the real workspace's derivations (real one: `long-horizon-context`). **What syncs to Honcho:** user prompts + final assistant text only — tool calls, tool results, thinking, and system prompts never leave the machine; aborted runs are skipped.

For **pi-lhc**, the agent dir is `~/.pi-lhc/pi/agent` (via `PI_CODING_AGENT_DIR`), so symlinks/config go in `~/.pi-lhc/pi/agent/extensions/` and the key in `~/.pi-lhc/pi/agent/auth.json`.

## Imports

Extensions import `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`. PI's jiti loader resolves these against PI's bundled runtime aliases — no local `node_modules` in this directory required.

## Tool enable/disable

PI exposes `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools(names)` on the extension API. Users toggle tools via PI's standard mechanisms (e.g. `/tools`, `--tools` / `--exclude-tools` CLI flags). No per-tool toggle API beyond that.

## npm package removal

After verifying the ported `fast.ts` loads, remove `"npm:pi-codex-fast"` from `~/.pi/agent/settings.json` `packages` to avoid double-loading Fast Mode.
