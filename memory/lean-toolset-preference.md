---
name: lean-toolset-preference
description: Lee wants the PI tool surface kept lean; Exa advanced search + agent tools are gated off by default via exa-search.json
metadata:
  type: feedback
---

Lee prefers minimizing per-session context cost from tool schemas: only tools with regular anticipated use should be registered. On 2026-07-03 we gated 5 of 7 Exa tools (web_search_advanced_exa + the four agent_* tools) behind `~/.pi/agent/extensions/exa-search.json` (`enableAdvancedSearch` / `enableAgentTools`, both default false). Only `web_search_exa` and `web_fetch_exa` register by default.

**Why:** web_search_advanced_exa has a ~25-parameter schema and returned unbounded full-text (>50KB, no truncation guard in the extension); the agent tools had near-zero anticipated use for local SDK work.

**How to apply:** When adding or evaluating tools/extensions, default to off unless regular use is expected; prefer opt-in config over always-on registration. Re-enable by creating the JSON file with the flag set true, then reload PI. Related: [[dogfood-setup]].
