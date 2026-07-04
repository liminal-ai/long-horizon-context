# PI extensions (host machine)

TypeScript extensions for global PI (`~/.pi/agent`). Source lives in this repo; global PI loads them via symlinks.

## Extensions

| File | Purpose |
|------|---------|
| `exa-search.ts` | Exa tools via direct HTTP to `api.exa.ai` — `web_search_exa` and `web_fetch_exa` always on; advanced search and agent tools opt-in via `exa-search.json` |
| `fast.ts` | OpenAI/Codex Fast Mode (`/fast` command, status frame, service-tier stream wrapping) — port of `pi-codex-fast` |
| `exit-alias.ts` | `/exit` command alias for `/quit` |

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

## Imports

Extensions import `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`. PI's jiti loader resolves these against PI's bundled runtime aliases — no local `node_modules` in this directory required.

## Tool enable/disable

PI exposes `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools(names)` on the extension API. Users toggle tools via PI's standard mechanisms (e.g. `/tools`, `--tools` / `--exclude-tools` CLI flags). No per-tool toggle API beyond that.

## npm package removal

After verifying the ported `fast.ts` loads, remove `"npm:pi-codex-fast"` from `~/.pi/agent/settings.json` `packages` to avoid double-loading Fast Mode.
