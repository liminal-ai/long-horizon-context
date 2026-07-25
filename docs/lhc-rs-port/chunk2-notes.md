# Chunk 2 notes — rulings of record and the serving-hook finding

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** (Position corrected by Lee:
Phase 3 of **4**, unit 17 of **~22**. Earlier framing in this directory said
"Phase 3 of 3 / unit ~17 of 18"; that understated what remains.)

## Ruling 1 — write-back (APPROVED)

Source: Fable phase-reviewer ruling, Lee concurring, relayed by Lee
2026-07-25. Orchestrator analysis and recommendation endorsed as-is.

**LHC's compacted body is written back into native host state through the
host's existing `replace_conversation_for_compaction` path.** Native state
becomes the LHC-compacted state; the host's token accounting self-corrects;
the fail-open fallback becomes safe again because falling back to native now
means falling back to the LHC body.

**Rationale of record — this is not a workaround, it is the proven LHC-host
architecture.** In `pi-lhc` and `t3code`, the host's conversation state after a
compact swap *is* the rebuilt LHC state. Serving-without-write-back was the
architectural deviation; the Chunk 2 escalation surfaced its bill. The
two-truths failure mode — LHC's view budget versus the host's request
accounting — is the same disease the Hermes integration hit.

> **Standing principle:** treat any future design where host and LHC hold
> divergent conversation state as **suspect by default**.

Hard gate before merge: an independent verifier must confirm the capture-tee
loop is idempotent (prune-shaped replaces emit nothing; a genuine compact
summary records exactly once; repeated write-backs of an unchanged body record
nothing; crash mid-write-back does not double-record on retry). This is a
canonical-record integrity question and takes the **full dual-verify
treatment**, not a spot check. If the loop is not clean: stop and surface — do
not patch the tee shape unilaterally, that is capture semantics.

`prompt_index` must be preserved through write-back explicitly, and the
vacuous `prompt_index` test fixed as part of that work.

## Ruling 2 — `/btw` and memory flush (DEFER)

Not hooked. They read native state, which after write-back holds the LHC body.

**Known full-conversation consumers that ride native state** — recorded here so
they are not rediscovered:

| Consumer | File | Behavior |
|---|---|---|
| `/btw` side questions | `xai-grok-shell/src/session/acp_session_impl/recap.rs:9,36,108` | builds an independent `ConversationRequest` from the parent session's full native conversation |
| Memory flush | `.../memory_dream.rs:383,441` | reads native history and submits it |

**Chunk 3 live certification must explicitly check `/btw` and memory flush on a
compacted session** — confirming they receive the LHC body and behave
coherently. If either misbehaves, it reopens as its own decision.

---

## Design finding — the serving hook (hook 4) is redundant under write-back, and net-negative

Reported per Lee's instruction to explore and report, not decide. **Removing a
hook changes the enumerated touchpoint set, so this is a stop line.**

### What LHC's serving view actually is

`get_llm_request_context` → `assemble_view`
(`vendor/.../thread_view/internal/assemble.rs:24-52`):

```
view = [bands from the view SNAPSHOT (created at compact time)]
     + [tail messages after compact_point, rendered live]
```

Two facts follow, both verified in the port:

1. **The compressed part only changes at compact time.** Bands come from
   `read_view_snapshot`, written when a compact runs. Between compactions the
   banded prefix is frozen.
2. **The tail is full fidelity but structurally flattened.**
   `render.rs:264-265` says so outright ("the tail is full fidelity"). The one
   continuous transform is `deterministic_truncation` applied to tool results
   older than `boundary_position` (`render.rs:235`).

### Why the hook is redundant

Under write-back, the **compression benefit reaches the model through native
state** — that is where essentially all of LHC's value in this seam lives, and
it lands at compact time by construction. Between compactions, per-turn
substitution adds exactly one thing native lacks: truncation of tail tool
results older than the boundary. The host already has its own mechanism for
that (the in-memory tool-result hard-clear prune, `mutations.rs:305`).

### Why it is worse than redundant

`LlmRequestContext` carries only `User`/`Assistant` roles with text parts
(`vendor/.../shared_tech/view.rs:173-200`) — **no tool-call representation**.
The adapter's translation is therefore forced into
`ConversationItem::user(text)` / `assistant(text)`
(`grok-lhc-host/src/serving.rs:80-81`).

So every substituted request **replaces the entire structured tool-use history
with prose**, on the live request path, on every turn. The provider's
tool-calling protocol — assistant items carrying real `ToolCall` structures
with ids, matched to tool results — becomes narrative text. That is a
protocol-level fidelity downgrade applied to the request the user is waiting
on, and it is the most plausible cause of subtle tool-use misbehavior in a long
session.

Hook 4 also carries, alone among the hooks: a 2s timeout on the request path
(E4), the `prompt_index` reconstruction burden (E5), and the fail-open
divergence surface that produced the original two-truths escalation.

### Recommendation

**Remove hook 4 from Chunk 2; keep write-back (hook 5).** Touchpoints go
6 → 5. This eliminates the two-truths failure mode entirely rather than
managing it, removes request-path latency and the timeout, and makes
`prompt_index` preservation trivial because native items are never rebuilt
from flattened text.

Restated under the simplified shape, per Lee's request:

- **Fail-open story:** there is no serving substitution to fail, so no
  fail-open path on the request path at all. The only LHC failure mode left is
  "compaction didn't happen", which degrades to native compaction — the
  existing, certified behavior. This is strictly simpler than fail-open
  between two divergent bodies.
- **`/btw` story:** unchanged and improved. `/btw` and memory flush read native
  state, which holds the LHC-compacted body. Under the current shape they read
  native while main turns read LHC — the divergence Ruling 2 defers. Removing
  hook 4 makes that divergence **structurally impossible** rather than
  deferred: there is exactly one conversation body, and every consumer reads
  it.

### Honest counter-arguments

- **Losing tail truncation.** Between compactions, LHC would have truncated
  older tail tool results and native will not. Mitigation: the host's own
  hard-clear prune exists; and Chunk 3 live cert measures whether
  native+write-back hits context targets.
- **Product intent.** If the intended product is a continuously-served banded
  view rather than compaction-time swaps, removing serving undercuts it. But
  the port's own structure argues otherwise — bands are snapshot-derived and
  static between compactions, so serving them per turn adds nothing.
- **Reintroduction is cheap.** If Chunk 3 shows native+write-back misses
  context targets, serving can return — and should then translate into
  **structured** `ConversationItem`s (preserving tool calls), not flattened
  prose. That is a better hook than the one we would be removing.

### DECIDED — remove by evidence, not by argument

Ruling (Fable phase-reviewer, relayed by Lee 2026-07-25). The recommendation is
accepted **in substance**, but the removal is gated on measurement rather than
on the argument above:

- **Hook 4 stays through Chunk 2 certification, demoted to
  "instrumented-redundant."** Add an equivalence assertion: the served view and
  the natively-built request body must be **identical between compacts**, at
  byte level after the same normalization the cert diffs use. Any divergence is
  logged **with the triggering state**.
- Chunk 2 cert **and** Chunk 3 live sessions run with that instrumentation
  armed.
- **Zero divergence through live cert → hook 4 comes out at Chunk 3**, as a
  touchpoint-set change: sentinels, FORK.md inventory, and patch series updated
  **in the same commit**. The fail-open story dies with it.
- **Any divergence →** each instance is either a bug to fix or the documented
  reason the hook stays. **Bring the first one to Lee.**

**Scope note of record:** prune/mutation serving is **out of Phase 3 scope**. If
a later phase adds it, mutations route through the **same native replacement
path** — the write-back law — and **not** through a revived serving
substitution.

### Ruling 4 — the structural test limitation does not rest as "accepted"

The gate tests drive the adapter path (`handle.replace_history(&body)`), not
the real shell write-back, which the adapter suite structurally cannot reach.
The flag is endorsed, and explicitly **must not** become a permanent accepted
limitation.

Requirement: **capture the real body the shell write-back delivers** — item
shapes, ordering, system prefix, `prompt_index` markers — from an **actual
compaction run**. A live harness in Chunk 2 if feasible; otherwise a
**mandatory Chunk 3 live-cert checkpoint**. Diff it against the
adapter-simulated body the four gate tests use. **If they differ, regenerate
the test fixtures from the real body and rerun the gate.**

**Chunk 1's accepted limitation #1** (the hook-2/hook-3 session-id coupling,
verifiable only by inspection) gets the **same treatment at the same
checkpoint**: scheduled verification, not a permanent blind spot.

### Superseded — original decision request

Remove hook 4 in Chunk 2, or keep it. I recommend removing it. Either way
write-back proceeds — it is approved and independent, and is already being
implemented without entangling the substitution path.
