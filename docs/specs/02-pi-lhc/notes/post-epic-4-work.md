# Post Epic 4 Work

**Status:** Running notes from design discussion (June 12, 2026). A capture document — decisions, reasoning, and work we don't want to lose. Not a plan. Bucketing, prioritizing, cutting, and ordering happen later, together.

---

## LHC Is a Stateful SDK. The CLI Is Retired.

LHC is consumed one way: `createSdk` inside a host process. Initialization wires everything — storage, providers, config — once, up front. There is no stateless out-of-process access path. The `lhc` CLI (built across Epics 1–3, extended in Epic 4's spec) is retired.

### Why

The CLI's coherence depended on a consumer that no longer exists in any future we're holding:

- The original out-of-process consumer was the **Codex sidecar** idea — patch eventing/hooks into the Rust Codex CLI and drive LHC's context handling via the CLI as a sidecar process. On examination: a sidecar is stateful (long-lived process, wired once at startup), needs its own test framework (process lifecycle, pipe protocol, crash/restart), and that test confidence doesn't transfer to in-process mode — you'd test everything twice. We are not building it on spec. If Codex integration ever becomes a commitment, it gets designed then, possibly as a Rust adaptation of LHC instead.
- The **Claude Code contingency** (work shuts PI down) similarly resolves to a TypeScript wrapper CLI that *consumes the SDK in-process* — a host, not a CLI client.
- The remaining CLI surface (reads: inspect, messages list/show, status) had no consumer either. Agents inspecting their own thread mid-task are better served by PI custom tools backed by the same SDK instance already holding the thread — no second access path to the same SQLite file, no consistency question. Operator debugging is served by the SDK in a five-line script.

A reads-only CLI rump kept "because it's already built" is the sunk-cost fallacy: an interface earns its existence by being coherent for some consumer, and this one has none. Keeping it means maintaining, testing, and explaining a surface whose design center — drive LHC from out of process — is a rejected operational model.

### The consumption model going forward

Three host shapes, one consumption pattern:

1. **PI extension** (now, the reference implementation). Tightly coupled by intent — LHC's thread view looks like PI and that's fine. The SDK boundary's value here is isolation: connective tissue (PI extensions) stays thin and separate from the core (LHC), so long-term maintenance doesn't go mushy. Work divides naturally into SDK changes vs. extension changes.
2. **Web/desktop control surface** (later: Fastify/Express/plain Node HTTP host, possibly Electron + WebSocket for a richer desktop experience). The software-factory control surface, including an eventual Jarvis-like agent that itself needs long-horizon context. SQLite may give way to Postgres here; the SDK's storage seam should keep that swap contained.
3. **Harness-wrapper CLI** (if ever needed: Codex or Claude Code integration). A TypeScript CLI that wraps the underlying harness *and* imports the LHC SDK in-process. The wrapper is a host. Nothing about it requires LHC to expose an out-of-process surface.

All PI integration is **clean PI extensions using standard extension patterns** — no forking, no cloning, no PI shenanigans. If a need can't be met through the extension API, that's a problem to raise, not a patch to write.

### What retiring the CLI removes

- The two-auth-systems problem that motivated this whole discussion. It was entirely a CLI artifact: with every host in-process, every provider arrives by injection at `createSdk`, and the host's auth is the auth. Nothing is configured twice.
- Epic 02's F-4 CLI provider-resolution path (config/env-resolved providers, CLI drain failing loudly without one). It existed to serve CLI drain; it dies with the CLI.
- The Epic 4 CLI flows as specced (CLI parity ACs/TCs, process-suite legs).

### CLI retirement work (when it happens)

- Epic 4 spec patch before its stories build: drop CLI flows and legs (AC-3.4/TC-3.4, AC-5.5/TC-5.4, the CLI Data Contracts line, CLI scope items). Lands at ~21 ACs / ~15 TCs after renumbering. Flow 5's lifecycle exercise reframes as the first cut of the integrated test harness.
- Delete `src/cli/`, the spawned-process suites, and Epic 02's F-4 CLI provider-resolution path. Spec-pack deviation notes where the retired surface was contractual (Epics 1–3 CLI ACs/TCs) — deliberate post-acceptance retirement, not drift.
- PRD/tech-arch backfill: remove CLI as a first-class surface; rewrite the agent-access story ("agents use the CLI directly") as PI custom tools over the SDK; update host language (PI extension now, web/desktop control surface later, harness-wrapper CLIs as possible future hosts consuming the SDK in-process).

---

## Inference Arrives Through One Injected Model-Call Function

LHC needs to make model calls for its derivations but has no logins of its own. At `createSdk`, the host injects **one function** that makes model calls on LHC's behalf:

```
({ providerName, modelId, messages }) => Promise<completion text>
```

Single-turn completion: prompt in, text out. No tools, no streaming, no conversation state. All seven derivation kinds are single-turn, so this signature covers everything.

The layering, from the inside out:

```
domain handlers (Epic 02, built — unchanged)
  → DerivationProvider: semantic per-kind interface (Epic 02 seam, built — unchanged)
    → LHC's real adapter (to be built):
        owns the seven prompts, output shaping,
        the configured model assignment (provider + model) for each derivation kind,
        failure classification into Epic 02 reason codes
      → injected model-call function (the host's one contribution):
          routes (providerName, modelId) to the host's provider machinery
```

### Why one function, not seven injected functions

Per-kind injection moves knowledge to the wrong side of the boundary. The host would hold seven near-identical functions differing only in model choice — which is config, not code — and would have to know LHC's derivation catalog, making an eighth derivation kind a breaking change to every host's wiring. With one injected function, the seven-ness stays inside LHC: prompts are product knowledge, model assignments are LHC config, and the host's wiring never changes when derivations evolve.

### What each side owns

**LHC owns:**
- The seven derivation prompts and output shaping (product knowledge, lives in-package, versioned).
- The model-assignment config and its schema (which provider and model each derivation kind uses).
- Validation: all seven assignments must resolve at init/first-drain; an assignment naming a provider that isn't logged in fails loudly for that kind — derivations land `failed` with a readable reason visible in `inspect.health`, never silent skips, never weird downstream flashes. (Misconfigured/not-logged-in providers are a problem in every design; the requirement is that it's *visible*, because the way it fails is otherwise hard for the user to see.)
- Failure classification: model-call errors map into Epic 02's retry machinery (auth-missing → terminal-until-config-changes; rate-limit → retryable; etc.). PI already throws typed errors for missing auth / unknown provider / unknown model; the adapter classifies, it doesn't swallow.
- **No model opinions.** LHC ships placeholder defaults that fail validation loudly rather than guessing — the seven model assignments are a conscious setup step, because a silent wrong default is exactly the hard-to-see failure mode.

**The host owns:**
- The model-call function itself. For PI: ~15 lines resolving `(providerName, modelId)` through PI's `getModel`/`AuthStorage` and calling PI's `complete`. Public pi-ai surface, standard extension code.
- Credentials, entirely. PI's auth storage already holds multiple simultaneous OAuth/key credentials (Anthropic OAuth, Copilot OAuth, Codex login, raw API keys); the function routes each call to whichever provider is named.
- The model-assignment *values*, supplied at `createSdk` like view profiles and visibility budgets are today.

### Config: start dead simple, generalize from evidence

Per derivation kind, exactly: `kind → { provider, model, prompt }`. Seven entries, flat map, nothing else. No token-size routing, no thinking-setting variants, no rule engine.

Generalizing the options now risks either an over-complicated set we barely use or an over-simplistic one everything gets shoehorned into. The right config vocabulary gets **derived from the seven dialed-in answers** after the dial-in work — look at all seven, see what the options actually need to express (token bands? thinking settings? per-profile prompts?), then design the configurable shape. Known from POC testing: model choice shifts with input token size and input nature, so one derivation may map to different models across input profiles — but that generalization waits for evidence.

LHC config is its own file/schema, host-supplied at `createSdk` — part of the isolation seam. PI's extension section is just where the values live for that host; PI never knows what a derivation is.

### Mixed-lane routing is the normal case, not a special one

Each drain item carries its kind; the adapter looks up that kind's configured provider and model; the injected function routes the call there. Consecutive queue items can hit different providers with no coordination. Real configurations this supports:

- **Home:** all seven kinds → Codex login (e.g. `("openai-codex", "gpt-5.4-mini")`), or split across Codex + Claude OAuth + Copilot OAuth + an OpenAI key simultaneously.
- **Work (PI-restricted environment):** all seven → Copilot (`("github-copilot", "gpt-5.4-mini")`); if Copilot falls through, reassign to Claude Enterprise OAuth (`("anthropic", "claude-haiku-4.5")`).

No all-one-provider restriction — it would buy nothing; routing is free.

**Fallback chains are setup-time, not runtime.** "Haiku, falling back to Sonnet/Opus" means: when configuring a machine, if the preferred provider isn't available, configure a different one. It is not a runtime retry ladder across providers. Each derivation kind gets a single configured `(provider, model)`.

---

## What Stays Out

- **No second provider system, no second auth system, no LHC credential store.** The host's auth is the only auth.
- **No daemon, no sidecar, no out-of-process protocol.** Background derivation runs in the host's process via the existing Epic 02 drain/scheduler machinery; queue rows remain durable across host restarts.
- **No runtime provider-health routing, cost ceilings, or policy logic** in the model-assignment config. That's control-surface-era (Jarvis) territory; the config stays dumb.
- **No Codex/Claude Code harness work on spec.** Priority is a top-notch PI + LHC reference implementation, built into the software factory and customizable with the rest of the harness roadmap (permissive intent-detecting tool repair, memory tickle layers, etc. — separate workstreams). Other harnesses derive from the reference implementation when they become real commitments.

---

## PRD/Tech-Arch Backfill Needed

- Add the inference/derivation feature: real providers, the seven prompts, the injected model-call function, model-assignment config, validation behavior. The real-inference capstone is the integration-readiness gate — M3/M4's deferred quality halves transfer to it.
- The CLI removal sweep (above).

---

## Inference Plumbing Work (the build itself)

- The real `DerivationProvider` adapter: seven prompt implementations. POC's tuned smoothing prompt carries over as-is (5.4-mini, no reasoning — tested extensively against alternatives in the POC: cheaper models were slow and performed badly; mini with no reasoning matched many with high reasoning). The other six written functionally to that prompt's standard but explicitly pre-dial-in.
- Flat per-kind config + fail-loud validation (above).
- The model-call function's interface + failure classification into Epic 02 reason codes.
- PI extension wiring: the small model-call function (PI auth storage + model registry + `complete`, per-call routing); model-assignment values in config; assignments naming not-logged-in providers visible at extension load, not just first drain.
- Opt-in real-provider suite with ran/not-ran accounting (no silent auth-based skips — the standing testing rule).
- Real-inference capstone: full lifecycle with actual derivation output. Proves plumbing — inference works end-to-end, models selectable, failures classify. Output *quality* is the dial-in work's job.
- Deterministic provider remains the test implementation of the same seam; nothing in Epics 1–4's test architecture changes.

### Protected-literals check: demoted, not carried forward as-is

The POC's regex-extract-then-verify pattern (UUIDs/paths/numbers must survive smoothing verbatim, else the result is rejected) is the stale-fingerprint mistake's shape: a clever check that can block progress — it can hang up a smart compact when smoothing breaks repeatedly. (It wasn't Lee's idea; likely GPT 5.5's.) If kept at all: a validation failure degrades quietly to `deterministic_preserved` (raw text, marked degraded — the same fallback the auth-unavailable path uses); never a sticky `failed` marker that makes the record hard to fix, never a retry loop, never something a compact trips over. Losing a small percentage of smoothings is fine. Tendency testing (does this model/prompt preserve paths and IDs?) moves to dial-in evals where it informs model choice; if the runtime check earns nothing after that, it dies.

---

## Turn-End Boundary Advance (Epic 3 patch)

Validated in the POC (commits `1cf2dc45`, `6a9aa7a4`, `f12a850d`) and confirmed by two sessions of live usage: cache-invalidation cost from tool-result trimming dropped to roughly 10–20% of what it was. Epic 3 as built already has most of the design — monotonic boundary, max/target hysteresis, whole-message floor, summary-with-truncation-fallback, compact reset. What it doesn't have is the turn-end trigger: Epic 3's advance check runs after every intake batch commits (message-end granularity, the pre-experiment design, AC-4.9). The turn-end refinement came after Epic 3's stories were accepted and was validated POC-side only; it lives in no spec yet.

The change:
- **Trigger moves from intake-commit to turn-close.** The advance check runs only when a batch closes a turn; mid-turn batches buffer and do nothing. Same post-commit seam, same non-blocking failure semantics — only the firing condition changes.
- **Eviction unit becomes the whole turn.** A crossed turn's tool results flip together — one batch, one cache invalidation at the turn seam, instead of a creep per message. Newest closed turn is always protected whole.
- **Hysteresis unchanged** (cross max → advance to target; POC validated 64k/32k as defaults — config, not contract).
- **Mid-turn safety ceiling: open.** The POC removed it entirely (usage never needed it). Either keep that (turn-end only, monster-turn exposure documented) or add a high ceiling (~100–120k) as the only mid-turn trigger. Lee's usage says the former is fine to start; the ceiling must clear `window − view lower-bound − headroom`, so it's per-deployment math if added.
- Floor, never-backward, compact reset, tool-results-only scope: all unchanged.

Why it works (the validated economics): turn-end gating consolidates 3–6 mid-turn flips into at most one event per closed turn; the max/target gap means most turn-closes fire nothing; chat turns essentially never trigger. Combined: ~6–12x fewer invalidation events at roughly constant per-event cost — and on Anthropic pricing, each avoided re-write also avoids the 1.25x cache-write premium (churn there is worse than not caching at all).

Small, localized to the advance check + its tests.

---

## Integrated Test Harness

**Decision (June 12): this is paired work, not spec-pack work.** Lee + agent build it together after the inference epic lands — working out scenarios, harness structure, and data collection in conversation, not codified unilaterally in stories. Two reasons: which scenarios matter is Lee's usage knowledge (not derivable from specs), and the pairing session doubles as Lee's hands-on acceptance pass over everything Epics 1–5 delivered. The inference epic ships with only a minimal harness stub (the OpenRouter-backed model-call function + existing synthetic fixtures) — enough to run its real-inference suite, nothing more. It then flows straight into the dial-in period (below), which needs the recorded corpora anyway.

A harness + fixtures that exercise the full SDK in-process, end-to-end, with realistic PI-shaped data — so the extension PRD is eventually written from verified seam knowledge, not assumptions about what PI delivers, and so there's real confidence in all operations before extension work starts.

**What it is:** plain vitest, no custom CLI runner. A scenario-script layer — named journeys (long agentic session, mutation-heavy curation pass, crash-and-resume, compact-pull-compact cycles) each runnable against any fixture corpus in either provider mode. Epic 4's Flow 5 lifecycle script is the first entry, not a one-off. Most of the skeleton already exists: Flow 5 specs the journey, the deterministic provider covers CI, Epic 03/04 fixtures cover synthetic states.

**Two provider modes, same scenarios:**
- Deterministic provider (built) — CI, mechanical assertions.
- Real-inference mode — the injected model-call function pointed at a cheap metered key (OpenRouter or OpenAI, nano/flash-class model). Opt-in, ran/not-ran accounting, no silent auth-based skips. The harness proves plumbing and lifecycle with rough prompts; swapping the config to better models is the quality-review mode once real prompts land.

**Realistic data — record live, scenarios first.** Define the scenarios we need, then record them, rather than mining old session files (artifacts) when what we need is what the hooks actually deliver, in order, at the seam (ground truth).

- **Recorder: regular PI + a thin capture-only extension** (~50 lines: subscribe to every hook, append `(hookName, timestamp, payload)` to JSONL). Not the POC — its capture path is mid-experiment and carries POC-era decisions the new extension won't inherit. Clean PI = clean ground truth.
- The capture extension is itself seam reconnaissance: the first draft of the real extension's event-mapping layer, written against live traffic with zero behavior to get wrong. Every surprise it logs (hook ordering, parallel tool-result delivery, abort shapes, what the context hook sees mid-turn) is a question answered before the extension spec pack instead of during it.
- **Scenario list to record** (one session each, driven naturally — roughly a workday of usage wearing a recorder):
  - Chatty baseline — conversation, few/no tools (turn boundaries, prompt shapes)
  - Heavy agentic — multi-tool turns, big reads, edits (parallel tool calls land here)
  - Monster turn — one long review/analysis turn, 20+ tool calls (the uber-turn case)
  - Error traffic — failed tool calls, a malformed call, retries
  - Abort/interrupt — user cancels mid-turn (turn never closes cleanly)
  - Resume — kill PI, reopen session, continue (what replays vs. what's new)
  - Compaction event — PI's own compaction fires mid-session (what hooks see when context management intervenes)
- **Converter:** recorded hook-stream → LHC intake batches; each scenario becomes a named fixture corpus. Writing the converter forces pinning exactly what PI emits vs. what intake needs — every mismatch is a seam question answered early. The converter is also most of the extension's event-mapping logic, written early against static files instead of live hooks.
- Old session files drop to a cross-check role (verify the recorder isn't missing anything systematic), possibly to nothing.

**Sizing:** converter is the real work (PI hook-stream archaeology + mapping decisions); the scenario layer and the cheap-model call function are small.

---

## Derivation Dial-In

Prompt/model iteration doesn't fit SDLC planning shapes — it's evaluation work, closer to ML practice than build work — which is exactly why the POC ended up with one tuned derivation and six slopped ones. It needs its own carved-out period rather than being smuggled into an epic's stories.

**What it is:** Lee + an agent, one derivation at a time, all seven. Per-derivation harness config (candidate models × prompt variants), run over recorded corpus samples, side-by-side outputs, Lee's judgment as the gate. His model knowledge and prompting instinct are the irreplaceable input; this doesn't delegate.

**Sequencing constraint worth remembering** (not a plan, just a dependency): dial-in needs working plumbing and realistic corpora, and it's better done before extension bring-up — the extension gets dogfooded through its own views, and if bands are full of slop summaries, every "is the extension working right?" judgment is contaminated by "or is it just bad derivation?"

**Known starting points:**
- Smoothing is mostly settled (5.4-mini, no reasoning — beat cheaper-but-slow and reasoning-heavy alternatives in POC testing). Open behavior question: handling of code-heavy prompts (fenced blocks are currently stripped from literal protection and there's no skip logic at all — whatever code-avoidance exists today is emergent, not designed; Lee doesn't like skipping smoothing for code-heavy prompts). Settle it here.
- Expect input-dependent model selection: POC experience says model choice shifts with token count and input nature, so one derivation may map to different models across input profiles. Speed/cost/quality balance within the available provider lanes is the optimization target.

**Outputs to capture when it happens:**
1. Seven dialed-in (provider, model, prompt) answers — possibly input-profile-conditional.
2. The generalized config vocabulary, derived from looking at all seven answers together — what the options actually need to express. Replaces the flat map only then, on evidence.
3. Eval notes per derivation (what was tried, what won, why) — these land in the inference epic/tech-design before that pack freezes (spec packs correctable until acceptance; these epics are technical-natured anyway, the user is PI, so dial-in findings in the epic is consistent).
4. Tendency evals that replace runtime cleverness: e.g. "does this combo preserve paths/IDs?" tested here, instead of policed by regex checks at runtime.

---

## Captured Rules for the PI Extension Epic (when it gets written)

- **Actionable-only status surfacing.** Nothing reaches PI's status line unless the user can act on it. Everything else — failed derivations, degraded forms, retry exhaustion — lives in `derived_form` state and the health report, queryable, with requeue as the action. The POC's sin: flooding the status area with non-actionable error spew that eventually scrolls away, leaving nothing to do and no record. LHC's side already supports this; the rule binds the extension's reporting design.

---

## Open Items (flagged in discussion, not yet settled)

- **Postgres path for the web/desktop host:** SQLite is fine now; the storage seam should be checked for what a Postgres swap would actually touch when the control surface becomes real work.
- **Exact model-assignment config file location/format** (LHC-schema'd file the extension points at vs. embedded in PI's extension settings). Settled in principle: the schema is LHC's, the values are host-supplied, and it's a deliberate isolation seam.
- **Epic shape:** how many epics this all is, what gets cut, what goes where — decided later when we bucket and prioritize, not now.
