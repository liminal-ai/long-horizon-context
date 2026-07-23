# lhc-rs Port — Phase 1 Brief (skeletons + tests)

Port the LHC SDK (`packages/lhc`, TypeScript) to Rust as `packages/lhc-rs`.
This brief governs Phase 1: a compiling crate carrying the full API surface,
all types, all prompt text, and all ported tests — with every function body
`todo!("phase 2")`. Phase 2 (implementation to green) is a separate brief.

This is the second run of a proven playbook. The first run produced
`packages/lhc-py` (455/455 tests passing, cross-language conformance
certified against the TS build). Read `docs/lhc-py-port-phase1-brief.md`
for the wave mechanics — this brief states what carries over by reference
and spells out only the Rust deltas and the lessons the Python run taught.

## Purpose and consumers

lhc-rs will be vendored (git submodule, t3code pattern) into two Rust host
forks: `liminal-ai/grok-build-lhc` (first integration target) and a Codex
fork (second). It must therefore stay host-agnostic: no grok/codex deps,
no network calls, inference only via the host-supplied ModelCall seam.

## Environment

- Repo: `/srv/work/long-horizon-context`, branch `lhc-rs-port` (create from
  `main`). All paths below are repo-relative.
- Reference implementation: `packages/lhc/src` (72 source files) and
  `packages/lhc/test` (53 suites + 18 fixture helpers). The TS build is the
  oracle: `packages/lhc` builds and runs on this box (node + pnpm present).
- Python port for cross-reference on judgment calls already settled once:
  `packages/lhc-py` (its `PORT_STATUS.md` maps every TS file to its port).
- Rust: stable toolchain via rustup. Crate root `packages/lhc-rs/`
  (standalone Cargo package; NOT part of any host workspace).
- Ledger: `packages/lhc-rs/PORT_STATUS.md`, same format as lhc-py's.

## Conventions (the contract — deviations need orchestrator sign-off)

| TS construct | Rust convention |
|---|---|
| module file `foo-bar.ts` | module `foo_bar.rs`, same directory shape under `src/` |
| discriminated union (`kind`/`type` tag) | one Rust `enum` with `#[serde(tag = "<tag>", rename_all = "camelCase")]` on variants mirroring the TS discriminant values exactly. Rust enums are the *native* fit here — do NOT do dataclass-per-variant like Python had to |
| interface for persisted/data shape | `struct` with `#[serde(rename_all = "camelCase")]`; field names snake_case in Rust, camelCase on the wire. Persisted bytes are the parity bar, not source spelling |
| `OpResult<T>` (`{ok:true,value} \| {ok:false,error}`) | mirrored generic `OpResult<T>` enum (serde-compatible with TS shape). Internal helpers may use `Result` but every ported public signature keeps `OpResult` |
| `readonly X[]` | `Vec<X>` in fields; `&[X]` in params. No tuple/Vec mixing (Python finding #5) |
| optional field | `Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]` where TS omits the key (check the oracle's actual bytes, not the type) |
| async function | `async fn`, tokio runtime; tests `#[tokio::test]` |
| `node:sqlite` | `rusqlite`, behind ONE adapter module `src/shared_tech/storage.rs` (the TS file that imports node:sqlite) — the only file that imports rusqlite |
| function body | exactly `todo!("phase 2")`. Exceptions: verbatim constants (incl. ALL prompt text) and pure type/serde definitions — those are ported fully in Phase 1 |
| test suite `foo.test.ts` | `tests/foo.rs` (integration tests), assertions mirrored 1:1; loop/factory-generated `it()` blocks become macro- or loop-generated `#[test]`s with matching counts |

## Lessons from the Python run — now rules, not discoveries

1. **JS-JSON parity module lands in Wave 0, used everywhere from day one.**
   Python shipped a correct `js_json_dumps` wired into 1 of 5 call sites;
   the other 4 were found by audit weeks later. Rust rule: `src/shared_tech/
   js_json.rs` (JSON.stringify-compatible: integral floats render `1` not
   `1.0`, `NaN`→`null`, key order preserved via serde_json `preserve_order`)
   is the ONLY serializer any ported code may call for persisted/hashed/
   token-counted bytes. Add a clippy-greppable tripwire: plain
   `serde_json::to_string` outside `js_json.rs` fails the gate script.
2. **Prompt text is hoisted to module-level `const` and byte-verified against
   the TS oracle in Wave 1, not later.** The Python run's worst finding was
   invisible `\n`-escape corruption in a prompt template. The oracle harness
   (`scripts/render-prompts-oracle.mjs` — write it in Wave 0) renders every
   TS prompt; a Rust test compares bytes. Commit the oracle renders as
   fixtures so verification never depends on /tmp state.
3. **Stub files name only real TS elements.** Nothing invented, ever
   (Python: fabricated `sdk.drain` surface). Partial stubs fine; fiction not.
4. **Extend, don't reshape** anything Wave 0 established.
5. **Gate reconciliation**: classified outcomes must equal collected tests —
   silently-dropped tests were a Python gate blind spot. The gate script
   (`scripts/check_gate.sh` parsing `cargo test` output, or cargo-nextest's
   machine-readable run) buckets: compile error (blocker), `todo!` panic
   (expected), assertion failure (WRONG — investigate), pass (allowed only
   for constants/serde/goldens; listed by name in the ledger).
6. **Exhaustive matches as drift tripwires**: everywhere TS switches on a
   closed vocabulary, the Rust `match` has NO wildcard arm — a new variant
   anywhere becomes a compile error demanding a mapping decision.

## Rust-specific gotchas (settle in Wave 0 exemplars)

- **Regex dialect**: the `regex` crate has no lookaround/backreferences.
  Audit every TS regex (classify-tool-result, smoothing cleanProse, marker
  matching); use `fancy-regex` only where genuinely required, and note the
  JS-vs-Rust `\b`/`\w` Unicode semantics decision in the ledger (known
  accepted divergence class from the Python run — classifier component,
  cosmetic impact only).
- **JS string semantics**: `.trim()` (BOM/whitespace set), `localeCompare`
  ordering, UTF-16 vs UTF-8 string lengths where the TS counts characters
  for truncation targets. Token estimates count bytes/chars — match the TS
  arithmetic exactly (chars as UTF-16 code units where TS uses `.length`).
- **Ordered JSON**: enable serde_json `preserve_order` at crate level.
- **No `Date.now()` in library code**: clock is an injected seam, mirroring
  the TS `deterministic.ts` pattern (already proven in both prior ports).

## Wave plan

**WAVE 0 IS DONE** (orchestrator, 2026-07-23): crate scaffolds and compiles
clean; js_json.rs REAL with node-fixture conformance green; sqlite seam,
gate (`python3 scripts/check_gate.py`, not .sh), committed oracle fixtures
for js-json and all nine prompts, PORT_STATUS.md ledger, and four exemplar
files + the exemplar test suite. Gate state at handoff: passed=4 (allowlisted)
notimpl=4 wrong=0, reconciled. A fresh agent resumes at Wave 1: work the
ledger top to bottom within the wave, trust the Wave 0 rulings recorded in
PORT_STATUS.md, and extend partial modules (derivation.rs, storage.rs)
without reshaping them.

Same dependency order and content as the Python brief (§waves) — 0 through 7,
per-wave commits, ledger updated per file. Deltas:

- **Wave 0 (orchestrator, not loop agents)**: cargo scaffold, `js_json.rs`
  with conformance tests against oracle fixtures, sqlite adapter seam,
  gate script, prompt-oracle script + committed fixtures, PORT_STATUS.md,
  and four exemplar files with their ported tests (`errors.rs`,
  `deterministic.rs`, `classify_tool_result.rs` + one test suite) that make
  every conventions-table row executable. Wave 0 ends with the gate green
  on exemplars and is the conventions court of record.
- **Compilation is the Phase 1 bar** (Python only needed import success).
  Every wave must `cargo check` clean AND `cargo test` gate-clean. This is
  more work per wave than Python — and more value: the compiler certifies
  the shape contract that Python needed adversarial review to hold.
- Waves 1-7 scope mapping: use lhc-py's `PORT_STATUS.md` as the
  authoritative file list (it already reconciles the 72+53 inventory).

## Orchestration

Same trio and loop as the Python run, run from a cc-lhc session:
grok-4.5-high implements per wave (no commit rights), gpt-5.6-sol verifies
adversarially (findings-only, honesty note on coverage), orchestrator
(Fable) spot-checks, runs the gate, reconciles disputes, ticks the ledger,
and is sole committer. Known model behaviors from the Python run: grok cuts
corners on tests/fixtures under time pressure (verify test-assertion
fidelity specifically); sol over-scopes (rulings may override its demands;
document overrides in the ledger).

## Out of scope for Phase 1

Implementation of any behavior (Phase 2); `reference/`, `prompt-lab/`,
live-network `inference-real` suites (decision on porting its unkeyed
accounting legs is an explicit open item carried from lhc-py); the grok-build
host adapter (separate project, starts only after Phase 2 certifies).

## Done definition

`cargo check` clean; gate: WRONG=0, reconciliation exact; all 72 source
files + 53 suites present in ledger with status; prompt bytes certified
against committed oracle fixtures; conventions exemplars committed; a fresh
agent can resume from the ledger alone.
