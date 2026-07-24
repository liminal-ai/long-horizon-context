You are the IMPLEMENTOR for Wave 6 of the lhc-rs Phase 1 port
(skeletons + tests) — thread-view, the largest Phase 1 wave. Continue the
same session and contract used for Waves 1–5. Repo
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, baseline commit
`c083f4d`. Do not commit or push. Work only in `packages/lhc-rs/` plus this
wave's ledger entries. Do not touch the four untracked root
`cc-lhc-*.txt` files.

Read first:

- `docs/lhc-rs-port-phase1-brief.md`
- `packages/lhc-rs/PORT_STATUS.md` (Wave 0 rulings remain binding)
- `docs/lhc-py-port/impl-wave6.md`
- `docs/lhc-py-port/fix1-wave6.md` (all 17 findings are preventive
  requirements for this Rust port)

The TypeScript source and tests are authoritative. Python is a
cross-reference for prior judgments, never the source of truth.

## Wave 6 source scope

Complete the existing PARTIAL `src/thread_view/mod.rs` to the full faithful
surface of `src/thread-view/index.ts`, preserving the Wave 1/4/5 surfaces
and recorded rulings. Extend `src/sdk.rs::ThreadViewSurface` with the
corresponding SDK methods and crate-root re-exports of the canonical view
types; do not duplicate those types locally. Port all ten internal modules:

- `assemble.ts` -> `thread_view/internal/assemble.rs`
- `boundary.ts` -> `thread_view/internal/boundary.rs`
- `compact-compute.ts` -> `thread_view/internal/compact_compute.rs`
- `materialize.ts` -> `thread_view/internal/materialize.rs`
- `profiles.ts` -> `thread_view/internal/profiles.rs`
- `render.ts` -> `thread_view/internal/render.rs`
- `seam.ts` -> `thread_view/internal/seam.rs`
- `select.ts` -> `thread_view/internal/select.rs`
- `session-view.ts` -> `thread_view/internal/session_view.rs`
- `snapshot.ts` -> `thread_view/internal/snapshot.rs`

Add the internal module wiring. Every TS export and every private helper must
exist with its full faithful signature. Function bodies are exactly
`todo!("phase 2")`; types and constant data are real. `profiles.ts` is
constant data: port every table, key, number, and string as real data with
wire bytes/order matching TS. Do not invent convenience APIs, defaults,
blanket `Default` impls, or widened strings.

Rust rules that matter especially here:

- Persisted/data shapes use serde camelCase wire names and omit optional keys
  exactly where TS omits them. Closed vocabularies are enums; all closed
  matches are exhaustive with no wildcard arm.
- Preserve public `OpResult<T>` signatures rather than replacing them with
  `Result`.
- TS `number` fields that are deliberately fractional must not become an
  integer-only Rust type. Audit `targetTokens` in particular.
- TS dot-accessed declared shapes must be named structs, not maps or JSON
  values. Keep required fields required; do not add empty/zero/None defaults
  to satisfy Rust field ordering or construction.
- Preserve one canonical type when `index.ts` re-exports an internal type
  (not duplicate lookalikes). Audit `MaterializeResult`.
- Abort/cancellation is a live semantic hazard for Phase 2. Preserve the
  narrowest faithful Phase 1 surface and document any snapshot-vs-live
  limitation in the ledger; do not claim behavior parity.
- No raw `serde_json::to_string` outside `shared_tech/js_json.rs`.
- All SQL, regexes, profile strings, render labels, hook names, and accepted
  format names are exact source bytes. No source trailing whitespace.

## Fixtures and immutable assets

Port or extend every fixture surface imported by these tests, including:

- `tests/fixtures/pi_session_format.rs`
- the exact bytes of `pi-session-structure.jsonl` and its provenance markdown
- `tests/fixtures/view_boundary.rs`
- `tests/fixtures/view_seam.rs`
- `tests/fixtures/view_thread.rs`
- the corresponding exact re-exports from `tests/fixtures/mod.rs`

Also copy the four TS `test/goldens/g*.json` files plus their README verbatim
into `tests/goldens/` if they are not already present. Never regenerate or
normalize goldens or the pi-session assets.

Fixture data construction, constants, and raw SQLite setup needed to state
assertions are real; SDK-calling behavior remains `todo!("phase 2")`.
Port the *complete* fixture surface, including private helpers and constants,
not only the names a first compile exposes. Preserve the Python Wave 6
findings in Rust-native form: required fields, closed types, exact JSON/SQL,
correct SDK nesting, and deterministic cleanup/hook reset structure.

## Test scope — 11 suites, 101 tests

Port every assertion and full skipped body:

- `view-boundary-turn-end` -> `tests/view_boundary_turn_end.rs`: 2
- `view-boundary` -> `tests/view_boundary.rs`: 7
- `view-compact-full-boundary` -> `tests/view_compact_full_boundary.rs`: 9
- `view-compact-preview` -> `tests/view_compact_preview.rs`: 13
- `view-compact` -> `tests/view_compact.rs`: 17
- `view-fixture` -> `tests/view_fixture.rs`: 13
- `view-llm-request-context` -> `tests/view_llm_request_context.rs`: 15
- `view-prune` -> `tests/view_prune.rs`: 8
- `view-render-targets` -> `tests/view_render_targets.rs`: 5
- `view-select-golden` -> `tests/view_select_golden.rs`: 4
- `view-session-thread-view` -> `tests/view_session_thread_view.rs`: 8

The counts above are semantic TS `it()` blocks (not incidental textual
matches). Maintain assertion-for-assertion fidelity:

- `toEqual` means full exact structure and order; `toMatchObject` /
  `objectContaining` permits extras but requires every named field.
- Preserve negation, null-vs-undefined distinctions where representable,
  error regex vs substring semantics, concurrency (`Promise.all`), and the
  exact operation around which a throw is asserted.
- `??` is not truthiness fallback. Do not translate it as `or`.
- JSON.stringify bytes use the existing JS-JSON seam. SQL text and whitespace
  are verbatim.
- Golden tests read the committed files and compare the same bytes; do not
  make a test pass by producing expected golden literals.
- Rust cleanup and global hook reset must run even when assertions panic.
- Use declared Rust structs/enums in tests, never map/JSON stand-ins for
  declared TS shapes.

If a Wave 7 type is strictly required for compilation, add only the minimal
faithful PARTIAL stub and mark it honestly in the ledger. Do not reduce Wave
6 scope.

## Verification and ownership

Run:

```text
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
```

Expected delta is exactly 101 newly mapped tests. Reconcile collected,
classified, and ledger counts; `wrong=0`, `suspicious=0`. Inspect all
allowlisted passes rather than expanding the allowlist broadly.

Update `PORT_STATUS.md` honestly, including source rows, fixture rows, exact
suite counts, real constants/assets, PARTIAL limitations, and new exact
allowlist entries only. As the Wave 6 implementor, you own removal of only
the temporary files or build artifacts you create during this run; do not
organize or delete unrelated repository content.

Final report: files completed/remaining, exact gate output, test count
reconciliation, assets byte comparison, numbered judgment calls, any
unfaithfully representable TS semantics, and exact cleanup performed.
