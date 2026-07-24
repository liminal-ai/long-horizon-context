# Phase 2 Wave 2 repair-r5 — oracle matrix and fixture strictness

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Wave 2 of 7 remains
uncertified. Read Amendment D and repair-r4 in `PORT_STATUS.md` plus
`docs/lhc-rs-port/phase2-fix4-wave2.md`. Do not commit or push. Preserve the
four unrelated root `cc-lhc-*.txt` files and the future Wave 3 briefs.

The orchestrator independently confirmed repair-r4's double regeneration,
Node v24.18.0, parser tests, related suites, prompt bytes, and exact green gate
`83/398/15 = 496`. Repair these narrow residuals before focused confirmation:

1. The generated fixture currently has 135 rows but only 129 unique names.
   Duplicate names are:
   `apr_31_ms`, `apr_31_nofraction`, `leap_feb_30_ms`,
   `leap_feb_30_nofraction`, `leap_feb_31_ms`,
   `leap_feb_31_nofraction`. Remove the duplicate definitions rather than
   retaining redundant identical cases. Make the generator fail immediately
   if a future duplicate name or duplicate input is introduced.
2. The repair-r4 brief required `+`, `-`, ASCII letters, and non-ASCII digits
   in **every numeric field**. ASCII letters are isolated per field, but signs
   are only represented in the year and non-ASCII digits only by one
   all-fields case. Add fixed-width invalid cases isolating plus, minus, and a
   non-ASCII digit in each of year, month, day, hour, minute, second, and
   millisecond. Keep both parser shapes strict; do not add fallback grammar.
   It is fine to retain the all-fullwidth case in addition to isolated cases.
3. Make both Rust fixture readers strict and mutation-sensitive: deserialize a
   private typed row with `#[serde(deny_unknown_fields)]`, require unique names
   and inputs while iterating, and reject an `expected` value unless it is
   exactly `"invalid"` or a canonical fixed millisecond UTC ISO string. Keep
   one owning test per parser and the same exact allowlist names, so the frozen
   test inventory remains 496.
4. Remove the two new `empty_line_after_doc_comments` Clippy warnings at the
   Amendment D parser comments. Do not expand into pre-existing Clippy debt.
5. Regenerate the fixture, update repair-r4's recorded case count wherever it
   appears in `PORT_STATUS.md`, and report the resulting exact count.

Verification:

```text
node scripts/gen-date-parse-fixtures.mjs
cargo fmt --check
cargo check --tests
cargo clippy --tests
cargo test --lib date_parse_matches_node_oracle -- --nocapture
cargo test --lib parse_iso_to_millis_matches_node_oracle -- --nocapture
cargo test --test persist_borrow -- --nocapture
cargo test --test inference_prompts -- --nocapture
cargo test --test js_json_conformance
python3 -B scripts/check_prompt_bytes.py
python3 -B scripts/check_gate.py
```

Regenerate a second time and prove byte identity. Independently enumerate row
count, unique-name count, and unique-input count; all three must match. Preserve
repair-r4's per-parser mutation evidence and leave sources restored. Clean only
artifacts you create. Report exact files, count/hash, tests, warnings, gate,
session/model, and no commit/push. Wave 2 remains not certified.
