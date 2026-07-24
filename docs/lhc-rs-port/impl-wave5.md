# Wave 5 implementation — turns and chunks

You are the IMPLEMENTOR for Wave 5 of the lhc-rs Phase 1 port. Resume the
existing accumulated Cursor session. Work on branch `lhc-rs-port` in
`/srv/work/long-horizon-context`. Do not commit or push. FAST MODE is
explicitly `cursor-grok-4.5-high-fast`.

Read and obey:

- `docs/lhc-rs-port-phase1-brief.md`
- `packages/lhc-rs/PORT_STATUS.md` (court of record; extend, do not reshape)
- the Wave 4 implementation/repair briefs for the current fidelity standard
- `docs/lhc-py-port/impl-wave5.md` and `fix1-wave5.md` for previously
  adjudicated traps, translated to native Rust rather than copied mechanically.

## Wave 5 scope

Complete the full faithful Rust surface of:

- `packages/lhc/src/turns/index.ts` → complete existing
  `packages/lhc-rs/src/turns/mod.rs`
- `turns/internal/store.ts`
- `turns/internal/compose.ts`
- `turns/internal/chunks.ts`
- `turns/internal/chunk-recovery.ts`
- `turns/internal/derive.ts`
- `turns/internal/derivations.ts`
- the Rust internal module declaration

Port assertion-for-assertion:

| TypeScript suite | Rust suite | exact test count |
|---|---|---:|
| `turns.test.ts` | `turns.rs` | 12 |
| `derivation-turns.test.ts` | `derivation_turns.rs` | 14 |
| `detailed-turn-compression.test.ts` | `detailed_turn_compression.rs` | 8 |
| `chunk-detailed-format.test.ts` | `chunk_detailed_format.rs` | 7 |
| `chunk-brief-from-detailed.test.ts` | `chunk_brief_from_detailed.rs` | 6 |
| `chunk-compact-recovery.test.ts` | `chunk_compact_recovery.rs` | 6 |
| **Total** | | **53** |

Add or extend only the fixture/helper surfaces these six suites actually
import. Data-construction and deterministic fixture helpers may be REAL;
SDK/DB behavior remains an exact Phase 2 todo. Any unavoidable Wave 6/7
surface is a minimal faithful PARTIAL recorded in the ledger.

## Phase 1 contract

- Every behavior body is exactly `todo!("phase 2")`. Constants, closed
  types/serde, exhaustive maps, and test-data constructors are REAL.
- Port every TS export and private helper with full signatures. No invented
  public surface, approximated unions, erased `Value`/object bags, or defaulted
  required fields.
- Closed discriminated unions are native Rust enums with exact tags/renames,
  omitted optional fields use `skip_serializing_if`, TS `Map` uses
  `IndexMap`, and closed `Record` dispatch uses exhaustive functions/matches
  with no wildcard arm.
- Persisted/wire byte construction uses the existing `js_json` seam only.
  Plain `serde_json::to_string` outside that module is forbidden.
- Hoist every prompt, SQL, regex, marker, template, and transaction literal
  exactly; keep TS-private literals private. Raw SQL in tests is byte-for-byte
  TS text.
- Preserve the existing host-agnostic, in-process Cargo library/SDK shape.
  Do not introduce Grok Build dependencies, networking, C ABI, `cdylib`, or
  host integration here.

## Previously adjudicated Wave 5 traps

Do not repeat the Python Wave 5 findings:

1. TS `chunkDetailedHandler()` and `chunkBriefHandler()` are synchronous
   zero-argument factories returning `WorkHandler`. Preserve that signature.
   The handler table binds the separate private handler stubs exactly as TS.
2. Private `inferenceFailed` accepts only `{ reason: string }`, not a broader
   inference error. `DetailedChunkComposition` covers every `ok:false`
   `HandlerOutcome` arm, including deferred.
3. For the later-wave compact-recovery dependency, add only faithful native
   closed `CompactAbortSignal` and compact option/input types if required.
   Record them PARTIAL; do not use maps or `serde_json::Value`.
4. Test helpers must preserve declared closed types. Do not use generic
   override maps, `Value`, or `object` stand-ins for closed SDK config,
   derivation, state, row, outcome, or inference shapes. Model TS
   `Partial<T>` narrowly and honestly.
5. Match Vitest assertion semantics exactly. In particular,
   `toMatchObject` checks named fields while allowing extras; do not turn it
   into full-struct equality or weaken it to truthiness.
6. TS `Math.round(x)` uses `floor(x + 0.5)`. Use one narrow JS-compatible
   helper where these suites calculate target tokens; Rust `round()` differs
   for negative half cases.
7. `turns/index.ts` exports only its actual surface. Internal structure rows
   and compact-material variants may be private annotation dependencies but
   must not leak from the domain or crate root.
8. Audit `TurnDeriveResult` and `ChunkDeriveResult` against TS constructor
   bytes. Give them exact tagged serde and mutation-sensitive byte assertions
   when they are wire/data unions, following the repaired
   `MessageDeriveResult` precedent rather than assuming derive field order.
9. The gate must see meaningful assertion fidelity. Preserve each TS
   assertion, timeout, skipped body, SQL corruption step, golden byte/string,
   queue state, and pre/post snapshot. No combined tests that reduce count or
   branches that silently return after an unexpected result.

## Validation and cleanup

- Update `PORT_STATUS.md` row-by-row. Mark full files/suites complete only
  when actually complete; mark later-wave stubs PARTIAL and explain why.
- Run:
  - `cargo fmt --check`
  - `cargo check --tests`
  - `python3 -B scripts/check_gate.py`
  - `python3 -B scripts/check_prompt_bytes.py`
  - an exact TS/Rust suite and assertion-count reconciliation
- Inspect every newly passing test. Add only narrowly named, justified
  allowlist entries for REAL type/constant/serde/shape assertions.
- Do not touch the four root `cc-lhc-*.txt` files or prior certified source
  except the exact PARTIAL modules Wave 5 must extend.
- You own cleanup of only exact temporary artifacts created by this pass.
  Never broadly delete or reorganize unrelated files. Report every exact
  cleanup path.
- Final report: fast-mode model, files/surfaces completed and remaining,
  exact 53-suite counts, assertion reconciliation, gate output verbatim,
  allowlist additions, judgment calls, cleanup, and no commit/push.
