# Phase 4 / Chunk 1 — fix round 2 (short round)

Resume the same session. Same rules: **do not commit, do not push**.
Position unchanged: **Chunk 1 = unit 20 of 22**, capture only; Chunks 2–3
remain and are the larger part.

Fix round 1 is accepted on F1–F5, F7, F8, F10, F11, F12, F14, F16, F17. The
orchestrator independently re-ran the tripwire (all layers green, core now
genuinely compiled) and independently re-ran your F11 break-it: hook body
deleted with the sentinel retained. Two items remain.

## G1 — F15 is resolved: a free seam exists, wire it

You escalated `model_change` / `thinking_level_change` as having no seam
without a new unenumerated core touchpoint. That was the right instinct
under the brief, but the premise is wrong — **the seam is free and already
registered**. Evidence:

- `ConfigContributor::on_config_changed`
  (`ext/extension-api/src/contributors.rs:222-236`) receives
  `previous_config` and `new_config` as full `&Config` snapshots.
- `Config` carries both fields you need: `config/mod.rs:622 pub model:
  Option<String>` and `config/mod.rs:954 pub model_reasoning_effort:
  Option<ReasoningEffort>`.
- Core already fans it out at `session/mod.rs:1720
  emit_config_changed_contributors`, guarded by `previous_config ==
  new_config` so no-op changes do not fire. It is driven from three sites:
  `update_settings` (`mod.rs:1510`), `refresh_runtime_config`
  (`mod.rs:1642`), and `new_turn_with_sub_id`
  (`session/turn_context.rs:614`).

So: register a `ConfigContributor` in your existing `install()`, diff
`model` and `model_reasoning_effort` across the two snapshots, and emit LHC
`model_change` / `thinking_level_change` accordingly. **This adds no core
touchpoint** — `ConfigContributor` is an existing trait with an existing
fan-out, and registration rides the builder you already touch. Sentinel
count should not change.

Requirements:
- Emit only on actual change (compare the specific fields; do not emit on
  every config edit).
- Idempotency keys for these follow the same discipline as the rest —
  ordinal-based is fine here since there is no `ResponseItemId`; make them
  stable across restart.
- `on_config_changed` is **synchronous** and the doc says keep it cheap.
  Do not block it — hand off to the capture queue exactly as the raw-item
  path does.
- Test it, and break-it-and-watch-it-fail per FORK.md law 3.

**Known limitation to record, not to solve now:** it is not proven that a
mid-thread `/model` switch in the TUI actually routes through one of those
three sites — `SessionSettingsUpdate` (`session/session.rs:432`) carries no
model field, so the switch likely arrives via `refresh_runtime_config`.
Wire the seam, test what you can offline, and add a row to FORK.md's
scheduled-verification table: **"model_change fires on a real mid-thread
model switch — verify at Chunk 3 live cert."** Do not block on it; if the
seam turns out not to fire, the cost is that these two event kinds are
absent exactly as they are today, which is detectable live and cheap to
change.

## G2 — Bazel lockfile (F13), environment-blocked: record it properly

`bazel` and `bazelisk` are both absent from this box (verified), so
`just bazel-lock-update` cannot run here. That is an environment limit, not
a defect in your work. Do not attempt further.

Add a row to FORK.md's scheduled-verification table: **"`MODULE.bazel.lock`
refresh for the LHC dependency change (`AGENTS.md:37`) — run on a
Bazel-capable host before any upstream PR or CI run."** The orchestrator
will carry it in the commit body as a known-open item.

## Report

Short. Per item: what changed, `file:line`, the test, its break-it output.
State the 22-unit position and what remains.
