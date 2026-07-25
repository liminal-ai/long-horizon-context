# Chunk 3A verification — product wiring

You are an **independent adversarial verifier**, read-only with respect to
project history. Do not commit. Do not consult or wait for the other verifier.

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.** This is the **first full
verification of a new chunk**, so you are starting fresh by design. Chunk 3 is
the only chunk that produces something the user can actually run.

## Tree isolation

The two lanes run in **separate trees** — one in `/srv/work/grok-build`, one in
an rsync copy. Mutate freely; restore before final checks and say so. State
which tree you measured. If files change under you mid-run, that report is
authoritative and the round re-runs.

## Scope — and what would make this pass

3A is **product wiring only**: configuration, status/inspect, health/repair,
privacy/telemetry, rollout safety, migration. Live certification is 3B.

**This passes when the product surfaces are correct and honest.** Findings
about things 3A explicitly defers to 3B with a named checkpoint are **not**
blocking — say so and move on. Classify every finding as **genuinely blocking**
(the product is wrong) or **carryable** (named 3B checkpoint). A mislabelled
table row is not blocking.

## Chunk 2 is committed and settled

`817472b`. Do not re-verify it. Settled and out of scope: write-back; the typed
provenance classifier; identical-content dedup; hook 4's continued existence
(removal is by evidence at Chunk 3); the equivalence instrument's fingerprint
pinning; `truncate_to_prompt_index` divergence; the SDK typed-view gap; G2
(capture the real write-back body from a live Replace compaction and re-verify
instrument **calibration**, not just fixtures) — that is a 3B checkpoint.

## What 3A claims

**Touchpoints added** (authorized in the impl brief; anything beyond is a
finding): `slash_commands.rs` (`BuiltinAction::Lhc`, `LhcSlashOp`, parser,
`command_name`, `args_provided`); `slash_exec.rs` (handler); `config/mod.rs` +
`agent/config.rs` (`[lhc]` section, resolve/apply). **Hooks 1–6 unchanged,
sentinel 6/6.**

Verify each claim:

1. **Config precedence: env > `[lhc]` config.toml > default(off).**
   `apply_resolved_config` only fills **unset** env vars. Check the precedence
   holds in both directions, that existing `GROK_LHC*` env usage still works
   unchanged, and that **default is off**.
2. **Off-by-default is still absolute.** With `GROK_LHC` unset and no `[lhc]`
   section: host behaviourally identical, **no added per-turn work**, and the
   new `/lhc` command does **no SQLite I/O**. This is the standing law of the
   whole project — attack it hardest. Confirm the new config resolution itself
   does not touch storage or spawn anything when disabled.
3. **`/lhc` status makes the active context engine unambiguous** — the Phase 3
   done-definition requires a user never has to guess whether native or LHC
   built their request. Check it reports honestly in every state: off, on,
   Shadow, Replace, capture inactive, storage missing, degraded health.
4. **Repair is explicit and never destructive without saying what it deletes.**
   `plan_repair` / `execute_repair`: confirm no automatic invocation, and that
   the delete list is shown before acting.
5. **Rollout safety.** Per-session `/lhc on|off`; disable mid-session leaves a
   coherent session; re-enable does not double-record or corrupt.
6. **Migration/discovery.** Enabling LHC on a session that already has native
   history: bootstrap + dedup, no duplicate events, no lost turns.
7. **No silent remote upload of LHC SQLite** — a named Phase 3 requirement.
   Verify by tracing the telemetry and memory paths, not by grep alone.

## Two findings 3A self-reported — confirm or refute, do not re-derive

- **Write-back recoverability (MAPPING.md:619).** After a Replace compact the
  pre-compaction native RAM body is gone; native session persistence is
  "partial, live-cert must confirm"; the LHC event log retains full fidelity
  and is rebuildable; Shadow leaves native untouched. My reading is that this
  satisfies "no irreversible migration before validation" **because Replace
  requires `GROK_LHC_COMPACT_EXPERIMENTAL=1`** and the default Shadow path is
  non-destructive. **Check that gating still holds.** If Replace is reachable
  without the experimental flag, that is genuinely blocking.
- **Mid-session `/lhc on` limitation.** Enabling mid-session spawns capture
  **without** the shell inference sampler (the spawn-time path owns the full
  `SamplerConfig`), so compaction's ModelCall may be unavailable until the next
  session spawn. Confirm the scope: does the user get capture-but-no-compaction
  silently, and does `/lhc` status **say so**? A capability gap the status
  surface hides would be blocking; one it reports is carryable.

## Regression

Chunk 1/2 invariants intact: stable `ITEM_KEY_GENERATION`, fresh per-call
occurrence tracker, monotonic merge, write-back fixpoint, kind conservation,
whole-index failure aborts. Sentinel 6/6; vendored submodule clean at
`e582465`; FORK.md inventory and numstats match; `patches/` regen list matches
`git diff --name-only origin/main -- crates/codegen/ Cargo.toml`; no wildcard
`_ =>` over host enums.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Full `cargo test`; lib / certification / goldens separately; name any ignored
test. Attribute clippy warnings — vendored-port warnings are settled.

## Report

**Lead with: CHUNK 3A — PASS or CHANGES REQUIRED.** Then each finding with its
classification (**blocking** / **carryable with named 3B checkpoint**), the
off-by-default evidence, your verdict on the two self-reported findings, the
regression check, and a coverage note. If you pass it, list what 3B's live
certification must confirm.
