# Phase 2 Wave 4 repair-r1 — reconciled message findings

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 4 tree. Read the onboarding, amended Phase 2 brief, ledger,
Wave 4 implementation/full-verification briefs, matching TS, and this ruling.

Do not commit or push. Do not edit tests, fixtures, assertions, cases, data,
goldens, or oracles. Preserve the four unrelated root `cc-lhc-*.txt` files.
Own and remove only your artifacts. Keep SDK/`init_lhc` in Wave 7.

Full reviews:

- Sol `20260724-234342-bfa6b0`, session
  `019f9683-6a0a-7d72-817b-4c4e51bd7c93`: **FAIL**.
- Copilot-Fable `20260724-234345-f6528f`, session
  `5d0178b3-7931-4c50-9a62-38da8202e45b`, `claude-fable-5` medium:
  headline PASS but two required fixes; treat as repair-required.
- Focused Fable ruling `20260725-000443-47e3d0`, same session/model:
  REAL source-version/unknown-metadata seeds are out-of-contract corruption,
  no frozen-shape amendment; open failures are material and must throw into
  existing containment.

No issue below moves the 496 inventory, `146/335/0/15` Wave 4 arithmetic,
wave plan, scope, or deliverable. Proceed under the decide-or-stop rule.

## 1. Exact ECMAScript trim / trimStart

`messages/internal/smoothing.rs` uses Rust `str::trim` / `trim_start`, which
does not match ECMAScript:

- JS trims U+FEFF BOM; Rust currently preserves it.
- Rust trims U+0085 NEL; JS preserves it.
- BOM-prefixed fence detection therefore differs.

Use or narrowly extend the already certified
`shared_tech::js_json::js_trim` semantics for both full trim and start trim.
Do not duplicate an incomplete whitespace table. Preserve lifetimes/slicing
and every existing newline/fence behavior.

Probe the full ECMAScript WhiteSpace + LineTerminator set individually at
both ends and fence starts, plus NEL and other near misses that JS does not
trim. Compare byte-for-byte with live Node. Mutate BOM inclusion and NEL
exclusion independently; each matrix must turn red.

## 2. UTF-16 marker quantifier

`MARKER_PROMPT_PATTERN`'s `{1,80}` counts Rust scalar values, while JS regex
quantifiers count UTF-16 code units. A bracketed 41-emoji string is 82 JS
units and must not match; Rust currently treats it as 41 and takes the
deterministic floor instead of inference.

Replace the scalar-count regex decision with a private exact predicate (or
equivalent) matching `/^\[[^\]]{1,80}\]$/`:

- literal opening/closing brackets and no internal `]`;
- length 1..80 UTF-16 code units;
- exact handling of astral characters and empty/81-unit boundaries.

Use the certified UTF-16 helper semantics rather than byte/scalar length.
Mutation-probe 40 vs 41 emoji, mixed BMP/astral 80/81 units, embedded `]`,
newlines, empty content, and extra leading/trailing bytes against Node.

## 3. Infrastructure open failures must throw into containment

The certified `HandlerRunContext.open_db: Arc<dyn Fn() -> OpResult<Db>>`
shape stays unchanged. TS's `openDb(): DatabaseSync` is infallible-typed;
runtime failure throws:

- public message derive outer containment returns
  `storage_failure("derive failed: …")`;
- scheduler handler containment returns failed/retryable
  `"handler threw: …"`, not terminal `source_damaged`.

At every relevant `(run.open_db)()` error site in message derive/recovery and
handler source/pair loading, panic with the underlying reason (TS-throw
equivalent) so the existing `catch_unwind` boundary produces the correct
envelope. Audit at least the sites identified by the focused ruling:

- `messages/internal/derive.rs` around prior lines 233, 342, 501, 547, 589;
- `messages/internal/handlers.rs` around prior lines 73, 272, 505, 538.

Do not change genuine missing/deleted/wrong-kind message rows: after a
successful open they still return `message_not_found` / `source_damaged`
exactly as TS. Best-effort post-commit log reopens may continue swallowing
failure under the established durable-work/scheduler precedent.

Probe each producer/path independently:

- open failure at public inline derive → outer storage failure;
- open failure in each handler load/pair/recovery path → handler-threw failed,
  retryable, never blocked/source_damaged;
- successful open + missing/deleted/wrong-kind source retains terminal/caller
  classification;
- mutation restoring one old `Err` conversion turns its owning probe red.

## 4. Corrupt numeric hardening; no shape amendment

Adjudication: reject Sol's proposed preservation of arbitrary REAL
`source_version` and unknown metadata keys as a certification requirement.
Focused Fable independently reproduced the behavior and ruled those raw-SQL
seeds outside the typed contract:

- all production version stampers are integer-closed;
- metadata is mechanically stamped by the closed `DerivationMetadata`;
- no sanctioned corruption fixture writes REAL versions or unknown metadata;
- changing `Derivation.source_version: i64` / `DerivationMetadata` would
  reopen certified shared/turn/report shapes without a forced contract need.

Do **not** reshape those public types or add flattened metadata extras.
Do apply the focused ruling's narrow hardening: both Wave 4
`map_required_i64` decoders in derivation read-back and cascade must reject a
non-integer numeric/string rather than silently `f as i64` truncate. The raw
1.75 seed must fail loudly into the existing storage-failure containment; it
must never surface as 1 or cascade to 2. Integer-valued SQLite INTEGER and
valid integer strings retain existing behavior. Record this verifier override
and corruption doctrine in the ledger.

## 5. Ledger precision

Correct “carried warnings only.” Report the exact current Clippy warnings on
changed Wave 4 lines separately from inherited debt. Fix narrowly introduced
warnings when mechanical and safe; do not broaden into project-wide cleanup.

The NULL `turn_id` cascade note is schema-unreachable (`NOT NULL`) and needs
no production change. The post-commit log reopen behavior is an accepted
precedent. Record both adjudications briefly.

## Checks and report

Run fmt/check/clippy, all eight owning suites, prior-wave suites, direct
disposable probes above, `persist_borrow`, inference prompts, JS-JSON,
prompt bytes, and the full gate. Expected:

```text
exact-todo: tokens=250 bodies=250 covered=250
classified=496 cargo-reported=496
passed=146 suspicious=0 notimpl=335 wrong=0 ignored=15
GATE PASS
```

Append a repair-r1 Wave 4 ledger note with exact fixes, both full reviews and
focused ruling, mutation evidence per producer, shape override, warning
precision, immutable audit, cleanup, and no commit/push. Keep Wave 4 **not
certified** pending changed-scope confirmation.
