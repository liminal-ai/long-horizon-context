# Epic 05: Derivation Inference

**Status:** Draft — pending review
**PRD:** `../00-prd.md` (Feature 5 backfill rides this epic's spec cycle)
**Tech Arch:** `../01-tech-arch.md`
**Depends on:** Epic 02 (provider seam, queue/retry machinery, derived-form states), Epic 03 (visibility boundary — Flow 5 patches its contract), Epic 04 (lifecycle exercise — Flow 4 adds its real-inference leg; built, deviation state consumed as landed)
**Counts:** 22 ACs / 15 TCs across 6 flows

## Onboarding Context

Read first: `../../01-onboard/01-core-concepts.md` (the derivation vocabulary), `../../01-onboard/02-domain-design.md` §Messages and §Turns (who owns which derivation), Epic 02's epic §Flow 4 and §Data Contracts (the provider seam and state machine this epic puts real inference behind). Background: `../post-epic-4-work.md` records the decisions this epic implements and the reasoning behind them.

## User Profile

**Primary user:** the operator (Lee) configuring which models run LHC's derivations, and — through the SDK boundary — any host process that hands LHC a model-call function at setup.

**Context:** four epics built a complete derivation pipeline with zero real inference anywhere in it. Every derived form in every thread is a deterministic marker string. The product's actual intelligence — readable summaries, smoothed prompts, band content worth living in — does not exist yet. This epic closes that gap and retires the surfaces whose consumers disappeared.

**Mental model:** LHC owns what to ask (seven prompts, one per derivation kind) and which model to ask it of (per-kind assignment in config). The host owns how to reach models (one injected function wrapping its own auth). One function in, seven kinds of judgment out. The host never learns what a derivation is; LHC never learns what a credential is.

**Key constraint:** prompts ship rough. The smoothing prompt carries over from the POC settled; the other six are written to its standard but untuned. The dial-in working period that follows this epic produces the tuned answers, and its findings backfill this pack before acceptance. The epic's job is plumbing that provably works — not output quality, which has its own gate.

## Feature Overview

This epic makes LHC's derivations real. A host hands `createSdk` one model-call function and a per-kind model assignment config; LHC's adapter renders each derivation's prompt, routes the call through the host's function to the assigned provider and model, shapes the output into the derived form, and classifies failures into Epic 02's retry machinery. An opt-in verification suite proves the whole path against a real endpoint, ending in the real-inference leg of Epic 04's lifecycle exercise — the integration-readiness gate the deterministic leg explicitly deferred.

Two riders land alongside, both consequences of decisions recorded in `post-epic-4-work.md`: the CLI is deleted (LHC is a stateful SDK consumed in-process; the CLI's last consumer dissolved), and the tool-result visibility boundary moves its trigger from intake commit to turn close (validated in the POC: cache-invalidation cost dropped to 10–20% of prior).

### Flow Summary

1. [Inference Wiring and Model Assignment](#flow-1-inference-wiring-and-model-assignment) — the injected function and per-kind config, validated loudly at construction. AC 1.1–1.4
2. [The Adapter and the Seven Prompts](#flow-2-the-adapter-and-the-seven-prompts) — LHC-owned prompts behind the unchanged Epic 02 seam. AC 2.1–2.5
3. [Failure Classification](#flow-3-failure-classification) — structured failure kinds mapped into retry/terminal machinery. AC 3.1–3.3
4. [Real-Inference Verification](#flow-4-real-inference-verification) — the opt-in suite and the capstone leg. AC 4.1–4.2
5. [Turn-End Boundary Advance](#flow-5-turn-end-boundary-advance) — Epic 03 contract patch: trigger at turn close, whole-turn eviction. AC 5.1–5.5
6. [CLI Retirement](#flow-6-cli-retirement) — delete the surface whose consumer no longer exists. AC 6.1–6.3

## Scope

### In Scope

The work that makes derivations real and consolidates the SDK-only consumption model:

- The model-call injection seam: `createSdk` accepts one host-supplied function plus per-kind model assignments, as an alternative to direct provider injection (which stays, for tests)
- The inference adapter: implements `DerivationProvider` over the injected function; owns the seven prompts, output shaping, and per-form provenance stamping
- Failure classification: structured failure kinds → retryable/terminal → Epic 02's existing queue and reason-code machinery, unchanged
- The opt-in real-inference suite with explicit ran/not-ran accounting, backed by a test-owned OpenRouter model-call function (the minimal harness stub — not the full integrated harness)
- The real-inference leg of Epic 04's lifecycle exercise: the integration-readiness gate
- Turn-end boundary advance: the Epic 03 visibility-boundary contract patch
- CLI deletion: `src/cli/`, all process suites, the named-provider registry and env resolution path

### Out of Scope

- PI extension wiring — the host-side function, config values, startup validation surfacing (extension PRD; see `../pi-ext-prd-notes.md`)
- The full integrated test harness — capture extension, recorded corpora, converter, scenario journeys (paired working period after this epic)
- Prompt and model dial-in — evaluation of models × prompts over real corpora (working period after the harness; findings backfill this pack before acceptance)
- Config generalization — token-size routing, fallback chains, thinking settings, variant prompts (deferred until the seven dialed-in answers exist to derive the vocabulary from)
- A mid-turn advance safety ceiling — the POC removed it and usage hasn't needed it; revisit on evidence
- Output quality as an acceptance criterion — structure and plumbing are asserted; quality is the dial-in gate

### Assumptions

| # | Assumption | Basis |
|---|-----------|-------|
| 1 | Epic 04 is built; its deviation state (e.g. overview boundary from `pull.meta`) is the consumed contract | Tech-lead closeout, June 2026 |
| 2 | All seven derivations are single-turn completions: prompt in, text out, no tools, no streaming | Epic 02 provider seam; POC behavior |
| 3 | An OpenRouter key is available for the opt-in suite; its absence is a visible not-ran, never a silent green | Standing testing rule: no auth-based skips |
| 4 | The deterministic provider remains the CI default; nothing in the default suite touches a network | Epic 02 NFR, carried forward |
| 5 | Hosts are long-lived processes; per-call routing needs no caching/pooling beyond what the host's function does internally | SDK-only consumption decision |

## Flow 1: Inference Wiring and Model Assignment

A host constructs the SDK one of two ways. The existing way stands unchanged: inject a `DerivationProvider` directly (the deterministic test provider, or any custom implementation). The new way is the production path: inject an `inference` config — one model-call function plus a model assignment for each of the seven derivation kinds. The SDK builds the real adapter (Flow 2) over them. Exactly one of the two must be present; both or neither is a construction error.

The model-call function is the only thing that ever touches credentials, and it lives entirely on the host's side of the boundary. Its contract is deliberately minimal: take a provider name, a model id, and a messages array; return text or a structured failure. The provider and model strings are opaque routing keys to LHC — they mean whatever the host's function makes them mean. A host authed to four lanes routes per-call on the provider string; mixed assignments across lanes in one config are the normal case, not a special one.

The model assignment config is flat and complete: every one of the seven kinds names its provider, model, and prompt. No defaults that silently route — a missing kind, an unknown kind, or an unknown prompt name fails construction loudly, naming the problem. Configuring the seven assignments is a conscious setup step by design: a silent wrong default is exactly the hard-to-see failure mode this validation exists to prevent.

#### Acceptance Criteria

- **AC-1.1**: `createSdk` accepts exactly one of `provider` (a `DerivationProvider`, unchanged) or `inference` (model-call function + assignments). Both supplied, or neither, is a caller error naming the rule.
- **AC-1.2**: The model-call function contract: it receives `{ provider, model, messages }` for a single-turn completion and returns `{ ok: true, text }` or `{ ok: false, kind, message }` with `kind` from the failure vocabulary (Data Contracts). LHC never inspects credentials, never constructs API clients, and sends nothing but this call shape across the boundary.
- **AC-1.3**: Assignment validation at construction: all seven kinds present, each naming a known prompt; a missing kind, unknown kind key, or unknown prompt name fails `createSdk` with a caller error naming the specific kind/prompt. No partial construction.
- **AC-1.4**: Per-call routing: each drained work item looks up its kind's assignment and the function receives that assignment's provider and model strings. Different kinds routing to different providers in one config work item-by-item with no cross-kind interference.

#### Test Conditions

- **TC-1.1** (AC-1.1, AC-1.3): Construction matrix — `inference` config missing one kind → error naming it; unknown prompt name → error naming it; both `provider` and `inference` → error; neither → error; complete valid config → SDK constructs and operates.
- **TC-1.2** (AC-1.2, AC-1.4): A recording fake function (returns canned text, logs every call): seed a thread needing all seven kinds, drain → the log shows each kind's call carrying exactly its assigned provider/model strings and a single-turn messages array; a config assigning kinds across three fake "lanes" routes each call to its own lane.

## Flow 2: The Adapter and the Seven Prompts

The adapter is the inference epic's core deliverable: an implementation of Epic 02's `DerivationProvider` whose seven operations each render an LHC-owned prompt around the operation's input, call the injected function with the kind's assignment, and shape the response into form content. The seam does not move — handlers keep calling `provider.smoothPrompt(...)` exactly as they do against the deterministic provider; nothing in `domains/` knows whether marker strings or a real model sits behind the interface.

Prompts are product knowledge and live in LHC, named and versioned (`smoothing-v1`). The smoothing prompt carries over from the POC, where it was tested and settled. The other six are written functionally to its standard and explicitly marked pre-dial-in: structurally sound, honest about being untuned. The config's `prompt` field selects by name, which is what makes the dial-in period a config-and-content exercise rather than a code change.

Two Epic 02 invariants are explicitly preserved because real inference is precisely where they're tempting to break: outcomes and receipts stay mechanically stamped from the record — provider prose is never parsed for facts — and the brief chunk summary structurally cannot see receipt text (the Epic 02 input-stripping contract). And one new rule: a model that returns empty or whitespace-only text has not produced a derivation; that's a classified failure, never an empty `ready` form.

Every form a real model produces also records its provenance: which provider, model, and prompt version made it. That stamp is what makes the dial-in period's evals attributable — output quality questions become joinable to the assignment that produced the output.

#### Acceptance Criteria

- **AC-2.1**: The adapter implements all seven `DerivationProvider` operations over the injected function. Domain handlers are untouched: the same handler code runs against the deterministic provider and the adapter.
- **AC-2.2**: Each operation renders its kind's prompt around the operation's input into the messages array; the response text, shaped, becomes the form content. Outcomes and receipts remain mechanically stamped from the record — no provider-authored facts (Epic 02 outcome and receipt-stripping contracts hold under real inference).
- **AC-2.3**: Prompts are named and versioned in LHC; the smoothing prompt is the POC's settled version; the other six exist, render correctly, and are marked pre-dial-in. The config's prompt name selects among them.
- **AC-2.4**: Empty or whitespace-only response text is a classified failure (`kind: empty_output`, retryable), never a `ready` form.
- **AC-2.5**: Every form the adapter lands `ready` carries provenance in its metadata: provider, model, and prompt version that produced it — mechanically stamped by the adapter, never parsed from output.

#### Test Conditions

- **TC-2.1** (AC-2.1, AC-2.2, AC-2.5): With a scripted fake function returning distinct canned text per kind: drain a seeded thread → all seven form kinds land `ready` with content from the canned responses; outcomes/receipts match the record (not the canned text); each form's metadata carries the assignment that produced it.
- **TC-2.2** (AC-2.2, AC-2.3): Prompt-rendering goldens: for each kind, the messages array built from a fixture input matches the prompt's contract — fixture content embedded, single-turn shape; the brief-summary rendering contains no receipt text from its input (stripping contract holds through the adapter).
- **TC-2.3** (AC-2.4): Fake function returns `{ ok: true, text: "  " }` → form does not land ready; failure classified retryable with reason visible in the report.

## Flow 3: Failure Classification

The adapter's second duty: turning the messy reality of model calls into Epic 02's clean vocabulary. The injected function reports failures as structured kinds; the adapter maps each kind to retryable or terminal by a fixed table and hands the result to the existing queue machinery — which needs no changes, because Epic 02 built it for exactly this and it has simply never had a real failure to chew on.

Retryable failures ride the existing backoff/attempts path; exhaustion lands the form `failed` with the stable reason and the last error preserved in metadata. Terminal failures — bad auth, malformed request — land `failed` immediately without burning the retry budget on calls that cannot succeed. A host function that throws instead of returning a structured failure is caught and classified as `other` (retryable, budget-bounded): a misbehaving host degrades derivations, never crashes a drain.

This is also where the misconfigured-lane story resolves at runtime: a config naming a provider the host isn't authed to surfaces as terminal `auth` failures on every form assigned to that lane — visible in the health report with an actionable reason, exactly the F-4 fail-loudly posture relocated from the dead CLI config path to the live one.

#### Acceptance Criteria

- **AC-3.1**: Classification is a fixed table: `rate_limit`, `timeout`, `network`, `empty_output`, `other` → retryable; `auth`, `invalid_request` → terminal. The table is data, asserted directly.
- **AC-3.2**: Classified failures drive Epic 02's machinery unchanged: retryable failures back off and retry within budget; exhaustion → `failed` with reason `provider_failure`, attempts and last error in form metadata; terminal failures → `failed` on first attempt, no further calls for that item.
- **AC-3.3**: A thrown exception from the model-call function is caught, classified `other`, and the drain continues. No host function behavior can crash a drain.

#### Test Conditions

- **TC-3.1** (AC-3.1, AC-3.2): Scripted failures — function returns `rate_limit` twice then succeeds → form `ready`, attempts recorded; function returns `auth` → form `failed` immediately, exactly one call made, stable reason; exhaust a `network`-failing item → `failed`, `provider_failure`, last error preserved.
- **TC-3.2** (AC-3.2, AC-3.3): Function throws a bare `Error` mid-drain → that item retries as `other` and the rest of the drain completes; exhaustion lands it `failed` with the thrown message as last error; no exception escapes the drain.

## Flow 4: Real-Inference Verification

Everything above is provable with fakes except the one claim that matters most: the path works against a real model. The opt-in suite proves it. When the key is present, a test-owned model-call function backed by OpenRouter routes every kind to a configured cheap model and the suite makes real calls; this function is the proof-of-seam — a second, real host of the same injection contract the PI extension will implement later. When the key is absent, the suite records an explicit not-ran with reason. It never silently passes: the standing rule is that auth-gated skips are invisible failures, so the accounting is the deliverable.

The suite's closing story is the capstone: Epic 04's full lifecycle sequence — intake, drain, compact, pull, inspect, mutate, rebuild, second compact, materialize — run with the real adapter. Its deterministic sibling asserted byte-exact replay; this leg can't (real models don't repeat themselves), so it asserts structure: every derivation lands `ready` with non-empty, non-marker content; checkpoint coherence holds (post-mutation health shows cleared forms pending, post-drain shows them ready, the second compact's view reflects post-edit content); provenance stamps name the real model. This run is the integration-readiness gate that Epic 04's Flow 5 explicitly deferred — the moment the rebuild stops being less of an AI product than the POC it replaces.

#### Acceptance Criteria

- **AC-4.1**: The real-inference suite is opt-in on key presence and its outcome is always visible: ran (with the model assignments used) or not-ran (with reason) in the suite output. Absence of the key can never produce a silent pass. The suite's model-call function lives in test code, implements the AC-1.2 contract, and reaches a real endpoint.
- **AC-4.2**: The capstone: the Epic 04 lifecycle sequence with the real adapter completes with every derivation kind landing `ready` at least once — non-empty content, no deterministic-marker strings, provenance naming the real model — and the deterministic leg's checkpoint-coherence assertions hold structurally (cleared-then-ready around mutations; second compact reflects post-edit content).

#### Test Conditions

- **TC-4.1** (AC-4.1): With the key: each of the seven kinds round-trips real inference once → `ready`, non-empty, non-marker content. Without the key (unset in a controlled leg): the suite emits the not-ran record with reason; the run is distinguishable from a pass.
- **TC-4.2** (AC-4.2): The capstone sequence end-to-end on the real adapter → all structural checkpoint assertions pass; every form kind appears `ready` with real-model provenance; mutation-cleared forms regenerate with new content.
- **TC-4.3** (AC-4.1): The suite's function is contract-conformant: run the Flow 1 construction and routing assertions (TC-1.1's valid leg, TC-1.2's routing shape) against it unchanged — proving the test host and any future host satisfy the same seam.

## Flow 5: Turn-End Boundary Advance

A contract patch to Epic 03's visibility boundary, carrying a POC-validated finding back into the spec: the advance check moves from after-every-intake-commit to turn close. Mid-turn, the boundary never moves — everything read this turn stays full this turn. When a batch containing a `turn_end` commits, the check runs once over the closed state: if the full-zone tool-result token sum exceeds max, the boundary advances over whole turns, oldest first, until the sum first lands at-or-under target.

Eviction granularity changes with the trigger: whole turns, not individual messages. A peek-ahead stop rule keeps the landing honest: a turn is evicted only if the remaining sum stays at-or-above target, so the zone lands in [target, target + one turn). The protected floor's job is restructured rather than dropped — with no mid-turn advance, the open turn is structurally untouchable, and the newest closed turn is never evicted regardless of size. The floor token budget is retired from config; max and target remain, defaulting to 64k/32k (POC-validated: invalidation cost at 10–20% of the per-message design, with one bounded ~target-sized re-write per several heavy turns and nothing during conversation).

Everything else in Epic 03's boundary contract holds unchanged: monotonic forward-only motion, summary-preferred short form, compact reset to the compact point, deterministic mechanical advance, the post-commit seam, non-blocking failure with status visibility. A deliberate consequence is named rather than hidden: with no ceiling, a single monster open turn can grow the zone unboundedly until it closes. The POC removed the mid-turn safety valve and live usage hasn't needed it; it stays out until evidence says otherwise (Out of Scope).

#### Acceptance Criteria

- **AC-5.1**: The advance check runs only when an intake batch commits a `turn_end`. Mid-turn batches never move the boundary regardless of zone size, and rendered bytes do not change between turn closes.
- **AC-5.2**: Eviction is whole-turn, oldest-first: an advance flips every tool result in each evicted turn together; no turn is ever partially flipped.
- **AC-5.3**: The peek-ahead stop: a turn is evicted only if the zone's sum after evicting it remains ≥ target. The advance lands in [target, target + one turn). The newest closed turn is never evicted.
- **AC-5.4**: Config is max and target with defaults 64k/32k; max > target validated with a caller error; the floor token budget is retired from the config surface.
- **AC-5.5**: All other Epic 03 boundary contracts hold under the new trigger: forward-only, summary-else-truncation short form, compact reset, deterministic replay, post-commit seam with non-blocking failure visible in status.

#### Test Conditions

- **TC-5.1** (AC-5.1, AC-5.2): Mid-turn batches accumulate tool results past max → boundary unmoved, pulls byte-identical; the batch closing the turn commits → one advance, whole turns flipped oldest-first, no partial turn; a small next turn closes under max → no movement.
- **TC-5.2** (AC-5.3, AC-5.4): Peek-ahead — seeded turns sized so evicting the next would dip below target → advance stops above target; zone lands in [target, target + one turn); newest closed turn intact even when it alone exceeds target; `max ≤ target` config → caller error naming the constraint.
- **TC-5.3** (AC-5.5): Epic 03's regression legs under the new trigger: flipped results stay flipped across subsequent turn closes; compact resets the boundary to the compact point with a fresh full tail; same record + same budgets → same boundary trajectory; injected advance failure → intake unaffected, boundary unchanged, status shows the over-budget zone, next turn close heals.

## Flow 6: CLI Retirement

The decision is recorded in `post-epic-4-work.md`; this flow is its execution. LHC is consumed by `createSdk` inside a host process — the PI extension, the future app-server host, any wrapper CLI someone builds as a host. The `lhc` CLI's only coherent consumer was an out-of-process driving model nobody is building, and an interface with no consumer is standing incoherence: every surface story paid a parity tax to keep it current.

Deletion is whole: `src/cli/` and its binary entry, all twelve spawned-process suites, and the named-provider registry with its `--provider`/`LHC_PROVIDER` resolution path — machinery that existed only because the CLI had no construction step. Providers now arrive exactly one way: injected at `createSdk`. The Epic 04 spawned `inspect health` parity gap was backfilled before this epic; this pack carries the deviation note and then deletes the spawned-process parity surface instead of preserving it.

What this is not: a behavior change. Every operation the CLI fronted lives on the SDK surface with its own direct tests. The deletion removes a transport, not a capability — and the SDK suites that proved parity all along are the regression net that proves nothing else moved.

#### Acceptance Criteria

- **AC-6.1**: `src/cli/` is deleted; the package publishes no binary; SDK exports drop the CLI-only entries (`resolveNamedProvider`, `registeredProviderNames`, and the registry module). The public API surface is SDK-only.
- **AC-6.2**: All spawned-process suites are deleted; the full remaining suite is green with no spawned-process dependency anywhere; no SDK behavior test was weakened or removed with them.
- **AC-6.3**: The env/flag provider-resolution path is gone: no code path reads `LHC_PROVIDER`, and provider arrival is injection at `createSdk` only.

#### Test Conditions

- **TC-6.1** (AC-6.1, AC-6.2): Post-deletion verification: full `verify` green; package manifest has no `bin`; importing the removed registry entries fails at build; a public-API surface snapshot matches the SDK-only export set; SDK suite count/coverage over domain operations is unchanged from pre-deletion (process suites only).
- **TC-6.2** (AC-6.3): Source-level check: zero references to `LHC_PROVIDER` or `--provider` resolution outside spec history; constructing the SDK remains the only provider path (a drain with no injected provider/inference config is the existing construction error, not a resolution fallback).

## Data Contracts

**The model-call function** (the one thing a host supplies):

```ts
type ModelCall = (input: {
  provider: string;          // opaque routing key — means what the host's function makes it mean
  model: string;             // model id within that lane
  messages: { role: "system" | "user"; content: string }[];  // single-turn, no tools, no streaming
}) => Promise<ModelCallResult>;

type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; kind: ModelCallFailureKind; message: string };

type ModelCallFailureKind =
  | "rate_limit" | "timeout" | "network"      // retryable
  | "auth" | "invalid_request"                 // terminal
  | "other";                                   // retryable (budget-bounded); also the classification for thrown exceptions
```

**The model assignment config** — flat, complete, three fields per kind. Worked example with mixed lanes (the normal case):

```ts
inference: {
  call: hostModelCallFunction,
  assignments: {
    smoothed_prompt:        { provider: "openai-codex",   model: "gpt-5.4-mini",     prompt: "smoothing-v1" },
    tool_call_summary:      { provider: "openai-codex",   model: "gpt-5.4-mini",     prompt: "tool-call-v1" },
    tool_result_summary:    { provider: "github-copilot", model: "gpt-5.4-mini",     prompt: "tool-result-v1" },
    turn_rendering:         { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "turn-compose-v1" },
    lower_band_projection:  { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "lower-band-v1" },
    chunk_summary_detailed: { provider: "anthropic",      model: "claude-haiku-4.5", prompt: "chunk-detailed-v1" },
    chunk_summary_brief:    { provider: "openai",         model: "gpt-5-nano",       prompt: "chunk-brief-v1" },
  }
}
```

**Provenance stamp** (added to `DerivedFormMetadata`, mechanically stamped on `ready` forms the adapter produces):

```ts
provenance?: { provider: string; model: string; prompt: string }
```

**Classification table** (AC-3.1, the complete mapping): `rate_limit | timeout | network | empty_output | other` → retryable; `auth | invalid_request` → terminal. `empty_output` is adapter-generated (AC-2.4), never returned by the host function.

**Boundary config change** (Flow 5): `visibility: { maxTokens: 64_000, targetTokens: 32_000 }` — the floor field is retired; `maxTokens > targetTokens` validated.

## Non-Functional Requirements

- The CI-default suite makes zero network calls; real inference exists only in the opt-in suite. The deterministic provider remains the default test provider.
- Compact, pull, status, and inspect never invoke the model-call function — inference happens only in drained work (Epic 03's NFR, restated against the real adapter).
- The capstone runs on the configured cheap model with fixture-bounded inputs; a single run costs cents, not dollars.
- Adapter overhead (prompt rendering, shaping, stamping) is in-process string work; per-item latency is dominated by the model call itself.
- No new dependencies for the adapter; the OpenRouter-backed test function uses plain `fetch` in test code.

## Tech Design Questions

1. Prompt storage and versioning shape: modules exporting named templates vs. a prompt table — and what the dial-in period needs for cheap swapping (config-only selection is the contract; storage is design's call).
2. Timeout ownership: does the adapter enforce a per-call timeout around the host function (and classify it `timeout`), or is timeout entirely the host function's duty? Lean: adapter-enforced with a config default, so a hung host call can't stall a drain.
3. Input bounding: whether `summarizeToolResult` truncates oversized inputs before the call (a 200k-char tool result on a small-context model), and where that bound lives. Dial-in will tune the value; design names the seam.
4. The turn-end trigger's seam: the advance check needs open-turn state at commit time — carried on the intake context vs. one query; and confirm ordering against Epic 02's queue poke on the shared post-commit seam.
5. Whether TC-4.3's contract-conformance run is literally the same test parameterized over both hosts or a shared assertion helper — parameterization preferred if the suite layout allows.

## Story Breakdown

Recommended order: Story 1 first (deleting the CLI before plumbing work means Stories 2–5 never maintain parity legs for a dead surface), then the pipeline in dependency order, riders last.

### Story 1: CLI Retirement
Flow 6. Deletion, export cleanup, surface snapshot, the Epic 04 parity-gap deviation note. No design content; the regression net is the existing SDK suites. AC-6.1–6.3, TC-6.1–6.2.

### Story 2: Inference Seam and Model Assignment
Flow 1. The `createSdk` alternative, the function contract, config validation, per-call routing. Foundation for 3–5. AC-1.1–1.4, TC-1.1–1.2.

### Story 3: The Adapter and the Seven Prompts
Flow 2. The `DerivationProvider` implementation, prompt rendering, output shaping, provenance stamping, the empty-output rule. Smoothing prompt ported; six written pre-dial-in. AC-2.1–2.5, TC-2.1–2.3.

### Story 4: Failure Classification
Flow 3. The classification table, retry/terminal wiring into Epic 02 machinery, exception containment. AC-3.1–3.3, TC-3.1–3.2.

### Story 5: Real-Inference Suite and Capstone
Flow 4. The OpenRouter-backed test function, ran/not-ran accounting, the seven round-trips, the capstone leg. Needs the key (Assumption 3). AC-4.1–4.2, TC-4.1–4.3.

### Story 6: Turn-End Boundary Advance
Flow 5. The Epic 03 contract patch: trigger move, whole-turn eviction, peek-ahead stop, floor retirement, regression legs. Independent of 2–5; POC commits `1cf2dc45`/`6a9aa7a4`/`f12a850d` are the reference implementation. AC-5.1–5.5, TC-5.1–5.3.

## Traceability

| AC | TC(s) |
|---|---|
| AC-1.1 | TC-1.1 |
| AC-1.2 | TC-1.2, TC-4.3 |
| AC-1.3 | TC-1.1 |
| AC-1.4 | TC-1.2 |
| AC-2.1 | TC-2.1 |
| AC-2.2 | TC-2.1, TC-2.2 |
| AC-2.3 | TC-2.2 |
| AC-2.4 | TC-2.3 |
| AC-2.5 | TC-2.1 |
| AC-3.1 | TC-3.1 |
| AC-3.2 | TC-3.1, TC-3.2 |
| AC-3.3 | TC-3.2 |
| AC-4.1 | TC-4.1, TC-4.3 |
| AC-4.2 | TC-4.2 |
| AC-5.1 | TC-5.1 |
| AC-5.2 | TC-5.1 |
| AC-5.3 | TC-5.2 |
| AC-5.4 | TC-5.2 |
| AC-5.5 | TC-5.3 |
| AC-6.1 | TC-6.1 |
| AC-6.2 | TC-6.1 |
| AC-6.3 | TC-6.2 |

Every AC is covered; no orphan TCs; IDs are contiguous within flows.
