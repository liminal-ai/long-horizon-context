# Chunk 3A fix round 1

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

Both verifiers ran in separate trees and both returned CHANGES REQUIRED. What
held: config precedence (env > `[lhc]` > default-off), Replace gating behind
`GROK_LHC_COMPACT_EXPERIMENTAL`, the no-silent-upload requirement (traced, not
grepped), migration/bootstrap dedup, and the substance of off-by-default
(`is_enabled()` false, no SQLite, no worker, no per-turn work).

Six blocking items.

---

## Y1 [blocking] `/lhc on` cannot install a tee — capture detaches, and serving goes stale

**This is the finding that matters.** Both verifiers found it independently;
one proved it with probes.

The LHC data path is the `LhcTeePersistence` decorator, installed **once at
session spawn** (`tee.rs:24-46` via hook 2, `spawn.rs:444`) and owned immutably
by `ChatStateActor`. `/lhc on` (`slash_exec.rs:120-140`) calls `spawn_capture`,
which only **registers a worker**. It cannot insert a tee, and cannot re-arm a
latched one.

Both paths confirmed empirically:

| Probe | Setup | Events after bootstrap | After more turns |
|---|---|---|---|
| A | spawned LHC-off, then `GROK_LHC=1` + `/lhc on` | 2 | **2** |
| B | spawned LHC-on, `/lhc off`, `/lhc on` | 4 | **4** |

In B the tee latches `capture_stopped = true` (`tee.rs:69-82`) when the old
handle closes and never un-latches.

**The consequence is worse than lost capture.** Hook 4 (`turn.rs:2124-2126`)
gates substitution on `capture_active()` — registry presence alone. So LHC is
consulted and **builds the request context from an event log frozen at
bootstrap** while the real conversation moves on. Fail-open does not save this:
its fallback keys on view/tail coverage, and a stale log is internally
consistent. The model gets a coherent, wrong history.

**Requirement: `/lhc on` mid-session must actually capture.** Prefer fixing the
mechanism over refusing, because per-session opt-in is a named rollout-safety
requirement (A5) and a `/lhc on` that cannot work means A5 is not met.

The direction I'd take, though the implementation is yours: have the tee
**resolve its handle per call** (`lookup_session(sid)`) rather than capturing
one at construction. The cost is a registry lookup per persist, which is
already behind the `any_capture_active()` atomic fast path from Chunk 2's L3
fix, so the disabled path stays free.

If you conclude the mechanism genuinely cannot be fixed inside the adapter,
then `/lhc on` must **refuse loudly**, say why, and status must report capture
as unavailable — never claim LHC is active. **Stop and report** if you land
there; a per-session enable that silently does nothing is not shippable either
way.

Test the product path, not the handle path: the existing rollout test drives
`spawn → shutdown → spawn` on handles directly, which is why it missed this.

## Y2 [blocking] Status asserts the wrong engine and calls it healthy

`status.rs:111` derives "Active context engine: LHC" **solely from capture
registration**. But serving fails open to native on timeout, worker or
classification error, empty/unsafe view, or substitution refusal — while
capture stays active. So status can report LHC immediately after native built
the request. Under Y1's probe A it printed `engine: LHC / capture: true /
events: 2 / health: ok` with the conversation growing and none of it recorded.

The Phase 3 done-definition requires the active engine be **unambiguous**. This
does not leave it ambiguous — it asserts the wrong one.

Report what actually happened on the last turn: whether substitution occurred,
and if not, why (the fail-open reason is already available). If no turn has run
yet, say that rather than inferring. Certification proves the timeout fallback
exists but never checks the status label afterwards — bind them.

## Y3 [blocking] Off-by-default mutates the process environment

`resolve_and_apply` runs unconditionally (`agent/config.rs:2216`). With
`GROK_LHC` unset and no `[lhc]` section, `apply_resolved_config` still sets:

```
GROK_LHC_ROOT=/home/leemoore/.lhc
GROK_LHC_COMPACT=shadow
```

Two problems:

**(a)** These leak into every child process — Bash tool, MCP servers,
subagents. The standing law is that the host is **behaviourally identical**
when LHC is off. It substantively is (no SQLite, no worker, no per-turn work),
but this is observable, and "identical" should mean identical.

**(b)** It corrupts the chunk's own core deliverable. `status.rs:103` decides
`root_source` from `env_var_os("GROK_LHC_ROOT").is_some()` — always true after
apply — so `/lhc` reports `(source: env)` for a value the product set itself
and the user never touched. Someone debugging their storage root is sent
hunting a variable that does not exist. **The correct pattern is already two
lines up**: `compact_source` reads the `APPLIED` snapshot and correctly prints
`(source: default)`. Use it.

Do not set env vars for values that came from defaults.

## Y4 [blocking] `/lhc repair confirm <id>` deletes without a bound plan

`/lhc repair confirm <id>` calls `execute_repair` directly
(`slash_exec.rs:99`, `status.rs:322`). There is no stored plan, nonce, or proof
that `/lhc repair` ever displayed anything — `execute_repair` constructs a fresh
plan and deletes immediately. A verifier invoked `remove-orphan-session-dir`
directly and confirmed deletion with no prior displayed plan.

**Note: the verifiers disagreed here** — one classified it blocking, the other
read repair as holding. I adjudicated against source and Sol is right on the
letter: the requirement is *never destructive without saying exactly what it
will delete*, and a confirm token that binds to nothing means the user can
delete a set they were never shown.

Bind the confirmation to a displayed plan — store it and require the id to
match, so `confirm` can only execute something the user has seen enumerated.

## Y5 [blocking] Corrupt or degraded storage reports healthy

Without a worker, the presence of any thread file is taken as proof the schema
exists; no SQLite validation occurs. An orphaned or non-SQLite file under an
existing root yields `schema_present = true` and health `ok`. Validate the
store rather than inferring from a filename, and make `health_check` report
degraded when it cannot confirm the schema.

## Y6 [blocking] `patches/` regen list omits `config/tests.rs`

`patches/README.md` states its own invariant: *"The list must equal
`git diff --name-only origin/main -- crates/codegen/ Cargo.toml`."* It does not
— 3A modifies `crates/codegen/xai-grok-shell/src/config/tests.rs` (+37, the two
`lhc_config_*` tests) and the list omits it. After a history reset the drill
would regenerate patches without it and silently lose the config tests —
exactly trap #1 the README documents. `check-lhc-hooks.sh` cannot catch this.

Add it, and re-check the invariant holds for every path.

## Y7 [major] Two config traps worth closing now

Both are cheap and both mislead a user in the chunk that *is* the product:

- **`GROK_LHC=on` is silently dropped.** `env_truthy` (`runtime_config.rs:62`)
  accepts `on`; `gating::is_enabled()` (`gating.rs:10`) accepts only `1`/`true`.
  The resolver says enabled, the gate says off. Reconcile the two truthiness
  sets.
- **A malformed `[lhc]` section silently resolves to off.**
  `config.get("lhc").and_then(|v| v.clone().try_into().ok()).unwrap_or_default()`
  discards the whole section on one type error, while `has_section` still
  attributes provenance to `config` — so `enabled = true` plus a typo'd sibling
  key renders "off (source: config)". Surface the parse error instead of
  swallowing it.

## Carried to 3B — do not fix now

Unknown `/lhc` subcommands falling through to Status (and `repair confirm`
being case-sensitive while other arms are not); the status early-return
asymmetry (`any_capture_active` process-wide vs `capture_active` session-local);
and the latent `unsafe set_var` from `refresh_settings_and_reapply`
(`agent_ops.rs:977-990`) re-entering `apply_resolved_config` on `/new` with
tokio workers live. Record each in the 3B brief with a named checkpoint.

---

## Report

Position against the full project. Lead with Y1: the mechanism you chose, and
the probe showing that after `/lhc on` — both from spawned-off and from
off-then-on — new turns actually reach the LHC log. Then Y2's honest engine
reporting, Y3's provenance fix, and the rest. Full suite counts, both fmt
gates, `--all-targets` clippy attributed. Confirm hooks stay 6/6, no seventh
touchpoint, and the vendored port untouched.
