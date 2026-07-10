# Backlog

Fixes, tighten-ups, and feature work on the road to v1.




## Architecture

### 35. SDK hygiene slice from the July code review

**Problem:** A code-review pass over the SDK core found the version-fenced work-completion logic — the most correctness-critical code in the system — existing in two copies: one live, one dead with zero call sites, and the copies have already drifted. Three smaller findings ride along: the write-transaction helper leaves error-wrapping to caller convention instead of guaranteeing it; compact stamps its snapshot timestamp from the wall clock instead of the injectable clock seam prune uses; and compact's isolation from concurrent intake is logical rather than lock-level, which deserves a comment so future readers don't assume SQLite serializes it.

**Solution:** One small slice: delete the dead completion/failure duplicate from the work queue; centralize error wrapping inside the transaction helper so infra failures always surface through the result contract; thread the clock seam into compact; add the isolation comment.

**Status:** Not started. All four verified against code 2026-07-10; the dead copy is the only correctness hazard, the rest are riders.


### 34. Thread manager + viewer

**Problem:** Finding and selecting a thread to resume currently requires manual registry spelunking — there is no unified interface for browsing threads and their views.

**Solution:** A thread manager and viewer interface, legible to both agents and humans, accessible from any host (the PI extension, the Claude Code wrapper, the Codex wrapper, and future hosts) for selecting threads or thread views to resume.

**Status:** Not started. Scoped as a small feature epic. Origin: Lee, 2026-07-10.


### 17. SDK-owned native inference (default), host callbacks demoted

**Problem:** Every mystery during the derivation-tuning rounds lived below the host's inference callback boundary — invisible system-prompt drops, instruction wrapping by host harnesses. The callback interface is the load-bearing inference path, but it's opaque: what actually reaches the model is unknowable from the SDK side.

**Solution:** The SDK ships its own direct HTTP inference client (targeting the standard chat-completions API shape) as the default derivation lane — wire-observable, with explicit reasoning-effort control and wire-truth logging. Host inference callbacks stay as a substitution point for constrained environments (e.g., enterprise seats where the host's CLI is the only model access), not the primary path. One serving path across all hosts means prompts tune once. The wrapper hosts (Claude Code, Codex) have no host model registry to bridge anyway.

**Status:** Not started. The SDK currently uses inference callbacks exclusively, through a four-operation boundary (smoothing, tool-result summarization, turn compression, chunk brief).

### 18. PI-extension rework: named compact profiles + tech-debt cleanup + inference re-plumb

**Problem:** The PI extension has accumulated more tech debt than the SDK. Three things need a single-pass rework: (a) the extension hardcodes a single compact profile instead of selecting from the SDK's named profiles; (b) general connector code needs cleanup (handler shape, serving, lifecycle); (c) the inference bridge routes through the PI model registry, which introduces host-specific quirks into the derivation path.

**Solution:** One pass: (a) wire the extension to select from the SDK's built-in named compact profiles (continuation, conversation, coding) — the SDK side is already built with validation and user-profile merging; what remains is the connector side, which still selects a hardcoded profile with fixed constants; (b) clean up the connector code; (c) re-plumb inference to use the SDK's native lane (item 17) instead of the PI model registry — the registry goes back to serving only the agent.

**Status:** (a) is half done — the SDK side is built, but the extension still passes the hardcoded profile. (b) and (c) are not started.

### 21. Inference provider/model-selection layer (scoped deliberately)

**Problem:** The provider layer for item 17's native inference. Provider/model selection always looks easy and becomes a headache as permutations fan out — this is one of the genuinely hard parts of this space: not cognitive intricacy, but finding the right balance of inference options offered flexibly yet constrained.

**Solution:** Chat-completions API only — single-turn, no streaming, no tools. Providers: OpenRouter, Cerebras, a Claude Code CLI subprocess fallback, a ChatGPT OAuth path, and possibly a GLM API. Within a provider: a curated model subset and a set of common thinking-level options — selectable enums mapped to each provider's model string and settings, handling provider quirks. The PI agent's existing provider implementations are starting points.

**Status:** Not started. Sequencing: OpenRouter alone until basics are dialed. Hard dependency: a high-speed inexpensive provider (Cerebras) must be in place before any derivation that fires on a large percentage of message events (item 11's bar: provably drains at intake speed).



### 24. Post-brief horizon compression (level-2 chunks)

**Problem:** Content starts falling out of the brief band after roughly 1–2 weeks of real usage — beyond that horizon, turns have no representation at all.

**Solution:** A compression tier past brief: compact chunks into something coarser (chunks of chunks), so the oldest end degrades to a very cheap outcome-level narration instead of dropping out entirely. Extends the band gradient's degrade-over-drop principle to the whole thread lifetime.

**Status:** Not started. No level-2 chunk concept exists in the SDK.

### 11. Tool-call/result derivation refinement (truncation holds the line)

**Problem:** Tool calls and results are truncated to 500 characters as an interim measure. The inference-backed summarization path is fully built and wired — a content classifier routes tool results by operation class, response shape, and prompt mode — but it was forced off because inference clogged the work queue when it fired on every tool result at intake rate.

**Solution:** Three stages: (1) study a headless open-source project's deterministic tool-output processing to get more done without inference, reserving model calls for key leverage points; (2) re-enable and validate the classifier-routed inference path (the classifier exists and is wired in, just bypassed by a force-fallback flag — this is re-enable-and-validate, not rebuild); (3) evaluate inference for tool activity only if both quality and speed prove out. The bar: provably drains at intake speed. The Cerebras exploration (item 19) doubles as the feasibility probe.

**Status:** 500-character truncation is the production behavior. The classifier, inference plumbing, and prompt template are all built and wired — switching off the force-fallback flag would re-enable them. Blocked on a high-speed inference lane that can keep up with intake-rate bursts.


### 27. Thread clone + fork via file copy, with byte-exact reload fidelity

**Problem:** Forking a thread is expensive because the current path replays events rather than copying the underlying file. A 300k-token thread costs proportionally more to fork than a 3k one, and replay doesn't carry derivations — the fork re-derives the entire cascade.

**Solution:** Since each thread is a single file, clone is a file copy: copy the file, stamp a new thread id in the copy's metadata, insert a registry row. The clone carries all derivations (no re-inference), and cost is constant regardless of thread size. Fork-from-earlier-point is the harder variant: truncate everything past the fork point plus all downstream material as an SDK operation. The PI extension follows with a clone command riding the SDK operation.

Clone-as-subagent: run a cloned thread as a subagent, seeded from the clone's view, getting the warm prompt-cache benefit of sharing the source thread's entire served prefix. Hard dependency: byte-exact reload fidelity must be locked first — the cache benefit only exists if the clone's served context is byte-identical to the source's live prefix.

Reload fidelity: the served context after a reload/rehydrate/fork-seed must be byte-identical to what the live in-memory session was serving. Suspicion on record: subtle differences on reload (whitespace, ordering, re-rendering drift) silently break provider prompt-cache prefixes, turning a warm cache into a full-price re-read. Verification: capture the live session's rendered context, reload/clone, capture again, diff to the character — any divergence is a defect. The PI extension has an existing replay verification seam closest to this.

**Status:** Not started as an SDK operation. The PI extension has an existing replay-based fork path (separate from this design) and an existing replay verification module.

### 26. Host-environment cleanup: config directory + key-file consolidation

**Problem:** Two housekeeping debts from wiring the PI extensions: (a) the PI extension doesn't have its own config directory — it rides the global PI and LHC directories; (b) API keys are split across two locations — the PI agent's auth file (provider keys plus a search API key) and the LHC environment file (OpenRouter/Cerebras keys for derivation lanes).

**Solution:** (a) The PI extension gets its own config directory holding its config and thread files. (b) API keys consolidate to one location.

**Status:** Not started. Neither blocks anything now. Natural companion to item 18's rework.
