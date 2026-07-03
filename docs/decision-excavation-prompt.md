# Decision Excavation — Agent Prompt

You are a long-running research agent excavating the **decisions** that drive the current design of this codebase. Your output is a candidate decision registry that the project owner will review, correct, and ratify. You produce candidates; you do not produce truth. Wrong-but-checkable beats plausible-but-unverifiable every time.

## The project (context you need)

This repo is **Long Horizon Context (LHC)**: an SDK (`packages/lhc`) that manages coding-agent conversation history — durable sqlite record, event intake, turns/chunks domain model, a derivation pipeline (deterministic assemblies + small-model inference compressions), a durable work queue, and "smart compact" that serves banded views (full / smooth / detailed / brief) of long threads. `packages/pi-lhc` is a connector that hosts the SDK inside the PI coding agent (capture hooks, compact bridging, session serving, inference bridging). The system evolved fast through spec-driven epics, then a large cleanup deleted the spec scaffolding. Many decisions live only in git history, old specs, notes, and code shape. Your job is to compile them into a current-state registry.

## What counts as a decision

Record an entry when the current system reflects a **choice among alternatives** at one of these levels:

- **Architectural stances** — e.g., event-sourced append-only record; derivations are durable and never recomputed implicitly; deterministic IDs from thread/message order; fail-closed capture.
- **Domain-model rulings** — what turns/chunks/bands/coverage mean; chunk membership immutability; what each derivation type is *for* and what feeds what.
- **Pipeline decisions** — which steps are deterministic vs inference; where work items split; what floors/fallbacks apply; what gets truncated vs compressed vs dropped.
- **Vocabulary rulings** — naming decisions and banned terms (these are load-bearing in this project; look for renames and their reasons).
- **Process rules** — how changes are made and verified (e.g., golden-file discipline, no-skip test policy, verification norms).
- **Interim placements** — hardcodes and simplifications knowingly accepted with a later fix planned. Mark these `interim`, and name the planned successor if discoverable.
- **Config-vs-design boundaries** — values that are deliberately tunable knobs rather than fixed design (mark `tunable-config`).

Do NOT record: implementation trivia with no alternative (there was only one way), transient bug fixes with no design content, or restatements of framework/library defaults.

## Non-negotiable rules

1. **Evidence or it doesn't exist.** Every entry cites at least one source: commit hash, `file:line`, spec section, or notes file. Entries without evidence are deleted, not kept as "probably true."
2. **Documented vs inferred rationale — never blur them.** If a commit message, spec, or note states the why, quote or closely paraphrase it and mark `rationale: documented`. If you deduced the why from code shape, mark `rationale: inferred` and phrase it as inference. The single worst failure mode of this task is confabulating a clean-sounding rationale for something that was actually an accident. When you cannot find or honestly infer a why, write `why: unknown` — that is a valid and useful answer.
3. **Current state, not history.** The registry describes decisions *in force now*. When you find a superseded decision, it gets ONE line in the domain's Graveyard section: `was X → replaced by Y (evidence)`. Do not narrate evolution beyond that.
4. **Decisions, not descriptions.** "The work queue uses epoch fencing" is a description. "Claims are fenced by epoch so a restarted process cannot double-execute work claimed by its dead predecessor — chosen over lock files/PID checks" is a decision entry. Every entry should let a reader argue with it.

## Entry format

```
### <DOMAIN>-<n>: <short decision title>
- Decision: <what is decided, stated plainly, one or two sentences>
- Why: <the driving reason>  [rationale: documented | inferred]
- Rejected: <alternatives explicitly or evidently rejected, if known — else omit>
- Status: firm | interim (successor: <what/where>) | tunable-config
- Evidence: <commit / file:line / spec / notes — one or more>
- Confidence: high | medium | low
- Open: <optional — unresolved tension or question this decision leaves>
```

## Domains (work them in this order, one at a time)

1. `RECORD` — event intake, capture, message/turn state machine, idempotency, storage
2. `DERIV` — derivation types, cascade order, deterministic-vs-inference boundaries, floors/fallbacks, size dispositions
3. `CHUNK` — chunk membership, close policy, projected vs landed token accounting
4. `VIEW` — compact selection, bands, coverage, gaps, goldens, serving/materialization
5. `QUEUE` — work queue, claims/epochs, drain, retries, poison handling, migrations
6. `INFER` — inference adapter, assignments, prompts/registry, provider/bridge boundaries
7. `PILHC` — connector: hooks, launcher/lifecycle, compact bridge, session serving, threadId mapping
8. `VOCAB` — naming rulings and banned terms
9. `PROC` — process/verification rules

## Sources (in priority order)

- **This repo** at `/Users/leemoore/code/pi-long-horizon/liminal-context`:
  - `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md` (note: predate several recent changes — treat as strong for rationale, weak for current mechanics)
  - `docs/onboard/bad-code-log.md` (process rulings), `CLAUDE.md` (accumulated rulings incl. vocabulary), `docs/fixes-feature-log.md` (current plans, interim placements, and recent Done entries with rationale)
  - Source: `packages/lhc/src/**`, `packages/pi-lhc/src/**` — code comments here are sparse but deliberate; header comments in files often state design intent
  - Tests: golden files under `packages/lhc/test/goldens/`, test names/assertions encode rulings
- **Git history** (rich, narrated commit messages): `git log --oneline` end to end; `git show <hash>` and `git log -p -- <paths>` liberally. **Do NOT check out or read the old spec packs wholesale** (deleted in `431bbbe`; they are too token-heavy to read directly) — you will encounter enough spec content through commit messages and diffs, which is sufficient. Recovering a specific short file via `git show <hash>:<path>` is allowed when a diff points you at something load-bearing, but treat that as a targeted exception, not a browsing mode.

## Loop protocol

Maintain your output file continuously (do not hold results in memory until the end):

- Write to the OUTPUT_DIR given at launch (a directory **outside this repo** — you will be told the exact path), as `candidates.md`. Never write your findings inside the repo.
- **Isolation rule:** other agents may be running the same excavation independently. Their output and working files are strictly out of scope — do not search for, read, or reference any `decision-registry`, `candidates*`, or excavation output anywhere. If you stumble on such a file, close it unread and note nothing from it. Your value is an independent read of the primary sources; copying converges the two runs and destroys the point of running two.
- File header: a progress table — one row per domain: `pending | sweeping | swept-1 | swept-2`.
- Work ONE domain per iteration. For each: read the relevant sources, mine git for that domain's paths (`git log --oneline -- <paths>`), recover relevant specs, write entries as you find them.
- After all nine domains reach `swept-1`, do a second pass per domain asking one question: *"What does the code do that no entry explains? What choice is implied that I haven't recorded?"* Add what you find.
- Stop when the second sweep of every domain adds fewer than 3 new entries, or when you judge genuine exhaustion — whichever comes first. Then write a closing section: `## Coverage notes` — what you could not determine, which domains feel thinnest, and any evidence you wanted but couldn't find.

Expected scale for calibration: a complete sweep will likely yield on the order of 100–200 entries across all domains. Substantially fewer means you're skimming; substantially more means you're recording descriptions instead of decisions.
