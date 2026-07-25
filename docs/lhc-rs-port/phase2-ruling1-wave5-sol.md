# Phase 2 Wave 5 focused Sol ruling — persisted JSON byte order

Independent **read-only** ruling in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Do not edit, commit,
or push. Read the onboarding, amended Phase 2 brief, full `PORT_STATUS.md`,
the current Wave 5 diff, exact TypeScript producers/read surfaces, full Sol
review `20260725-004420-0487da`, and full Copilot-Fable review
`20260725-004424-e16b24`.

Fable independently runtime-proved two pre-existing serialization-order
divergences now exercised by Wave 5:

1. `DerivationMetadata` persists fixed Rust struct order, but TypeScript
   persists each producer's object insertion order. Your full review already
   independently proved this finding.
2. Public `Derivation` serialization emits Rust declaration order
   `state,content,reason,sourceVersion,...`; TS `toDerivation` creates
   `state,sourceVersion`, then conditionally appends `content` or `reason`,
   followed by optional `gaps`, `metadata`, `derivedAt`. Fable observed the
   difference in paired real-runtime `JSON.stringify` output.

Give a focused ruling:

- Is finding 2 real and uniquely forced by the TS/runtime contract?
- Does correcting it require a frozen public-shape amendment, or can a custom
  `Serialize` implementation preserve the public Rust fields/types and only
  repair the existing wire contract?
- For agreed metadata finding 1, does this exact Amendment G evidence design
  satisfy the persisted-byte amendment rule without moving the frozen
  inventory: commit a Node generator plus JSONL oracle under
  `packages/lhc-rs/scripts/` and `packages/lhc-rs/fixtures/`, and extend the
  already-counted private
  `turns::internal::derive::tests::turn_work_handlers_kinds_and_insertion_order`
  test to conformance-check every distinct producer order from that fixture
  (no new `#[test]`)?
- If finding 2 is forced, should the same generator/fixture and existing test
  cover its ready/failed/blocked wire-order branches under Amendment G?

Check the actual persistence/serialization call sites and identify any
producer omitted from the proposed matrix. Return concise findings and an
explicit **APPROVE / REJECT / AMEND** ruling. Clean up every artifact you
create and report cleanup.
