# pi-lhc: PI Extension for Long Horizon Context — Product Requirements Document

## Status

Draft — pending review. Defines the feature scope and epic sequencing for `pi-lhc`, a context-management extension for the PI coding agent built on the Long Horizon Context SDK. Each feature section is a compressed proto-epic: user scenarios, numbered rolled-up acceptance criteria, scope boundaries — for downstream expansion into full epics.

Companion: `01-tech-arch.md`. Inputs: the LHC v1 spec line (`../01-lhc-sdk/`), `notes/pi-ext-prd-notes.md` (captured decisions), `notes/pi-ext-integration-research.md` (PI wiring + event shapes, verified against PI v0.79.2), `notes/web-search-provider-research.md` (provider search/auth capabilities).

---

## Background and Terms

The pieces this product connects, and the vocabulary the rest of the document uses.

**PI** is an open-source, terminal-based AI coding agent — an *agentic harness*: a program that runs a model in a loop with tools, context, and a user interface. PI is extensible: extensions are TypeScript modules that subscribe to lifecycle events (a message finished, a turn ended), register commands and tools, and ship as npm packages installed into a user's PI setup. One hook is central here — the **context hook**, which fires before every model call and lets an extension replace the messages PI is about to send. Another — **`before_provider_request`** — fires before the request leaves for the provider and lets an extension modify the request body.

**Long Horizon Context (LHC)** is the SDK for managing an agent's conversation history beyond a model's context window. Its v1 concepts (`../01-lhc-sdk/`):

- A conversation is a **thread**: a durable, append-only record of every prompt, response, tool call, and result, in one SQLite file. PI calls its unit of work a *session*; a session's traffic feeds a thread as **intake events**.
- Thread content is organized into **turns** (one user prompt and everything the agent did in response) and **chunks** (consecutive turns grouped for summarization).
- LHC runs background **derivations** over the record — model-generated transformations: prompt smoothing, tool-result summaries, chunk summaries at two depths. v1 has **seven derivation kinds**. Each carries a **model assignment** — which provider and model runs it. A failed derivation is recorded with a classified reason and can be **requeued**.
- The model sees a **thread-view**: a rendering where older history appears in **bands** of graduated fidelity (oldest as brief summaries, then detailed summaries, then lightly-smoothed content) followed by the **tail** — the recent stretch at full fidelity. Within the tail, a **visibility boundary** marks how much raw tool output stays full versus summarized; it advances in batches so the prompt prefix stays stable for provider caching.
- **Smart compact** rebuilds the bands: it redistributes accumulated tail material into the gradient and writes a new view snapshot. It is explicit — invoked by an operator or host, never self-triggering — and returns a **receipt** listing what was built, requeued, and gapped. A **sweep** is the pre-compact pass that requeues recoverable derivation failures.
- Thread state is read through **inspect** surfaces: an overview, a **health report** (derivation states, failures with reasons, repair preview), and view-contents reports.

A **host** initializes LHC in-process (`initLhc` — the agreed rename of the current `createSdk` export; code rename pending, this spec uses the new name) and operates it directly. LHC has no daemon, no server, and no credentials of its own; the host supplies one model-call function through which all derivation inference flows. A **provider lane** is one authenticated route to a model provider (the user's Anthropic login, their OpenAI key); a host's lanes are whatever its user is logged into.

**The POC** (`pi-lh`) is the proof-of-concept PI extension dogfooded daily for months on a pre-SDK codebase. It validated the integration shape; this product rebuilds it on the v1 SDK and retires it.

Two roles recur: the **operator** (the human running PI) and the **agent** (the model working inside the session, which can be given tools to read its own thread state).

---

## Summary

`pi-lhc` is an npm-published PI extension package. It replaces PI's context handling with LHC: it captures every message and turn into a durable LHC thread, serves the thread-view through PI's context hook, runs the seven derivation kinds through the user's PI provider logins, and adds operator commands and agent tools for inspecting and managing the thread. It ships two ways — installed into an existing PI (`pi install npm:pi-lhc`) or run standalone (`npx pi-lhc`) — both sharing the user's PI auth. It is the first production host of the LHC SDK.

## Problem Statement

PI's context handling is a fixed window with destructive compaction: when a session outgrows the window, PI summarizes and discards. Long-horizon work loses the reasoning behind decisions, tool-result detail, and cross-week continuity. The LHC SDK addresses this — durable record, graduated-fidelity views, inference-backed summaries — and has no production host. The POC ran on the pre-SDK codebase, spread state across rollout files and PI session entries, coupled inference to PI internals, and reported errors as non-actionable status lines. This product builds the host on the v1 SDK.

## User Profile

**Primary User:** An engineer running long, agentic coding sessions in PI — multi-week design conversations, epic-scale builds, heavy tool traffic.
**Context:** Sessions outlive the model's context window. With `pi-lhc`, sessions keep continuity — the agent holds weeks of work without re-onboarding — and context cost stays bounded.
**Mental Model:** "PI is my harness; LHC is my agent's memory. I install the extension, log into my providers once, and my threads persist — compact when I say, inspect when I'm curious, repair when something's off."
**Key Constraint:** Local and in-process — one PI process, one SQLite file per thread, the user's existing PI logins. No daemon, no server, no second auth.
**Secondary User:** The agent — it reads its own thread state through registered tools (health, message listings, view contents) to ground answers across compression seams.

## Product Principles

- **Connective tissue.** The extension maps PI events to LHC calls and LHC output to PI context. Context behavior — banding, boundaries, compaction, derivation — lives in LHC.
- **Standard extensions.** Public PI extension API; no forking or patching PI. Gaps in the API are raised upstream.
- **One login.** LHC inference routes through PI's provider auth — whatever the user is logged into. No second credential store.
- **Actionable surfacing.** Problems the user can act on reach their attention; everything else is queryable on demand.
- **Agent reads, operator mutates.** The agent gets read surfaces over its own thread. Mutation — compact, edit, repair — is operator-initiated in v1.
- **Separate extensions for separable capabilities.** The core connector is one extension. Capabilities that don't touch the LHC instance and can be turned off independently — web search, the service-tier toggle, the researcher subagent — are their own extensions.

## Scope

### In Scope

The core `pi-lhc` connector extension (capture, thread lifecycle across PI session operations, context serving, inference hosting, operator commands, agent tools, status surfacing); npm packaging with both install paths; and three bundled but independent extensions (web search, service-tier toggle, researcher subagent).

### Out of Scope

- LHC SDK behavior changes beyond the host-side seams it exposes. LHC changes surfaced by this work (e.g. a visibility off-switch) are expected and ride LHC's own spec process.
- Migration or import of existing POC threads (pre-SDK storage shape). POC threads age out; `pi-lhc` starts on new threads.
- Thread-view curation and editing surfaces (see Future Directions).
- Hosts other than PI: Codex wrapper, app-server, web UI (future products on the same SDK).
- PI-upstream feature work (e.g. timed notifications — filed as requests).
- Subagent orchestration beyond the single researcher pattern.
- Web search for Kimi (its mechanism does not fit the payload-injection model; see Feature 5).

### Assumptions

| ID | Assumption | Status | Notes |
|----|------------|--------|-------|
| A1 | PI's extension API (hooks, registerTool/Command, package install, ResourceLoader injection) is usable as this PRD requires | Validated against v0.79.2; assumed stable across the 0.79 line | Source + docs + live recon against v0.79.2, June 12–13 2026 |
| A2 | The context hook can serve full replacement message arrays every turn without perceptible latency | Validated (POC) | POC served views through this hook for months |
| A3 | Recorded hook traffic represents live PI behavior closely enough to build the mapper against | Partially validated | Live recon captured real hook deliveries (lifecycle, turns, parallel tools, abort, resume, fork, compaction); full corpus breadth pending M0 |
| A4 | Per-message intake writes stay imperceptible in interactive use | Validated (POC) | POC intake measured in low ms; SDK path is the same write shape |
| A5 | Models work acceptably with tool calls/results served as rendered text rather than native tool-call content parts | Unvalidated | Serving-time behavior; M0 dial-in tests it; fallback is native-part mapping in Feature 2 |
| A8 | The `before_provider_request` hook lets an extension read and replace the outbound provider request body | Validated | Live recon: a probe handler fired and returned the request body (OpenAI Responses and Anthropic Messages shapes captured); present in PI package source and CHANGELOG. Load-bearing for Feature 5. Shapes in `notes/web-search-provider-research.md` |
| A6 | `pi-lhc` npm name is available at publish time | Available | Free as of June 12 2026; recheck at publish |
| A7 | PI exposes enough compaction control to disable native compaction safely | Partially validated | Recon confirmed `session_before_compact` fires before the work with a cancel signal and a `preparation` payload, and tags extension vs native compaction — the manual-intercept half holds. The auto-trigger-starvation half (served bounded context never triggers PI's auto-compact) cannot be proven until serving exists; **its proof target is Feature 2**, not M0 |

## Non-Functional Requirements

- **Hot-path latency:** capture adds no perceptible delay; context serving completes without visibly delaying turn start. No model calls, derivation work, or compaction in any hook path.
- **Prompt stability:** the served message payload is byte-stable between LHC's change points (visibility-boundary advance, mutation, compact) — scoped to the served messages, not provider/runtime metadata. Provider cache economics depend on this.
- **Auth root:** the install path uses PI's normal global agent auth/model resolution; the runner reuses it. No project-local PI auth root unless the user opts in.
- **Crash and restart safety:** the thread record is the source of truth. A killed PI process loses no captured data; the next run resolves the same thread (by launch choice) and resumes cleanly, including after a mid-turn kill (which leaves a turn open with no agent response — capture tolerates it). There is no separate session-file mapping that an early crash could lose.
- **Headless conformance:** every capability that doesn't require a terminal works in `rpc`, `json`, and `print` modes. UI surfacing degrades to logs, never to silent skips.
- **No silent failure:** every failed derivation, unresolvable model assignment, or skipped operation is recorded and queryable. Startup validation reports configuration problems at session start.
- **Single-writer discipline:** one LHC instance per PI process per thread. The extension never opens a second path to a thread file another process holds.

## Architecture Summary

PI fires lifecycle hooks; the core extension maps them to operations on one LHC instance per session; LHC owns context behavior and persists to one SQLite file per thread. Inference flows through one injected model-call function that resolves PI's model registry and auth — LHC owns prompts, model assignments, and failure classification; PI owns credentials and transport. Context reaches the model through the context hook serving the thread-view; PI's native compaction is disabled. The package ships installed (`pi install npm:pi-lhc`) or standalone (`npx pi-lhc`), both on the user's PI auth. The bundled web-search and service-tier extensions modify the provider request through `before_provider_request`; the researcher subagent spawns a separate restricted PI process. Full detail: `01-tech-arch.md`.

## Milestones

| Milestone | After | What Exists | Feedback Point |
|-----------|-------|-------------|----------------|
| M0 | Pre-epic working phase | Recorded scenario corpora, event converter, dialed-in derivation assignments | Corpus replay through the LHC test harness; Lee's acceptance pass over LHC v1 behavior |
| M1 | Epic 1 (Connector Core) | PI sessions captured into LHC threads with working inference; verifiable via inspect surfaces | Run real sessions, inspect captured threads, confirm derivations land |
| M2 | Epic 2 (Context Serving) | The model runs on LHC context; PI compaction disabled; full dogfood viable | Primary feedback gate: daily-drive dogfooding replaces the POC |
| M3 | Epics 3–5 (Surfaces, Packaging, Extras) | Commands, agent tools, informing UX, published package, both install paths, bundled extensions | Fresh-machine install test; external-user trial |

## Pre-Epic Working Phase (M0)

Paired work between Lee and an agent, not spec-pack work (decided June 12). Live recon (June 12–13) already captured PI's event shapes and behavior — lifecycle and reason codes, turn granularity (PI fires a turn per agent step, not per user prompt — distinct from an LHC turn), parallel-tool ordering, the two abort shapes, resume re-firing no history (served via the context hook), fork creating a new session file, and the compaction-intercept hook. Those findings (in `notes/pi-ext-integration-research.md`) feed the converter and retire most event-mapping risk. M0's remaining work:

1. **Corpus breadth:** record real sessions across scenarios — chatty, heavy agentic, monster turn, error traffic, abort, resume, fork — for fixture breadth beyond the recon set.
2. **Converter:** recorded hook streams → LHC intake batches. Built against static recordings; productionized by Epic 1 as the event mapper.
3. **Derivation dial-in:** models × prompts per derivation kind over real corpora, Lee's judgment as gate. Produces the seven model assignments Epic 1 ships as defaults.

Epic 1's spec pack is written after this phase; epic specs use the corpus fixtures as test substrate.

**M0 completion criteria** (gate before Epic 1 specs):

- Recorded PI corpus checked in across the scenario set
- Event-mapping decisions finalized, including images/file-refs and the tool-call rendering choice (A5)
- Derivation model assignments chosen for all seven kinds

---

## Feature 1: Connector Core

### Feature Overview

PI sessions become LHC threads. Every message, tool call, and turn is captured durably, derivations run through the user's PI logins, and the captured thread is verifiable through inspect surfaces — while PI's own context handling runs untouched. The extension observes and changes nothing the model sees; capture is verified independently of serving.

### Scope

#### In Scope

- LHC instance lifecycle: initialize on session start, dispose on shutdown, reconstruct on reload
- Launch-driven thread resolution through the registry catalog: a new thread by default, a cwd-scoped picker (`--resume`/`-r`), the most recent thread (`--continue`/`-c`), or a named thread (`--session <id>`). The LHC thread is the system of record for the conversation and the registry is the catalog; the thread is resolved from the operator's launch choice, not from a stored session-file mapping. (PI keeps its own session file in this observe-only feature and runs normally; it becomes vestigial in Feature 2 when LHC's served context replaces PI's transcript.)
- Fork handling: a new thread per fork, seeded by replay to the fork point
- Event capture: PI messages and turns → intake batches (the productionized converter). PI fires a turn boundary per agent step, not per user prompt — an LHC turn (one user prompt and everything the agent did in response) is derived from PI traffic, not mapped one-to-one from PI's native `turn_end`. Model and thinking-level changes are captured in order as runtime-note events (observable only in-stream).
- The injected model-call function over PI's model registry and auth
- Model-assignment config (seven kinds) and startup validation with visible reporting
- Capture verification: recorded corpora replay identically through the mapper

#### Out of Scope

- Serving context to the model (Feature 2; PI's native context runs as-is here)
- Operator commands beyond a minimal status/attach pair (Feature 3)
- Packaging (Feature 4) and bundled extensions (Feature 5)

### Scenarios

#### Scenario 1: A session is captured from first prompt

The user starts a new PI session with the extension loaded. The extension creates an LHC thread in the registry and, from the first prompt on, every user message, assistant message, thinking block, tool call, tool result, runtime change, and turn boundary lands as intake events. The user works normally; nothing about the session changes.

**AC-1.1:** Starting a new PI session creates an LHC thread in the registry catalog (with its cwd). All conversation traffic — user prompts, assistant text and thinking, tool calls, tool results — plus model and thinking-level changes is captured as ordered intake events, and LHC turn boundaries are derived from PI traffic rather than taken from PI's per-agent-step `turn_end`. Capture is complete, ordered, and duplicate-safe across chatty, tool-heavy, parallel-tool-call, error-result, and aborted-turn traffic.

**AC-1.2:** Capture adds no perceptible latency to interactive use. A capture failure (storage error, malformed event) does not break the user's PI session — the failure is recorded and queryable, the session continues, and the gap shows in thread health rather than being silently absorbed.

**AC-1.3:** The captured thread is verifiable: replaying a recorded corpus through the mapper produces a thread whose read-back matches the fixture expectation, and inspect surfaces (overview, health) reflect the captured session.

#### Scenario 2: The session lives across restarts, reloads, and forks

The user starts a new session; resumes one by picking from a cwd-scoped list (`-r`); continues the most recent (`-c`); names one directly (`--session <id>`); reloads the extension during development; forks a session. In each case the thread resolves from the launch choice and capture continues without gaps or duplicates.

**AC-1.4:** Launch resolves the thread through the registry — new by default, `--resume` picker (cwd-scoped, titled), `--continue` most-recent, or `--session` by full/partial id; an unresolvable id fails loudly rather than silently creating a new thread. Reload and restart resume on the resolved thread. Re-delivered traffic does not duplicate; a mid-turn kill leaves the thread consistent on the next run. There is no session-file mapping to lose in an early-crash window.

**AC-1.5:** Forking a PI session creates a new LHC thread seeded by replaying the source thread's events to the fork point. The source thread is unchanged. Derived forms may be reused from the source when provenance identity proves the reuse safe; otherwise they requeue.

#### Scenario 3: Derivations run on the user's existing logins

The user has PI logged into one or more providers. The extension supplies LHC's model assignments and the one model-call function that routes through PI's registry. Background derivations run during normal use with no configuration beyond the assignments.

**AC-1.6:** The injected model-call function resolves any configured (provider, model) pair through PI's model registry and auth, supporting different providers for different derivation kinds at once. Provider errors map to LHC's failure classification (auth and invalid-request terminal; rate-limit, timeout, network retryable).

**AC-1.7:** At session start the extension validates all seven model assignments against PI's registry and reports unreachable lanes (not logged in, unknown model) before first use, naming the lane and the fix. A validation failure leaves capture running; derivations on the affected lanes fail, classified and queryable.

**AC-1.8:** Model assignments load from config with the dial-in defaults shipped in. A user override (different provider/model per kind) takes effect on the next session start without code changes.

---

## Feature 2: Live Context Serving

### Feature Overview

The model's context comes from LHC instead of PI's transcript. The context hook serves the thread-view — banded history plus the live tail — on every model call; PI's native compaction is disabled; smart compact is the compaction. After this epic the extension replaces the POC as the daily driver.

### Scope

#### In Scope

- Context hook serving: thread-view pull → PI message array, every model call
- PI native compaction disabled: the auto-trigger starved by bounded context, the manual path intercepted
- Smart compact invocation as the operator's compaction (full command UX is Feature 3; a minimal trigger ships here)
- Tool-call trimming config at `initLhc`: on by default at the 64k/32k window, the window tunable, and trimming turn-off-able (the LHC visibility off-switch is the LHC-side change this surfaces)
- Mid-turn coherence: the served view is correct during multi-step turns, after aborts, and immediately after compacts
- Materialize-to-session-file as a manual fallback and export
- Cache-stability verification against the NFR's change points

#### Out of Scope

- Full operator command surface and informing UX (Feature 3)
- View curation and editing (Future Directions)
- Serving formats for non-PI harnesses (future products)

### Scenarios

#### Scenario 1: The model works from the thread-view

The user converses normally. On every model call the extension serves the current thread-view: band content at graduated fidelity, then the full-fidelity tail with LHC's visibility rules applied. The model sees coherent history regardless of session length; the user sees normal PI behavior.

**AC-2.1:** Every model call receives the active thread-view rendered as PI messages: bands in gradient order, then tail messages in record order with visibility-boundary rules applied. The newest events — the prompt that started the turn and mid-turn tool results — are present and current.

**AC-2.2:** The served payload is byte-stable between LHC change points (compact, boundary advance, mutation). Across a session, prompt-prefix changes occur at those points and nowhere else, verified against cache-read behavior.

**AC-2.3:** When derived content is missing or failed, the served view degrades per LHC's rules (fallback content, never an omitted region, never a blocked turn). Serving never waits on derivation work.

#### Scenario 2: Sessions grow past the window

A session grows past PI's window. PI's auto-compaction does not fire because the served context stays bounded; the user's manual `/compact` is intercepted with a pointer to smart compact. When the user runs smart compact, the next model call serves the new view.

**AC-2.4:** PI native compaction does not alter what the model sees: the auto-trigger does not fire under normal operation (served context stays within bounds), and the manual path is intercepted with redirection. No PI compaction summary enters the served context.

**AC-2.5:** Smart compact runs on demand against the live thread, and the post-compact view serves on the next model call, mid-session, with no restart, reload, or stale view.

#### Scenario 3: Export and fallback

The user wants a plain PI session file — for archival, sharing, or running without the extension. A materialize command writes the current view as a loadable session file.

**AC-2.6:** Materialize writes the active view as a valid PI session file on demand. The output loads in stock PI as a normal session. Output is byte-identical for an unchanged view.

---

## Feature 3: Operator and Agent Surfaces

### Feature Overview

The operator manages threads through commands; the agent reads its own thread through tools; problems surface by the informing policy. Ships after serving: every surface reads state that Features 1–2 create, and dogfooding those features sets these surfaces' priorities.

### Scope

#### In Scope

- Operator commands: status, compact (with profiles), health, sweep, repair/requeue, materialize, thread attach/inspect
- Agent self-inspection tools registered through the PI tool API: thread overview, health, message/turn listings, view contents
- The informing policy (defined under Cross-Cutting Decisions): startup validation report, once-per-condition transition notices with timed fade, receipts on compact/sweep, full detail on demand
- A quiet steady-state footer (thread id, tail pressure, attention flag)

#### Out of Scope

- Mutation tools for the agent (Future Directions, with curation)
- Web/HTTP surfaces (future products)
- New LHC report shapes beyond what inspect/health provide (LHC-side changes ride LHC's process)

### Scenarios

#### Scenario 1: The operator checks and manages a thread

The user checks how the thread is doing — tail size, compact recommendation, what failed — at a glance, runs health when something looks off, compacts with a chosen profile, and requeues repairs when health shows recoverable failures.

**AC-3.1:** A status command reports thread identity, capture liveness, tail pressure against thresholds, compact recommendation, and pending/failed derivation counts. The steady-state footer shows the always-relevant subset without user action.

**AC-3.2:** Compact is invocable with a named profile or explicit parameters, returning a receipt (band composition, gaps, what was requeued). Health and sweep commands expose LHC's reports and repair actions; repair distinguishes recoverable failures (requeue helps) from config-blocked failures (requeue futile until the named fix).

#### Scenario 2: The agent grounds itself

Mid-task the agent is unsure whether something happened weeks ago, or senses a stretch of its memory is thin. It calls its thread tools — listings, health, view contents — gets the ground truth, and proceeds on evidence.

**AC-3.3:** The agent reads its own thread through registered tools: overview, health, message/turn listings with metadata, view contents. Tool descriptions guide use toward grounding checks rather than continuous polling. Results are sized for context economy — listings paginate, content previews truncate.

#### Scenario 3: Problems surface once, with the action named

A provider login expires mid-week. The user sees one notice naming the lane and the fix; the notice fades; the detail waits in health. When the lane recovers, one recovery notice.

**AC-3.4:** Failure surfacing follows the informing policy: config-shaped failures notify once per condition transition (fail, recover) with a timed-fade notice naming the action; transient failures stay silent; exhausted retries appear in receipts; everything is queryable in full on demand. A repeat of a known condition does not re-notify.

---

## Feature 4: Packaging and Distribution

### Feature Overview

`pi-lhc` becomes installable. One npm package, two consumption paths — installed into an existing PI setup, or standalone via `npx pi-lhc`. Runs in PI's terminal and headless modes.

### Scope

#### In Scope

- npm package with PI package-system conformance (`pi install npm:pi-lhc`), no collision with user extensions
- Runner CLI (`npx pi-lhc`): launches PI with the extension injected per-run, never mutating the user's PI configuration
- Config: LHC assignments and settings in the user's PI settings section (install path) or an own file (runner path)
- First-run experience: defaults, validation-driven setup guidance, working derivations on first session when PI auth is present
- Headless conformance across rpc, json, and print modes
- README and install/configuration documentation

#### Out of Scope

- npm publish automation/CI beyond a repeatable manual flow
- PI version compatibility beyond a declared floor version
- Telemetry or usage reporting
- The bundled extensions (Feature 5)

### Scenarios

#### Scenario 1: An existing PI user installs the extension

A PI user with provider logins runs `pi install npm:pi-lhc`, restarts PI, and reaches a first session that validates the setup and starts capturing. Their existing extensions, settings, and auth are unchanged.

**AC-4.1:** Package install via PI's package system works end to end — install, load, first-session validation report, capture running — with no writes to the user's own extensions or settings beyond PI's package registration. Uninstall or disable through PI's standard mechanism leaves no residue.

**AC-4.2:** On first run, missing or incomplete LHC config produces guided setup (what to set, where, example values) rather than failure. With PI auth present and default assignments resolvable, derivations work with no configuration.

#### Scenario 2: A new user runs the standalone path

Someone without a PI setup runs `npx pi-lhc` and gets PI with the extension active, prompted through provider login by PI's normal flow.

**AC-4.3:** The runner launches PI with the extension injected per-run, reuses PI's normal global agent auth/model resolution when present, and persists LHC config in its own location. A user with existing PI auth reaches a working captured session without a second login. Neither path establishes a project-local PI auth root unless the user opts in.

#### Scenario 3: The package runs headless

The user runs `pi-lhc` in rpc, json, or print mode for scripted or non-interactive use.

**AC-4.4:** Every capability that doesn't require a terminal works in rpc, json, and print modes. UI surfacing (notices, footer, status) degrades to log output rather than being skipped or throwing.

---

## Feature 5: Bundled Extensions

### Feature Overview

Three independent extensions shipped with the package, each its own toggle, none touching the LHC instance. A **web-search extension** adds a provider's hosted web-search tool to the model request. A **service-tier toggle** sets a faster service tier on supported requests. A **researcher subagent** delegates web research to a separate restricted PI process. Each modifies behavior for the models it recognizes and ignores requests for models it doesn't.

A **hosted web-search tool** is a search capability the model provider runs server-side, enabled by adding a tool object to the API request — no separate search-provider key. Providers differ in the tool's shape and which models support it, so the extension keys on the model in the request (a **model→strategy map**), injects that model's tool object, and leaves unlisted models untouched. The roster and per-model tool shapes are in `notes/web-search-provider-research.md`.

### Scope

#### In Scope

- Web-search extension: model-keyed injection for the dialed-in roster — OpenAI GPT, Anthropic Claude, DeepSeek V4 Pro and Flash (via DeepSeek's Anthropic-compatible endpoint), GLM 5.1, GLM 5.2 (build same as 5.1, verify live — support undocumented as of this writing). Single enable flag; self-ignoring for unlisted models.
- Service-tier toggle: a command that sets the faster service tier on requests for the models that support it (the existing `codex-fast` pattern), self-ignoring otherwise.
- Researcher subagent: a spawnable separate PI process holding read-only tools plus web access, returning its report as a tool result, resumable for follow-ups. The privilege split keeps untrusted web content out of the orchestrating agent's context with tool authority behind it.

#### Out of Scope

- Web search for Kimi K2.6 and K2.7 (mechanism is a thinking-disable plus round-trip for K2.6 and a multi-call flow for K2.7 — neither fits payload injection)
- Third-party web search requiring a separate search-provider API key
- Subagent presets beyond the single researcher

These extensions do not gate package delivery, and core pi-lhc (Features 1–4) does not depend on them. Feature 4 ships complete without any of Feature 5; downstream epics and stories treat these as optional companions, not prerequisites for core delivery.

### Scenarios

#### Scenario 1: The agent searches the web on a supported model

The user enables web search. On a model in the roster, the extension adds that provider's hosted search tool to the request; the model searches and answers. On a model not in the roster, the request is unchanged.

**AC-5.1:** With web search enabled, a request for a roster model carries that model's hosted web-search tool, injected in the provider's required shape; the model performs server-side search with no separate search-provider key. A request for a model not in the roster is unchanged. The extension distinguishes models that share an API shape (Claude and DeepSeek both speak the Anthropic shape) by the model in the request, not the endpoint.

#### Scenario 2: The user toggles a faster service tier

On a supported model, the user toggles a faster service tier for the session; requests carry the tier setting until toggled off. On other models the toggle has no effect on the request.

**AC-5.2:** A command toggles the service tier for the session. While on, requests for supported models carry the faster-tier setting; toggling off removes it. Requests for unsupported models are unchanged regardless of toggle state.

#### Scenario 3: The agent delegates research to a subagent

The agent hands a research task to the subagent. The subagent runs as a separate PI process with read-only tools and web access, does the research, and returns a report. The orchestrating agent reads the report without ever holding raw web content with file or execution authority behind it.

**AC-5.3:** The researcher subagent is spawnable with read-only tools plus web access, returns its report as a tool result to the calling agent, and supports resuming its session for follow-up tasks. The orchestrating agent's process holds no web-fetched content with write or execution authority attached.

---

## Cross-Cutting Decisions

### Extension state discipline

**Decision:** The core extension holds only plain data (thread id, file path, told-the-user flags) as module state; every handler uses the fresh context object it receives. **Rationale:** PI session replacement (new, resume, fork, reload) tears down and rebuilds context objects; a captured reference goes stale and throws — the POC's largest source of defensive code. **Consequence:** No epic captures PI contexts, session managers, or UI handles across events; state that must survive reload reconstructs from the resolved thread id and LHC, not from a PI session file.

### One LHC instance, background mode

**Decision:** One `initLhc` per session lifecycle, in background scheduler mode; the extension never drives the queue. **Rationale:** LHC owns drain scheduling; a second driver creates the double-writer problem the SDK's single-writer discipline forbids. **Consequence:** Derivation timing is LHC's; surfaces read state, never pump work.

### Extension decomposition

**Decision:** The core connector is one extension split across files by surface (lifecycle, capture, serving, inference host, surfaces). The web-search, service-tier, and researcher-subagent capabilities are separate extensions. **Rationale:** PI's enable/disable granularity is the extension boundary, and the core surfaces share one in-process LHC instance (separate extensions cannot easily share it), while the three extras touch no LHC state and each warrants an independent toggle. **Consequence:** Per-instance behavior on the core is `initLhc` config, not separate extensions; the extras are individually installable and disablable.

### Inference routing

**Decision:** The extension injects one model-call function that routes the (provider, model) LHC names through PI's registry and auth. LHC owns prompts, the seven assignments, and classification; PI owns credentials and transport. **Rationale:** Per-kind injection would move LHC's derivation catalog into the host and make an eighth kind a breaking host change; one routing function keeps derivation knowledge in LHC and serves multi-lane setups because each call names its lane. **Consequence:** The extension's inference role is a router, not a policy layer; adding or retargeting a kind is LHC config.

### Informing policy

**Decision:** Surfacing is actionable, once-per-condition, transition-based; channels in escalation order are startup report → timed-fade footer notice → compact/sweep receipts → on-demand detail; steady state lives in a quiet footer slot. PI has no native auto-expiring notification, so the timed fade is built on a keyed footer slot cleared by a timer. **Rationale:** The POC's error reporting was non-actionable status output that scrolled away and left nothing queryable. **Consequence:** Transition detection (told-the-user flags, cleared on recovery, surviving reload) is extension state shared by the Lifecycle and Surfaces work; error UX names the user action or stays out of attention.

### Naming and config

**Decision:** Package, bin, and brand are `pi-lhc`; LHC config lives in the user's PI settings section (install path) or an own file (runner path). **Consequence:** Status keys, config sections, and docs derive from the one name.

## Future Directions

Not v1 scope; they inform architecture so downstream decisions leave room.

- **Legible, editable context (curation).** Fast navigation across messages/turns/chunks at every fidelity layer ("all turns at the smoothed layer," metadata + preview listings); direct thread-view editing (rework entries, move chunks between bands); a curation pass — possibly a specialized agent — on every smart compact between build and take; conversational repair ("check your view against your thread and fix what's needed"). **Standing constraint on v1:** nothing hardens "view entries are always derivation outputs" into an invariant — curated entries with authored provenance must remain representable.
- **PI-compaction redirect.** v1 cancels PI's manual compact path with redirection; a later version may map it onto smart compact directly. PI tags extension vs native compaction, which leaves this path open.
- **Agent degraded-view awareness.** Whether the agent is told (in-band markers at degraded seams) rather than only able to ask. Deferred to dial-in and dogfood evidence.
- **Kimi web search.** Excluded from Feature 5 for mechanism mismatch; revisit if Kimi's role needs search.
- **Additional hosts on the same SDK:** app-server/web control surface, Codex wrapper. The extension's event mapper and serving shapes are the reference implementations they adapt.

## Recommended Epic Sequencing

```
M0: Pre-epic working phase (paired; corpus → converter → dial-in)
    │
    ▼
Epic 1: Connector Core
    │
    ▼
Epic 2: Live Context Serving     ──── M2: dogfood gate (replaces POC)
    │
    ├──→ Epic 3: Operator & Agent Surfaces
    ├──→ Epic 4: Packaging & Distribution
    └──→ Epic 5: Bundled Extensions
```

Epic 1 before 2: serving depends on capture, and the observe-only epic lets capture run under real use while serving is specced. Epics 3, 4, and 5 follow Epic 2 and can run in parallel — surfaces read serving-era state, packaging exercises lifecycle and config, and the bundled extensions touch neither the LHC instance nor each other. The M2 dogfood gate is the primary feedback point, before the parallel epics freeze.

## Relationship to Downstream Specs

Each feature maps to one epic. The PRD defines what; epics define exactly what, with line-level ACs, TCs, and story breakdowns; tech designs define how. Epic 1's spec pack is written after M0 so its event-mapping contracts and inference assignments rest on recorded evidence. The companion tech arch (`01-tech-arch.md`) settles the technical world the five epics inherit.

## Validation Checklist

- [x] Terms defined before use (Background and Terms; per-feature terms defined at use)
- [x] User Profile grounds the features
- [x] Problem Statement is factual, not a pitch
- [x] Each feature has Overview, Scope, Scenarios with numbered ACs
- [x] Scenarios describe user situations decomposable without invention (grounded in recon + POC + provider research)
- [x] No line-level ACs, TCs, or data contracts
- [x] Out-of-scope items point to where they're handled
- [x] One governing idea per feature (packaging and extras split apart)
- [x] Milestones define feedback-gated phases (M2 dogfood gate primary)
- [x] NFRs surfaced
- [x] Cross-cutting decisions carry rationale and consequence
- [x] Epic sequencing has rationale
- [x] Each feature expandable into a full epic without foundational questions
