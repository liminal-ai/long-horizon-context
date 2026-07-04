# Decisions brief

The high-leverage rulings that shape how to approach this system. The full authority is
`decision-registry.md` (197 entries, evidence-cited, statuses, graveyards) — this is the
orientation cut. Entry IDs point there. If this brief and the registry disagree, the
registry wins; if code and the registry disagree, that's a finding, not a license.

## The record (RECORD)

- **The append-only event stream is the source of truth; everything else is rebuildable** — messages, turns, chunks, derivations, views are all derived. Edits/deletes change what readers see; originals are never destroyed (soft delete, unfiltered audit reads exist). [RECORD-1, 18]
- **One SQLite file per thread; the file is the thread.** The registry maps ids to paths as a lookup convenience, never as authority. Thread ids are random (`th_` + hex); everything inside a file gets deterministic positional ids (`t<n>`, `m<n>`, `c<n>`). [RECORD-2, 4]
- **Intake is the only harness content-entry path**, with a closed vocabulary of nine event kinds, closed schemas (unknown fields rejected structurally), all-or-nothing batches, and thread-scoped idempotency where key wins over content. The harness owns stream coherence; LHC never reconstructs a malformed stream. [RECORD-7, 8, 9, 10, 25]
- **Turn boundaries are decided synchronously at intake** (one prompt plus everything that follows; user_prompt closes the previous turn), never inferred later. Exactly one open turn always — violation is corruption to triage, not repair. Closed turns are structurally immutable: no writer exists. [RECORD-11, 12, 13, 21]
- **Reads surface stored state — never repair, derive, or block.** Token estimates are stamped at message creation from the local tokenizer (no provider calls). Projection copies payloads verbatim; compression is decided later, never at intake. [RECORD-22, 16, 15]
- **DB handles open fresh per operation** (no pools/caches); reads are touch-suppressed so a pure read never triggers background work. [RECORD-28]

## Derivations (DERIV)

- **Derivations are durable stored rows, computed once, never recomputed on read.** Seven types: four inference-backed (smoothed_prompt, tool_result_summary, detailed_turn_compression, chunk_summary_brief), three deterministic (turn_rendering, pre_detailed_assembly, chunk_summary_detailed). Deterministic work never crosses the inference boundary. [DERIV-1, 2]
- **Four states: pending / ready / failed / blocked.** `blocked` means source damage — retry can't help; triage it. Retry progress is queue business, not a derivation state. State belongs to derivations, never subjects ("the derivation failed", never "the chunk failed"). [DERIV-3, 4; VOCAB-4]
- **Source-version fencing:** every edit/delete bumps the source version; late-finishing stale work is discarded at completion, never overwrites. The mutation cascade is a structural walk (message → turn → chunk, plus tool-pair counterparts), not a hardcoded list. [DERIV-5, 6, 7]
- **Fallbacks are floors, never omissions** — a failed compression lands the assembly text ready-with-floor; tiny turns skip inference; a suspicious smoothing shrink is discarded for the deterministic floor. Views never starve, and nothing degrades silently. [DERIV-19, 10, 11, 18]
- **Compression input is dialog-only.** pre_detailed_assembly strips tool activity, thinking, notes. Below the smooth band, tool activity survives only as the assistant's own narrated account — no tool traces, no outcome receipt lines (shipped unratified once, removed; see graveyard). Tool outcomes are mechanically stamped from the record, never model-authored. [DERIV-16, 30, 13]
- **Interim:** tool_result_summaries are forced to 500-char truncation (inference clogged the queue at intake rate); the classifier-routed inference path is dormant pending a high-speed lane (items 11/22). [DERIV-12, 28]

## Chunks (CHUNK)

- **Chunks group whole consecutive closed turns — a turn never splits.** Close is pure arithmetic over projected tokens (target 2200 / max 4400, tunable): deterministic, replayable, no clock, no inference. Membership is immutable once placed; deletes shrink chunks in place, never re-cut. [CHUNK-1, 2, 5]
- **Placement rides the turn-derivation completion transaction** (the projected count doesn't exist earlier). Projected (pre-compression) tokens drive placement; landed (post-compression) tokens drive band sizing. [CHUNK-6, 7]

## Views and serving (VIEW)

- **Four bands as a fidelity gradient, not a cliff:** full (live tail) → smooth (turn renderings) → detailed (chunk summaries) → brief (outcomes only). Aging turns move down a band instead of dropping out. The smooth band deliberately serves the full-texture turn_rendering, not the compression (explicit ruling). [VIEW-4, 14]
- **Compact never calls a model — assembly, not summarization.** It selects already-derived artifacts; missing material degrades down visible ladders or gaps, never derives inline. Canonical-record damage *refuses* compact (prior view intact); derived-material damage *degrades*. Gap means nothing usable exists; degraded means real fallback content shown with a marker. [VIEW-2, 7, 13; VOCAB-11]
- **Compact is explicit, never automatic** — status recommends, the host decides. And an explicit compact executes, period: no "nothing new" second-guessing gates (removed twice; see PILHC-14). [VIEW-3]
- **A view is a stored snapshot replaced atomically by the next compact**; serving = snapshot + live tail, cheap deterministic reads, one serving path (a never-compacted thread is just snapshot-absent). The full tier is never stored. Coverage invariant: every closed turn behind the compact point is represented or explicitly gapped — silent dropping was a real shipped bug. [VIEW-1, 15, 16, 9, 12]
- **The visibility boundary shortens only tool results, only at-or-behind it** (prompts/text/thinking always render full). Intake never advances it; compact resets it; manual prune moves it forward. Automatic advance was built once and retired. [VIEW-18]
- **The tail never begins mid-turn** — the compact point snaps forward to a turn boundary. Bands serve as labeled user-role messages (`[context · band]`) because inference APIs constrain roles. [VIEW-8, 19]

## Queue (QUEUE)

- **Work items are durable rows committing in the same transaction as their cause** — a restart loses nothing; there is no daemon. Queue mechanics are domain-blind; each kind has one owning domain. [QUEUE-1, 2]
- **One item at a time per thread, head-first, never skip-ahead** — thread order is the dependency mechanism. Claims are epoch-fenced leases (stale holders' writes miss); supersede deletes only queued items, the version fence handles claimed ones. A handler that must wait defers by delete-and-re-enqueue behind its prerequisite. Parallelism for independent message-level work is planned (item 22), not present. [QUEUE-3, 4, 9, 16, 19]
- **Drain shape: claim txn → handler with no open transaction → completion txn.** Never hold the write lock across inference. Bounded retries with exponential backoff; terminal failures land visibly with metadata copied. Unregistered kinds still drain out as failed_terminal rather than wedging the queue. [QUEUE-7, 8, 14]
- **Two host modes — background (scheduler-driven) and manual (inert).** Background fail-closes on an empty handler map; instance seams isolate multiple SDKs in one process. [QUEUE-10, 12, 13]

## Inference (INFER)

- **Model access arrives exactly one way** (callbacks XOR inference config — both/neither is a construction error), through a four-operation boundary; ModelCall is single-turn, no streaming, no tools; provider/model strings are host routing keys. [INFER-1, 2, 3]
- **Planned: LHC-owned native HTTP inference as the default lane** — every mystery of the tuning rounds lived below the callback boundary (the system-prompt drop shipped invisibly); direct calls are wire-observable. Callbacks demote to the substitution point for constrained hosts (e.g. claude -p at work). [INFER-12; items 17/21]
- **Prompt doctrine (v3):** one user message, no system message (nothing for a host lane to drop); minimal trust-the-model instructions — additions must trace to *measured* failures (+55 tokens of untargeted guardrails cost 20–30 ratio points); third-person past-tense narrative output (can't be satisfied by copying); no embedded examples, and never examples from this project's own content (they bled into production output). [INFER-14]
- **Stated targets ≠ acceptance windows, deliberately.** Templates state low targets to steer (GPT lands 1.5–2× above the ask); assignment ratios define what sizeDisposition measures. All these numbers are steering guidelines, never specs — out-of-range output is not a defect; quality is judged by reading. Per-model bias belongs in assignment config, not prompt text. [INFER-13, 15]
- **One adapter pipeline for every kind:** input bounding before render, host exceptions contained, whitespace-only output is a retryable failure never a ready derivation, provenance stamped from config only. Failure classification is a fixed retryability table. Prompts are name-keyed registry modules with golden-pinned renders. [INFER-7, 8, 6, 11]

## The PI connector (PILHC)

- **Observe-only hook rail holding plain data** — never retains PI ctx/session objects (PI replaces them); the SDK instance rebuilds per session. Capture failures isolate (session continues) but compact refuses over a capture hole. Malformed-but-writable capture records a durable runtime_note gap — nothing silently dropped. [PILHC-1, 2, 3]
- **Thread identity is the LHC thread id carried as a durable custom entry in the PI session** — reload reattaches from the record, never from module state or cwd guessing. Explicit launch flags fail loud; no flag creates a new thread. [PILHC-5, 6]
- **Serving is launcher-owned SessionManager hydration** (a real PI session, not the context hook), with a seed-entry map bridging LHC message ids to PI entry ids for compact splicing, and honest synthetic provenance on served entries. [PILHC-11, 12, 13]
- **The compact bridge is a fixed ladder that cancels loudly on real failure — never on second-guessing.** Floor gate (50k, measured on the real serving context) and genuine errors are the only cancels. [PILHC-14, 15]
- **Acknowledged tech-debt-heavy, pending a one-pass rework** (named compact settings + cleanup + inference re-plumb, items 18/7); the inference bridge through PI's registry is interim. [PILHC-23, 17]

## Per-model adaptation (MODEL)

- **Per-model optimization happens via config plus discrete extensions flipped by loaded model** — extensions contribute tools and system-prompt sections; profile key is model-tier, not model-name. The record stays model-neutral forever; the served rendering is a function of (thread, model-profile). First case: memory-protocol blocks (Claude models have RL'd memory reflexes and need a pointer; GPT/GLM need the full protocol). Deterministic composition, captured into the render. [MODEL-1]

## Vocabulary (VOCAB)

- **Thread** (LHC's container), never "session" (the host's). **thread-view**, never "projection" (strongest ban). **Derivation** is the stored noun. **Gap** = material absence; **degraded** = visible fallback. **render / materialize / LlmRequestContext** are the three exits. Bands are full/smooth/detailed/brief. Names must expose leaks, not soften them; no generic wrapper nouns; no branded umbrellas. Banned terms list in VOCAB-15. [VOCAB-1, 2, 3, 11, 12, 14, 15, 16]

## Process (PROC)

- **Expected failures return OpResult** (code + reason + errorClass: caller_error / state_corruption / system_error); throws are programmer bugs. Machine logic switches on code, never reason strings. [PROC-1]
- **Goldens encode ratified rules, not current behavior** — an implementation disagreeing with a golden is wrong until the design rule is shown wrong; no silent regeneration. [PROC-3]
- **Testing rulings:** no silent auth-based skips (explicit NOT-RAN accounting); no regression-tombstone tests ("fear artifacts"); no premature compatibility shims; tests drive real entry points and assert durable outcomes; injectable seams over scattered workarounds. [PROC-4, 7, 8, 9, 17]
- **Wire truth over reconstruction for risky changes** — what reaches the model is verified by capture, not template-level reasoning (reconstruction was proven able to lie). Prompt tuning happens in the lab against real specimens, promoted only when byte-matched. [PROC-13, 12]
- **Durable logs are the between-sessions memory:** bad-code-log (failure patterns), fixes-feature-log (numbered items → Done), the decision registry (current-state rulings). Comments state current invariants, not history. [PROC-16, 14]
