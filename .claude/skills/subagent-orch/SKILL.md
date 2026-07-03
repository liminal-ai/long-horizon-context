---
name: subagent-orch
description: Orchestrate implementation and verification subagents across the subagent CLIs (cursor/codex/claude) and built-in forks. Invoke ONLY when the user explicitly requests subagent orchestration — do not self-trigger.
---

# Subagent Orchestration

## Standard Process

The default loop for delegated implementation work:

1. **Brief** — write the task as a self-contained brief (goal, constraints,
   file paths, acceptance criteria). For anything over a few lines, put it in
   a file and pass via stdin/`--prompt-file` — never inline-quote a multi-line
   brief through the shell.
2. **Implement** — default coder is **Composer 2.5 via `cursor-subagent`**.
   Launch sync (`exec`) for bounded tasks, detached (`start` → `status` →
   `result --wait`) for long ones.
3. **Verify** — default verifier is a **self-fork** (Agent tool,
   `subagent_type: "fork"`): it inherits your full session context at cache
   prices and needs no onboarding brief. Alternative: **gpt-5.5 high via
   `codex-subagent`** when you want an independent perspective or a review
   uncontaminated by your own session's assumptions.
4. **Converge** — feed verified findings back to the implementor by
   **resuming its session** (`--resume <session_id>` from the envelope), so
   fixes land with the implementor's full context. Repeat implement→verify
   until the verifier passes clean. Two consecutive rounds with no new
   findings = converged.
5. **Never treat envelope `status: ok` as task success.** It means the run
   exited cleanly. Verification (tests, diff review) decides success.

Keep roles separated: the implementor codes, the verifier judges, you route.
Don't have the implementor self-certify, and don't fix the implementor's
work inline yourself unless it's a trivial finishing edit.

## Forking Yourself (Verification Clone)

`Agent` tool with `subagent_type: "fork"` clones the orchestrator:

- Runs on **your model, whatever that is** (model override is ignored),
  with **your full conversation context** — it already knows the spec, the
  decisions, and the history. No briefing cost, cache-priced input.
- Runs in the background; its tool output stays out of your context. Its
  final message is returned to you — tell it exactly what to report back
  (verdict + deviations, not a transcript).
- Best for: verification of work you orchestrated, audits against a spec
  discussed in-session, any judgment task where session context is the
  main input.
- Limit: the clone shares your priors and blind spots — same model, same
  assumptions, reviewing plans it (as you) helped shape. When the risk is
  "we're both wrong the same way," use a fresh outside model
  (gpt-5.5 via codex-subagent) instead of, or in addition to, a fork.
- A fork can itself use the subagent CLIs — so "fork verifies, and where it
  finds issues, it launches the pinned-model rerun" is a valid composition.

## The Subagent CLIs

Three sibling CLIs, identical verb surfaces (`exec/start/status/result/last/
messages/tools/list/stop/docs`), identical envelope and session-file
contracts. On PATH:

- **`cursor-subagent`** — Cursor's agent; Composer 2.5 default. The coder.
- **`codex-subagent`** — Codex; gpt-5.5 @ high effort from config.toml.
- **`claude-subagent`** — Claude Code headless; full-autonomy default.
  Supports exact model pinning (`--model claude-opus-4-6`) and
  `--effort low|medium|high|xhigh|max`.

**First use of any of these in a session: run the bare CLI with no
arguments** (e.g. Bash: `cursor-subagent`). Each prints a complete
self-onboarding page — commands, envelope contract, execution profile,
safety notes, examples. Read it before the first `exec`; it is the current
and authoritative usage doc. Do not operate from memory of a prior session.

Runs execute in the cwd at invocation — `cd` into the target project first.

## Model Table

| model        | cost | intelligence | taste | harness |
|--------------|------|--------------|-------|---------|
| composer-2.5 | 9    | 7            | 7     | cursor-subagent |
| gpt-5.5      | 9    | 8            | 5     | codex-subagent |
| opus-4.6     | 6    | 7            | 8     | claude-subagent `--model claude-opus-4-6` |
| opus-4.8     | 4    | 8            | 8     | claude-subagent, or Agent tool `model:"opus"` |
| fable-5      | 2*   | 9            | 9     | Agent tool fork (*cache-priced) or `model:"fable"` |

Routing by task weight:

- **Simpler / mechanical** (clear-spec implementation, refactors, test
  writing): composer-2.5. Fast, near-free, no hygiene debt.
- **Harder implementation** (gnarly logic, cross-cutting change): still try
  composer first; escalate to opus-4.6 high effort, then opus-4.8. Judge
  the output, not the price — escalating costs less than shipping mediocre
  work.
- **Analysis / investigation / second-opinion review**: gpt-5.5. Raw
  intelligence at effectively zero cost; hygiene risk doesn't apply to
  read-only work.
- **Verification of orchestrated work**: self-fork first (context is the
  input); gpt-5.5 high for independence; both when stakes justify it.
- **Taste-sensitive work** (API design, UX copy, naming): opus-4.6/4.8 or
  fable — taste ≥ 7.

## Nuance and Factors

**gpt-5.5 hygiene caveat.** Very smart, but when it writes code it
over-protects: backwards-compat shims, regression tombstones, silent
"gentle fallback" paths instead of asking. This compounds into cleanup
debt. If gpt-5.5 implements, pair the brief with explicit instructions:
*no fallbacks, no compat shims, no defensive wrappers — fail loudly and
ask on ambiguity.* Prefer it for analysis and review, where the caveat is
irrelevant.

**The opus ladder.** Default Claude is opus-4.6; prefer 4.6 at high effort
before reaching for 4.8. Reserve 4.8 for the hardest non-fable work. No
sonnet in this rotation.

**Thinking-level control by harness.** Ad-hoc Agent tool spawns take a
model alias but **no effort parameter** and no version pinning ("opus"
means current opus). Effort control requires: a subagent definition file
(`.claude/agents/*.md` frontmatter), the Workflow tool's per-call
`effort` option, or the CLIs (`claude-subagent --effort`, codex via
`-c model_reasoning_effort=...`). If a specific model version or thinking
level matters, use the CLI harness.

**Harness selection rule.** Built-in Agent tool for context-sharing and
alias-level Claude spawns (forks, quick fable/opus lookups). Subagent CLIs
for precision: exact model versions, effort levels, non-Claude models, and
anything needing a durable inspectable session (envelope, stream.jsonl,
resume across turns).

**Parallelism.** One coder per project directory. For parallel work,
prefer parallel *projects* (separate cwds) over parallel agents in one
tree. Two runs in the same cwd may serialize, hang, or tread on each
other's edits.

**Cost posture.** Every CLI run is a paid call. A fumbled launch (wrong
cwd, corrupted inline prompt) costs more than any token-saving shortcut.
Briefs via file, verify cwd before launch, check `git status` before
retrying a failed run — partial edits may already be in the tree.
