# PI Extension PRD Notes

**Status:** Running capture doc (started June 12, 2026). Brain dumps and decisions for the PI extension PRD/epics — specifically the non-obvious things we don't want to forget. Not exhaustive: the obvious bulk (event capture, context hook, commands, the POC as reference) gets planned when the PRD is written.

---

## How the extension gives LHC the ability to run inference

LHC needs to make model calls for its derivations (prompt smoothing, tool summaries, chunk summaries, etc.), but it has no logins of its own. The decision from the June 12 discussion: when the extension initializes the LHC SDK, it hands LHC **one function** that makes model calls. LHC calls that function whenever it needs inference, passing in which provider, which model, and the prompt. The function uses PI's existing login/model machinery to make the call and returns the text.

What we don't want to forget:

- **This function is small and dumb on purpose — maybe 15 lines.** It looks up the provider and model through PI's auth storage and model registry, calls PI's completion API, returns the result. All the smarts (which model each derivation uses, the prompts, what to do on failure) live in LHC. The extension never knows what a derivation is.
- **The user logs in once — to PI.** Whatever providers PI is logged into (Claude OAuth, Copilot OAuth, Codex login, plain API keys — several at once is normal), LHC can reach through this one function. No second login, no second auth system.
- **Which model each derivation uses is configuration the extension supplies.** LHC defines what the config looks like; the extension provides the actual values when it sets up the SDK. Different machines get different values (home: Codex login; work: Copilot or Claude Enterprise) just by having different config.
- **Bad config must be visible at startup.** If the config names a provider that isn't logged in, that needs to show up when the extension loads — not as mysterious failures later when background work runs. This kind of misconfiguration is otherwise really hard for the user to see.

## Reporting / UX rules

- **Only put things in the status area the user can act on.** Failed derivations, degraded summaries, retries running out — those live in LHC's health report where you can query them and requeue. The POC's mistake: flooding the status area with error spew that's not actionable, scrolls away, and leaves nothing behind. Don't repeat it.

### Derivation-failure informing policy (worked through June 12)

Organizing principle: failure class determines user action; user action determines channel. No derivation failure ever stops work (compact degrades with gaps, tail serves raw), so the consequence of every failure is quality degradation — almost nothing justifies interrupting.

| Failure class | Reason codes | User action | Channel |
|---|---|---|---|
| Config-shaped | `auth`, `invalid_request` (terminal immediately) | Log in / fix model assignment | The only interrupting class: notify at startup probe or on first runtime occurrence per lane |
| Transient, retrying | `rate_limit`/`timeout`/`network`/`empty_output`, attempts left | Nothing | Silent; health on demand |
| Exhausted-transient | same, retries exhausted | Nothing — sweep auto-requeues at next compact | Compact/sweep receipts |
| Blocked source | `blocked` + damage reason | Repair/edit/delete the source record | Health report detail |

Channels: (1) session-start validation — `createSdk` assignment errors surfaced loudly, plus an extension-side auth probe (iterate the seven assignments, `modelRegistry.find` each, report unreachable lanes before first drain — this probe is extension code and doesn't exist yet); (2) once-per-condition runtime notify for config-shaped failures, on transition not per instance, cleared when the lane succeeds again; (3) compact/sweep receipts as the natural attention moment for everything else; (4) `/lh-health` + agent self-inspection tool for full detail; (5) candidate: quiet persistent footer (thread id, tail %, failed count) — persistent-and-quiet is compatible with actionable-only, scrolling spew is not.

### Transient notification mechanism (decided June 12)

PI has no built-in auto-expiring notification: `notify()` renders a dim status line in the transcript that scrolls away (with back-to-back coalescing — `interactive-mode.ts` `showStatus` replaces rather than stacks); `setStatus`/`setWidget` are keyed persistent slots with no duration option; only dialogs take a `timeout`. Verified in extensions.md/tui.md/rpc.md/settings.md and PI source.

**First choice: a timed footer flash built on `setStatus`.** Extension-side helper: `setStatus("lh-alert", text)` + timer-clear after a configurable `notifyDurationMs` (default ~8s, `0` = persistent); re-flash overwrites the same keyed slot so nothing stacks; second steady-state key (`"lh"`) for the quiet persistent footer state so alerts and steady state don't fight. Guard with `ctx.hasUI`, fall back to a log line in print/JSON modes. Pairs with once-per-condition: flash on transition, fade, durable truth stays in `/lh-health`. ~10 lines, no PI changes.

**Backup: `notify("warning")` transcript lines, throttled.** If the footer proves too easy to miss or footer real estate gets crowded, fall back to PI's native notify with the once-per-condition rule doing the anti-spam work (one line on lane-failure transition, one on recovery). Conversation-transient rather than clock-transient — acceptable because the coalescing behavior already prevents stacking, and the durable record is health either way.

**Also worth filing upstream:** `notify`/`setStatus` with a `durationMs` option is a natural PI primitive (PI's own version-update notification is a persistent line for lack of one). File the feature request; don't block on it.

Known gaps to design in the PRD:
- **Transition detection is extension state** — health gives counts, not deltas; the extension tracks what it already told the user and must survive reload.
- **Repair preview should split by class** — "requeue will help" vs "futile until config changes." Reason codes carry the info; the preview shape doesn't split it. Small LHC tweak.
- **Open call: does the agent get told its view is degraded?** Lean no — queryable via self-inspection tool, an unprompted note isn't actionable for the agent either.

## Architecture rules

- **Standard PI extensions only.** No forking PI, no cloning it, no patching around it. If the extension API can't do something we need, that's a conversation to have, not a workaround to write.
- **Agents inspect their own thread through PI custom tools, not a CLI.** We retired the LHC CLI. The thing agents used it for (checking thread health, listing messages mid-task) comes back as PI custom tools that call into the same SDK instance the extension is already running. One process, one access path to the SQLite file.
- **Expect to tweak LHC while building the extension.** Ideally the extension work doesn't touch LHC, but realistically it'll surface things we didn't account for — prompts, model choices, config shape. Making bounded LHC changes during extension work is expected, not a violation.

## Packaging (direction settled June 12, name pending)

Two packages, no PI fork/rebrand:

Working name: **`pi-lhc`** (June 12; npm availability unchecked). Succeeds the `pi-lh` POC name; honest about being PI + LHC rather than a standalone product. Naming convention generalizes to future hosts (`lhc-server`, `codex-lhc`, …).

- **Extension package** (`pi-lhc`): the LHC extension + anthropic/codex web-search payload patches + basic subagent tool, published as a PI-installable npm package. Existing PI users: `pi install npm:pi-lhc` — PI's package system namespaces it under `~/.pi/agent/npm/` and manages settings wiring, so it cannot collide with anyone's own `.pi` extensions.
- **Runner CLI** (`npx pi-lhc`): thin bin depending on PI + the extension package; injects the extension per-run (SDK/resource-loader path, never writing into the user's `~/.pi/agent/extensions/`), launches PI interactive mode. Batteries-included entry for people without a PI setup.

Load-bearing decision: **the runner shares `~/.pi/agent/auth.json` — do not redirect the config dir.** `PI_CODING_AGENT_DIR`/`piConfig` isolation would force a second login to every provider, recreating the two-auth problem the architecture exists to avoid. LHC's own config (seven model assignments, budgets, profiles) lives in its own file (`~/.<name>/config.json`) read by the extension; zero writes to the user's PI settings, shared read of their auth.

Rejected: `piConfig` rebrand (`development.md`) — it's the fork-distribution path (changes banner/config-dir/env names but requires publishing our own PI build). Conflicts with clean-extensions-only.

Name cascade: npm package `pi-lhc`, bin `pi-lhc`, status-bar keys `"pi-lhc"`/`"pi-lhc-alert"`. LHC config location is a PRD-time call: own file (`~/.pi-lhc/config.json`) vs a `pi-lhc` section in PI's settings.json — lean toward PI settings section for the extension-install path (one config system for the user) with the own-file fallback for the runner.

Epic C implication: packaging is two stories (extension-package conformance incl. headless modes + runner CLI).

## Harness furniture riding along (not LHC scope, same package)

- **`anthropic-web-search` extension** — same payload-patch pattern as the existing `codex-web-search` (hosted `web_search` tool added to provider payload behind a flag), Anthropic tool schema. OpenAI + Anthropic are the primary lanes; others later.
- **Basic subagent extension** — start from PI's official `subagent` example, trimmed to a single `researcher` agent: read-only tools + web-search enabled, no bash. Purpose: privilege separation — the orchestrator never reads raw web content, the web-reading agent holds no write/exec authority. Accepted as risk *narrowing* (layered injection-survival odds), not sealing; the report re-entering main context is the residual path.
- **Subagent resumability**: PI's example spawns `pi --mode json -p --no-session` (one-shot by choice, not capability). Drop `--no-session`, capture the session path in tool-result details, accept optional `sessionId` to continue via `pi --session <path> -p`. Cheap now, annoying to retrofit.

## Post-v1 vision: legible, editable context (captured June 12)

Lee's broader direction for where this goes after v1 — informs Future Directions and one foundation constraint, not v1 scope:

- **A legible navigation surface over thread + thread-view.** Fast, flexible retrieval for moving across messages/turns/chunks: "all messages in this turn with metadata + first 50 chars," "all turns at the smoothed layer." High-speed iteration over an entire thread or view. Consumers: a specialized context-curation agent, the agent editing its own context, or a human via API/UI.
- **Editing both layers.** Edit messages in the thread (exists — Epic 2/4 cascade machinery), *and* edit the thread-view directly: rework chunks, move chunks between bands, rework band entries. The algorithm builds the default view for your settings; curation reworks it.
- **A fine-tuning pass per smart compact** — possibly so valuable it's a specialized agent run on every compact: build default view → curation pass → take. The snapshot model (compact writes, nothing churns until take) is what makes this workflow safe.
- **Conversational repair**: "go through your thread-view, check it against your thread, make whatever updates you need" — navigation + view-edit composed through the agent's own tools.

**Foundation constraint to carry forward now:** nothing downstream may harden "view entries are always derivation outputs" into an invariant. Curated entries are authored content; provenance must tolerate an authored/curated origin alongside derivation-`ready`. One-line constraint now vs a migration later.

Q3 (agent degraded-view awareness) folds into this: the deeper answer to degraded views is curation/repair surfaces, not injected warnings. Deeper dive deferred to post-v1 planning.

## Things we'll already know before writing this PRD

- **The recording extension from the test-harness work doubles as reconnaissance.** Before the extension PRD gets written, we'll have run a thin extension that just records everything PI's hooks deliver (what order events arrive in, how parallel tool results show up, what an abort looks like, what the context hook sees mid-turn, what happens on resume). Every surprise it catches is a question answered before the PRD instead of during the build.
- **The converter written for test fixtures is reusable.** Turning recorded PI events into LHC intake batches is most of the event-mapping work the extension needs anyway — it gets written early, against recorded files, where it's easy to test. The extension inherits it.
