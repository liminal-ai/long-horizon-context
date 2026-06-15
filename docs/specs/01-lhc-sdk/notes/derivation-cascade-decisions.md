# Derivation & Cascade Decisions — Working Notes

**Status:** Informal working inventory. Capturing decisions as we walk the derivations top-to-bottom — generation, state conditions, error/fallback conditions — for the seven derivations and how they recombine into turns (and later chunks).

**Rule for this doc:** only decisions Lee clearly made or confirmed go in the "Decided" sections. Things proposed but not confirmed are parked under "Open / not yet decided." Not everything below is built — several are changes from the current rebuilt code.

**Scope covered so far:** `smoothed_prompt`, `tool_call_summary` (dropped), `tool_result_summary`, `turn_rendering`, chunk creation mechanics + the smart-compact chunk cascade. Mostly carved; remaining: the non-compact chunk-level floor (see Chunk section "Open"), and `lower_band_projection` as its own kind (touched as turn-derivation's second output and as chunk-summary input, not walked standalone).

---

## Vocabulary (DECIDED — governs this doc, our specs, and the eventual code rename)

The word "form" / `derived_form` / `FormKind` is killed. It was one vague word smeared across three concepts (the thing, its type, its status), and it means nothing to Lee even knowing the system cold — a naming failure. Replaced by:

- **derive / deriving** — the *act* of producing a derivation.
- **derive out** — the *immediate transient output* of a derive, pre-commit. A coined compound, deliberately distinct from "derivation" so the two can't blur. Used only where it's needed (e.g. the recovery cascade, where candidate output must be distinguished from the committed thing). Reserved name — do NOT coin a new word for this later.
- **derivation** — the *final stored thing*: the persisted result + its type + its state. (Replaces `derived_form` / "form".)
- **derivation type** — which of the seven. "Type," not "kind" — type carries the "one of an enumerated set" meaning; kind is a vaguer synonym. (Replaces `FormKind` / "kind".)
- **state** — the derivation's state (pending/ready/failed/blocked). **Belongs to the derivation, never floated on the subject** (chunk/turn/message). A chunk does not have "a derived state" — its *detailed derivation* has a state and its *brief derivation* has a state, independently. Qualify a specific one as `<type> derivation` ("the brief chunk derivation").

**Specific derivations** are named by qualifying: "the turn derivation," "the brief chunk derivation," "the prompt smoothing derivation." No separate identifier needed.

**Structural flag (decide at schema time, not now):** state is clean only if each derivation is its own row (its own type, subject, state, content). If instead a subject row carries `detailed_state` / `brief_state` columns, the smear is baked into the schema and "state" needs field-name disambiguation again. Per-derivation-row is the model where the vocabulary stays clean.

**Code rename is NOT now** — it rides the SDK rework whenever we get there. Right now this vocabulary governs how we write and talk. The `snake_case` identifiers in the sections below (`smoothed_prompt`, etc.) are the current code names, kept for traceability; the *concept* word for each is "derivation."

---

## The four states (reference)

A derivation has one content field and one state: `pending | ready | failed | blocked`.
- **pending** = not done yet — covers never-attempted-yet and currently-retrying. (This is the default at creation. "Never attempted" maps to pending; it is not a separate state.)
- **ready** = derived successfully, content present.
- **failed** = attempted, retry budget exhausted, gave up.
- **blocked** = source record damaged.

---

## `tool_call_summary` — DROPPED

**Decision:** remove it entirely (FORM_KINDS, work-queue, compose).

**Why:** unrequested rebuild addition; the POC never had it; nobody can name its purpose or the pain it alleviates. Lee: don't keep features nobody has memory of or a known pain point for. Summarizing tool-call *arguments* isn't wanted — keep the call part as-is.

---

## `tool_result_summary` — KEEP

**Decisions:**
- **Two zones, two mechanisms:** the **full band** uses deterministic **truncation** (can run in the hot path); the **smooth band** uses inference **summary** (cannot run in the hot path). Truncation is already in use; summary is the added inference.
- **Target size — tiered by token count (FIRST PASS, to be dialed in).** Lee's proposed first cut:
  - up to ~1000 tokens → target **10-20%** summarization
  - ~1000 to ~5000 tokens → target **2-5%** summarization
  - beyond ~5000 tokens → **truncation only** (no summary)
  - The token thresholds and percentages are a first pass. Subsequent passes dial in `tool_result_summary` based on more aspects of the tool result — **including which tool it is** — and will be added later.
- **Per-tool guidance in the prompt.** Not one generic rule — the output **shape** and the **priorities** differ per tool, so guidance is written per tool.
- **Corpus/test cases come at dial-in,** not now — built when working through prompt/model testing. Needs real captured results: reads, writes, big/small `rg`s, and a failed version of each.

**Why per-tool:** "there are different priorities for different tools and the output shape for each tool is very different." A generic keep-rule loses the per-tool distinctions that make a summary trustworthy.

---

## `smoothed_prompt` — KEEP, with deterministic + inference stages

**Normal flow (everything working):**
- `message_end` projects the user_prompt message → fires an async smoothing request.
- The **async worker** picks it up and smooths it: a **two-step process (deterministic then inference)**, or a **one-step process (deterministic only)**, depending on length.
- Either way, when done the state is `ready` and the derived field holds the content — regardless of whether one stage or both ran.

**The gate is length only.** Whether inference runs is decided by length (token count). Over the cap → deterministic only (one-step). Under the cap → deterministic + inference (two-step). Deterministic is not gated — it's one of the two stages designed to normally run.

**Why a length gate:** past a certain length you don't want to burn the tokens running inference smoothing on it.

**Fenced code:** handled inside the inference prompt instruction (and tested), not by segmentation or literal-protection regex. No segmenting of the prompt; no regex literal-protection (the POC's regex protection stays dropped).

**Deterministic vs. fallback framing:** deterministic is **not** "just a fallback." It is one of two stages designed to typically run. It also happens to be the first thing you reach for when recovering a not-ready form (see cascade below).

**No "degraded" state, no extra field.** All recovery outcomes land plain `ready`. We are not adding a state or field to mark "this came out deterministic-only" or "this was floored."

**Why no degraded field:** in practice there's no real process that goes back to find and upgrade degraded forms, and it doesn't happen often enough to justify building one. It would be noise.

---

## `turn_rendering` (turn construction) — deterministic assembly + the recovery cascade

**Membership of a constructed turn (smooth turn):**
- user prompt (first), then the other message kinds
- thinking traces — kept as-is
- tool calls — grouped
- model responses — sequenced, kept as-is
- runtime switches (model-type switch, thinking switch) — if captured, included

**Smooth turn = same membership as the full-fidelity turn.** The only difference: in the full band some tool results are **truncated**; in the smooth band they are **summarized**.

**The recovery cascade (the new behavior — what happens when a needed derived form isn't ready at turn-construction time):**

The async message projection was *supposed* to produce these forms already. If you reach turn construction and they're not done, you **attempt to recover, maximizing the chance of getting them right** — you don't just settle for the floor. Each derived component resolves the same way — try for the real thing, fall through to floors, never block, continue, no degraded state, log on fallback.

**Decision on retry (resolves earlier back-and-forth):** at turn-close, **retry the inference** — do your best to get them all correctly. Lee decided to retry (not skip-to-deterministic) specifically to maximize recovery from failed/incomplete async projections.

- **User prompt** — if the smoothing form isn't ready (pending or failed — treated the same):
  1. attempt the full thing (**deterministic + inference**) → if inference passes, store the full (correct) result
  2. if inference fails → store the **deterministic** result (you should generally always at least be able to do the deterministic pieces)
  3. if deterministic fails → **copy over the original** text as-is
  - In all outcomes something usable ends up in the field; state set to `ready`.
- **Tool result** — if the summary is ready, use it. If not, attempt to regenerate; failing that, fall to **deterministic truncation**. **NEVER copy the full tool result.** There is never a reason you can't truncate a string before writing the result-summary field — so the floor for a tool result is always at least truncation, never the raw full result.
- **Thinking / model responses / runtime switches** — kept verbatim; no derivation, so no failure surface.

**pending and failed are handled the same** at construction: assume the derived field is unusable (ignore whatever is there), attempt to regenerate, fall through the floors, end at `ready`.

**Same principle across components.** Lee: "we're keeping the same principle that we're doing with the user prompt." Try for the real thing; else deterministic floor; else original (except tool result never goes below truncation); continue; don't block; no degraded state. On any fallback, log it (see logging section).

---

## Chunk creation & the chunk-level cascade

**The three-level cascade chain (confirmed — matches the built code):**
- **message_end** → async message derivations (prompt smoothing, tool-result summary)
- **turn close** → async `turn_rendering` + `lower_band_projection`; then placement; **if a chunk closes** →
- **chunk close** → async `chunk_summary_detailed` + `chunk_summary_brief`

Each level cascades the next when its unit closes; same floor-or-recover principle at each altitude. Self-similar flattening: message derivations → flattened into turn renderings → flattened into chunk summaries → flattened into one band message at the wire boundary.

**Chunk placement is inline; chunk summarization is a separate queued unit (CONFIRMED, matches Lee's reasoning):**
- **Placement** ("does this turn extend the open chunk or close it") is pure arithmetic over stored token counts (accumulated + incoming vs. target/max) — no inference, no clock. It rides the turn-derivation completion transaction. Owner: the turn-derivation completion step.
- **Summarization** is enqueued as **two separate persistent-queue work items** at chunk close (detailed, brief), committed in that same transaction. The worker finishes the turn, commits (placement + enqueue atomically), then picks up the chunk-summary items on its next drain.
- **Why separate items, not inline:** durability/checkpoint. A crash leaves either a placed turn (with summary enqueues) or nothing; on restart, drain recovers the queued summaries. This is the checkpoint boundary Lee wanted.
- **Single-threaded consequence (accepted):** single-flight per thread means detailed and brief run **sequentially**, not in parallel, not in one call. The cost of independent retry/state.

**Chunk summaries take `lower_band_projection` as input, NOT `turn_rendering`.** The thing chunks summarize is the coarser per-turn projection, not the rich smooth-band turn (which keeps all thinking/tools). This is why turn derivation produces two derivations: `turn_rendering` (rich → smooth band) and `lower_band_projection` (stripped → chunk-summary input). Lee's recollection ("constructed slightly differently") is correct and already built this way.

**State on chunk summaries:** detailed and brief are independent derivations with independent state. Detailed can be ready while brief is pending. There is no combined/conflated chunk-level state. At assembly each band reads its own derivation's state.

**Smart-compact chunk-summary cascade (DECIDED — same principle as turns, applied where the rubber hits the road):**
- At compact, query the derivations you need (e.g. the brief chunks) that aren't ready.
- **Attempt to make them ready — regenerate inline** (this is the moment it matters most; compact is allowed to take the time). Warnings stream to the buffer (visible, not saved to history) so the user sees the cleanup deriving that's delaying the compact.
- If regeneration still fails → **deterministically concatenate the member content as-is, uncompressed, drop it in, log the warning.** More detail, not less. It falls off eventually anyway.
- The user sees it happening and **can stop it** if they need to keep moving — never crippling.
- Net: always a working fallback; failure means more detail in that band, not a hole.

**Compact readiness behavior (CONFIRMED, matches the classified-degrade principle):**
- Compact does **NOT** require everything ready. It proceeds with ready derivations and floors the rest (regenerate → deterministic concat).
- The only thing that **blocks** compact is **source corruption** (damaged record), not missing derivations.
- So: missing derivation → compact proceeds with fallback; damaged record → compact refuses. Same source-damage-blocks / derived-absence-degrades split as everywhere else.

**Open (the chunk-level floor — needs carving):**
- The current rebuild's chunk-summary floor when a member projection isn't ready is "drop the member, record a gap" — i.e. falls back to **nothing**. That's weaker than the turn floor (retry → deterministic → original). Our smart-compact decision above (regenerate, else deterministic concat) supersedes "drop to nothing," but the **non-compact** path (a chunk summary deriving in the background, member projection not ready) hasn't been explicitly carved — does it also regenerate/floor, or wait/gap? And what if the input `lower_band_projection` itself isn't ready. Open.

---

## Cross-cutting: the logging surface

This grew from "log the fallback" into a real cross-cutting logging surface. Decisions:

**It's a general logging surface, not just derivation-fallback logging.**
- Levels: general **info**, **warning**, and **error** logs.
- Lives in a **cross-cutting technical domain** (the same one that executes the async derivations). Logging methods live there.
- **Exposed externally from LHC to the extension.** Both PI (the extension) and LHC call the *same* surface. As of now this is the only thing the cross-cutting technical domain exposes externally from LHC — just the log/error write methods.
- Anything in PI and anything in LHC can call it through that surface.

**Storage: in the SQL database.**
- Put the logs in the SQLite DB (info / warning / error).
- Possibly pipe standard IO into it as well.
- Rationale: once they're in the DB we can slice and dice them — web-based log viewers, flywheel tooling, troubleshooting.

**Two-channel principle stays:**
- **Record** = what's usable (always resolves to something, stays clean, no degraded state).
- **Log** = what went wrong (diagnostic, not control flow, not in the agent's face).
- A fallback **does not change any record state.**

**User-visible error surfacing (the buffer, carefully):**
- Errors go to the log. *Some* errors should *also* be written to the buffer in a way the user can see — so the user can tell something happened (some derivation didn't happen) without it dominating the screen. Enough of them = a signal to look into it.
- Constraints on the buffer surfacing:
  - Keep it from being too long. Possibly a collapsed form with a control-o expand, the way PI represents long tool calls ("N lines hidden, ctrl-o to expand") — **if** PI extensions can do that.
  - It must **NOT** show up as an intake event / in the thread history. It's buffer-only: visible now, gone on reload. If you reload the session you won't see it. (Lee has seen PI show buffer things that never enter history — that's the behavior we want.)
  - PI by default may overflow errors into the console and/or status bar; we don't want that uncontrolled.

**Open mechanics to work out (named, not decided):**
- How PI pipes in / represents error messages, and whether PI extensions can do the collapsed/ctrl-o buffer treatment.
- Whether some logs arrive as **log-type intake events from PI** (a possible new intake-event kind, log events generated by PI) vs. purely the direct logging-surface call. Lee's lean is the direct logging surface (its own domain/surface, not routed through intake events), but is open to being convinced routing through intake events is worthwhile if there's a reason.

---

## Parity gaps found (findings — fixes NOT yet decided)

Lee asked for a POC-vs-rebuild check. These are findings to shore up later; how to fix is open.

1. **Runtime switches flattened.** POC had typed `model_change` / `thinking_level_change` entries (structured, with a `thinkingLevel` field). The rebuild collapses all non-message runtime changes into one generic `runtime_note { text }` — the type structure is flattened into a string. Lee wants model-switch and thinking-switch represented in the turn; the structured form is also what the runtime-state restoration inventory would want. (Fix approach not decided.)
2. **Deterministic floor missing in the rebuild.** The current `smoothPromptHandler` sends raw text straight to the provider — there is no deterministic stage. The deterministic stage we're designing has POC precedent (the POC smoothing service) but is not in the rebuilt code. (Build approach not decided.)
3. **Fallback currently records a record-side gap, not a diagnostic log.** The rebuild's compose records a `DependencyGap` (record side) when it floors, with no diagnostic log. Our decision is the opposite channel (log it, keep the record clean). (Reconciliation not yet specced.)
4. **Naming: `form` / `derived_form` / `FormKind` / `DerivedFormState` in code vs. our vocabulary.** The code uses "form" across the stored thing, its type, and its state. Our vocabulary (above) renames these: derivation / derivation type / state. The code rename rides the SDK rework — flagged here so it lands then, not piecemeal.

---

## Related / future work Lee named (his words — not scoped here)

- **Tool-harness dial-in precedes the tool_result_summary corpus.** There will be a pass dialing in the tool harness and customizing specific tools to the shape they're RL'd in — core tool calls shaped toward Claude Code for Claude, toward Codex for GPT (PI is already Codex-like), other models leaning one way or the other. This **changes tool output shapes**, so the summary corpus must be captured after it or it churns.
- **Permissive tool-call repair layer.** A layer of deterministic code + fast-model fallback that takes a schema failure, determines intent, attempts to fix the call to intent, and also gives the model guidance on how to use that tool better in the session.

---

## Important things to consider for subsequent passes on context management

NOT first-pass scope. Captured so we don't lose it. These are refinements/optimizations to revisit after the first pass is up, running, and stable.

### Wire-API representation of bands (how it currently flattens)
- At the wire boundary, **one band → one message.** The whole smooth band (and likewise detailed, brief) collapses into a single `user`-role message with a `[context · <band>]` header + concatenated content. The tail renders each message to its own wire message with its natural role.
- So a band entry is a **synthetic message**: role `user`, content is many turns/chunks/message-types flattened together. It maps to no single real message type. This is expected/correct for now (`user` is what the injection uses).
- **Caching is fine with this** (confirmed): the bottom three bands are a stable prefix between compacts; only the full band grows at the end; the only prefix churn is the visibility-boundary truncation, already optimized. Flattening doesn't hurt cache; if anything one big band message has fewer block boundaries to invalidate than many separate messages.

### Candidate refinement: smooth band as user/assistant pairs (dial-in)
- Lee is OK with detailed and brief bands as-is. The **smooth band** is the one worth possibly reshaping.
- Idea: instead of one `user` blob, represent each smooth turn as the **user prompt = user message**, and **everything else (assistant text, thinking, tool activity) = assistant message**.
- Upsides: (1) the model's own past work is voiced as **assistant** rather than narrated back to it as `user` (fixes an attribution smear); (2) partially fixes consecutive-`user`-message alternation (smooth band becomes alternating pairs, not one more `user` blob).
- Cost: smooth band is no longer "one message" — 2 messages per smooth turn. Cache-neutral (still a stable prefix between compacts).
- Note on thinking: it's often summarized thinking anyway, and many models don't surface real thinking — so exact fidelity of represented thinking is already lossy.

### Known cost: Claude post-compact thinking re-output (future optimization)
- **Observation (Lee, empirical):** on Claude models, the first turn after a smart compact produces a large output-token spike (tens of thousands of tokens — ~20-50k seen), scaling with thinking effort. Visible as a marked jump in rate-limit consumption. Happens on every smart compact.
- **Two distinct costs, often conflated:**
  - **Cache-write (input side, ~1.25x):** the new compacted prefix is cold → reprocessed/rewritten. Lever: keep prefix **bytes** identical across the compact so it cache-hits. (Anthropic cache is keyed on content prefix, not session id — so the lever is prefix-byte stability, not referencing the old session.)
  - **Thinking re-output (output side — the expensive one Lee is watching):** the first post-compact response has to re-establish reasoning over freshly reorganized context in one pass, because compaction broke reasoning continuity. Lever: **change less per compact** so there's less new to reason about.
- **The convergent lever:** batch/stagger deep-band changes so they don't reshuffle every compact, preserve maximal prefix. This hits *both* costs at once (prefix stability → cache-write win; less content change → less re-reasoning). Lee believes we are NOT currently preserving maximal prefix, and that we pay a heavy output-token cost on Claude for thinking re-hydration.
- **Honest open question (measure, don't theorize):** how much the thinking re-output actually drops from prefix preservation is uncertain — the model thinks in response to content change, and compaction inherently changes content. Lee has the rate-limit data to measure whether a minimal-change compact reduces the spike. This is a measurement, not a design-from-theory item.

### Other wire-boundary considerations (named, lower priority)
- **Consecutive same-role (`user`) messages.** Bands + tail can yield several consecutive `user` messages with no `assistant` between. Some providers are strict about alternation (Anthropic historically cares). **Worth a cheap pre-serving check against the real provider lanes** — this is the one with potential teeth at serving time. (The smooth-band user/assistant split above partially mitigates.)
- **Band header is load-bearing and thin.** `[context · smooth]` is the only signal to the model that a block is compressed history vs. live conversation. Whole "this is memory, not now" contract rides on that header string — a prompt-surface to tune.
- **/tree opacity.** In the POC, synthetic band messages show up in PI's `/tree` as `custom` entries that can't be classified — no truncated summary, so when rolling back through the tree you can't tell what a band entry was. Fix later (post first-pass, post-stable): construct the synthetic message so `/tree` has a useful, classifiable entry (possibly just setting a couple more fields). Defer.
- **Materialize / session-file round-trip** shares the same synthetic-message render path, so the `/tree` fix likely wants to cover the materialized session file too (same opacity, second consumer).

---

## Open / not yet decided (proposed but NOT confirmed — do not treat as decisions)

- Exact **log entry schema/fields** (what each log/error entry carries). Not yet specced.
- **Buffer-surfacing mechanics** — whether PI extensions can do collapsed/ctrl-o buffer output, how PI represents errors, and whether any logs come in as log-type intake events vs. the direct logging surface. (Lee leans direct surface.)
- Whether **turn-summarization-at-close is a parity divergence** — the rebuild runs `composeTurnRendering` / `projectLowerBand` as provider operations at turn-close; unconfirmed whether the POC did turn summarization at close or only assembled deterministically. Still open.
- **Truncation rule** (current = head-truncation). Head+tail was floated; not adopted. Lee not worried about truncation; treat current behavior as standing unless revisited.
- **The non-compact chunk-level floor** — carved for the compact path (regenerate → deterministic concat); the background-derive path (member projection not ready, or `lower_band_projection` input not ready) not yet explicitly carved.
- **`lower_band_projection` as a standalone kind** — touched as turn-derivation's second output and chunk-summary input; not walked on its own.
- Where all of this lands in spec terms (which epic / rework pack) — not decided.

### For Fable to verify (already decided in Epic 3 work — recall, not re-decide)
- **Snapshot vs. live band assembly at compact.** Does compact store rendered band text (snapshot, re-served identically between compacts) or assemble live each pull? This was settled in the Epic 3 (thread-views/smart-compact) SDK work; grep didn't confirm which from the compact module, so verify against the spec/code before building on it. Affects how band delivery + readiness-timing works.
