# Web-Search Provider Capability Research

**Status:** Research findings (June 13 2026), for the pi-lhc bundled web-search extension. Gathered via ccodex web-search subagent (session `019ec0f8-318d-78a3-9590-fda5f19dd249`) against current provider docs. Fable can't web-search; this was delegated.

**Question:** which of our target providers offer a NATIVE/HOSTED/server-side web-search tool enableable directly in the API request (no separate Brave/Tavily/Serper key), and the exact mechanism — so a provider-adaptive web-search extension can inject the right tool per model.

**Injection mechanism (PI side), evidenced.** The extension adds the tool object through PI's **`before_provider_request`** hook, which lets an extension read and replace the outbound provider request body before it is sent. Confirmed live: a recon probe (`scratch-pi-recon/probe-payload.ts`) registered `pi.on("before_provider_request", ...)`, fired against real PI v0.79.2, and returned the request body — capturing the **OpenAI Responses** shape (`model, input, instructions, tools, reasoning, ...`) and the **Anthropic Messages** shape (`model, messages, system, tools, thinking, ...`). Also present in the installed PI package source (`dist/core/sdk.js`), type defs, and CHANGELOG ("Extensions can intercept and modify provider request payloads via `before_provider_request`", with `examples/extensions/provider-payload.ts`). `provider` is **not** on the payload — only `model` — which is why detection keys on the model id. This is PRD assumption A8.

## Findings

| Provider / model | Native hosted search? | Mechanism (how it's enabled in the request) | External search key? | Notes |
|---|---|---|---|---|
| **OpenAI** (Responses API) | YES | `tools:[{type:"web_search"}]` (legacy `web_search_preview` still accepted; use `web_search`). `tool_choice` can force it. | No — OpenAI hosts | What the POC `codex-web-search` does. Current. |
| **Anthropic** | YES | `tools:[{type:"web_search_20260209", name:"web_search"}]` (latest, dynamic filtering). Previous `web_search_20250305` still available. Console admin must enable. | No — Anthropic hosts | **POC uses the stale `_20250305` version** — update to `_20260209`. Not on Bedrock. |
| **DeepSeek V4 / V4 Pro** | PARTIAL | Only via its **Anthropic-compatible endpoint** (`api.deepseek.com/anthropic`) using Anthropic's `web_search_20250305` shape. The OpenAI-style `/chat/completions` endpoint documents only ordinary user-executed function tools, no hosted web_search. | DeepSeek key only | Config-dependent: works only if PI reaches DeepSeek via the Anthropic-compat endpoint. Underdocumented officially. |
| **Kimi K2.6** (Moonshot) | YES | `tools:[{type:"builtin_function", function:{name:"$web_search"}}]` **plus `thinking:{type:"disabled"}`**, and **the caller echoes `tool_call.function.arguments` back** — Kimi executes server-side. A request/response round-trip, not fire-and-forget. | Moonshot key only | Requires thinking disabled + touches the turn loop, not a pure payload patch. |
| **Kimi K2.7 Code** (Moonshot) | YES (different) | Thinking is always on, so the K2.6 `$web_search` non-thinking path doesn't apply. Uses the **Formula** path: URI `moonshot/web-search:latest`, fetch schema from `/formulas/{uri}/tools`, execute `/formulas/{uri}/fibers` with function `web_search`. | Moonshot key only | **Same provider, different mechanism than K2.6.** Map must key on model-version, not provider. |
| **GLM 5.2 / GLM-4.x** (Zhipu / Z.AI) | YES (4.x documented; 5.2 not explicitly) | `tools:[{type:"web_search", web_search:{enable:"True", search_engine:"search-prime"|"search_pro", search_result:"True", count, ...}}]` on chat.completions. Docs example uses `glm-4-air`; nav lists GLM-5.1/5/4.7/4.6/4.5 — **GLM-5.2 not on the web-search page yet.** | Zhipu key only (can route to integrated engines) | Own nested-object shape. GLM-5.2 support presumed-but-unconfirmed. |

## Design implications for the web-search extension

The "one provider-adaptive extension with a `model → search-lane` map" idea holds in shape, but the mechanisms are NOT uniform tool-injections. Three findings that raise complexity:

1. **Map keys on model-version, not provider.** Kimi K2.6 and K2.7 use *different* mechanisms — a provider-level map breaks. Lee's instinct to key on specific dialed-in models is load-bearing.

2. **Strategies are not all simple payload patches.** Spectrum:
   - **Pure `before_provider_request` patch** (clean, like the POC): OpenAI, Anthropic, GLM — add a tool object to `payload.tools`.
   - **Patch + payload constraint**: Kimi K2.6 also needs `thinking:disabled` set, and a **round-trip** (echo tool args back) — this touches the turn loop, likely more than a single-hook injection can do cleanly.
   - **Endpoint-dependent**: DeepSeek only on its Anthropic-compat endpoint — depends how PI is configured to reach it.
   - **Multi-call Formula flow**: Kimi K2.7 fetches a schema then executes a fiber — well beyond a payload patch.

3. **All are fully hosted (provider key only), no external search API.** Confirms the "other options need an API key" worry doesn't apply to these five — none need Brave/Tavily/etc.

### Likely v1 scoping

The clean, in-reach set for a `before_provider_request` payload-patch extension is **OpenAI + Anthropic + GLM** (three simple tool-injections, keyed by model→tool-shape). DeepSeek is reachable if the Anthropic-compat endpoint is how PI talks to it (config-dependent). **Kimi (both versions) is the hard case** — thinking-disable + round-trip (K2.6) and the Formula flow (K2.7) don't fit the simple-injection model and may not belong in the same extension, or may need a different integration than payload-patching. Decision deferred to when the extension is specced; flagged here so it's not discovered mid-build.

### Immediate POC fix carried forward
The existing `codex-web-search` (template for this) injects Anthropic's `web_search_20250305` — the research found `web_search_20260209` is current. Update when productionizing.

## v1 web-search enablement decision (June 13)

Kimi dropped from search (its mechanism doesn't fit the payload-patch model). One story, one extension, model-keyed map. The roster and per-model strategy:

| Model | Web search | Strategy / tool shape | Confidence |
|---|---|---|---|
| OpenAI GPT (5.4, 5.4-mini, 5.5, 5.6) | YES | `tools:[{type:"web_search"}]` (Responses API) | Confirmed; POC already does it |
| Anthropic Claude (Opus 4.6, 4.8) | YES | `tools:[{type:"web_search_20260209", name:"web_search"}]` | Confirmed current |
| **DeepSeek V4 Pro** | YES | Via Anthropic-compat endpoint (`api.deepseek.com/anthropic`), `tools:[{type:"web_search_20250305", name:"web_search", max_uses}]` | **Confirmed** (follow-up research): endpoint lists `server_tool_use`/`web_search_tool_result` as supported; DeepSeek's own Claude Code docs state search runs through DeepSeek's API |
| **DeepSeek V4 Flash** | YES | Model id `deepseek-v4-flash`, same endpoint + same `web_search_20250305` shape | **Confirmed** (follow-up): listed in DeepSeek pricing with Anthropic base URL; community curl uses Flash + web_search directly |
| **GLM 5.1** | YES | `tools:[{type:"web_search", web_search:{search_query, search_result, ...}}]` | **Confirmed** (follow-up): Zhipu official SDK docs show `model='glm-5.1'` with this shape; no 5.x parameter change |
| **GLM 5.2** | YES (unconfirmed) | Assumed same nested `web_search` shape as 5.1 | **New within ~24h** — not in docs yet. Research deliberately skipped (predetermined: too new). Build the leg same as 5.1; **verify live** when GLM auth exists |
| **Kimi K2.6** | NO | — | In harness roster, no search (mechanism = thinking-disable + round-trip, doesn't fit payload patch) |
| **Kimi K2.7 Code** | NO | — | In harness roster, no search (Formula-flow mechanism) |

**Detection:** DeepSeek-via-anthropic-endpoint and real Anthropic both speak the Anthropic API shape — the map distinguishes by model id (`claude-*` vs `deepseek-*`), not endpoint. This is why the model-keyed map stays even with Kimi gone.

**Confidence ladder, after follow-up research:** OpenAI, Anthropic, DeepSeek V4 Pro, DeepSeek V4 Flash, GLM 5.1 are all **confirmed with sources**. Only **GLM 5.2** remains unconfirmed — too new for docs, build-same-as-5.1 and verify live. The story builds all legs; only GLM 5.2 is build-but-unverified.

**Prerequisites (not extension code):**
- DeepSeek auth in PI against the Anthropic-compat endpoint — not set up yet (PI auth currently openai/openai-codex/anthropic only).
- GLM/Zhipu auth for verifying the GLM legs.
- Anthropic tool version bump `_20250305` → `_20260209`.

## Auth landscape for DeepSeek / GLM / Kimi (follow-up research, June 13)

All three use **plain API-key auth** — PI's standard key flow (env var or `auth.json`), no OAuth. All are account → key → pay-as-you-go, no subscription gate for basic API use. PI already defines providers for all of them. Per-provider specifics:

| Provider | PI provider id / env | Key story | Wrinkle |
|---|---|---|---|
| **DeepSeek** | `deepseek` / `DEEPSEEK_API_KEY`, baseUrl `api.deepseek.com` | **One key, both endpoints** — same key works on OpenAI-style (`api.deepseek.com`) and Anthropic-style (`api.deepseek.com/anthropic`) | PI's built-in `deepseek` points at the OpenAI endpoint, where **hosted web search doesn't work**. Search needs the Anthropic base URL. |
| **Zhipu / GLM** | via `api.z.ai` or `open.bigmodel.cn` | Standard pay-go key | **Regional split:** international `api.z.ai` and China `open.bigmodel.cn` are separate platforms/signups, keys not stated interchangeable. Separate "GLM Coding Plan" endpoint exists — we want the **general** endpoint, not the coding-plan one. |
| **Kimi / Moonshot** | `moonshotai` / `MOONSHOT_API_KEY` (`api.moonshot.ai`), and `kimi-coding` / `KIMI_API_KEY` (`api.kimi.com/coding`) | Standard pay-go key covers `kimi-k2.6` + `kimi-k2.7-code` | **Two products:** standard Moonshot API vs. separate "Kimi Code" membership (`api.kimi.com/coding`, model id `kimi-for-coding`, own key/quota). PI defines both. (No web search either way — Kimi is no-search in our roster.) |

**The DeepSeek base-URL prerequisite, made precise:** "enable DeepSeek search" = configure PI to reach DeepSeek via the **Anthropic-compat base URL** (`api.deepseek.com/anthropic`), not the default OpenAI-style `deepseek` provider. Same `DEEPSEEK_API_KEY`, different base URL — a custom PI provider entry or base-URL override. PI provider config, not extension code; this is the real shape of the earlier "DeepSeek auth" prerequisite.

Research: ccodex session `019ec0f8-318d-78a3-9590-fda5f19dd249` (resume for more).
