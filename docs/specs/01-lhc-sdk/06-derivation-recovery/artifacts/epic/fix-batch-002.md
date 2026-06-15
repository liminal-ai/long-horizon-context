# Epic Fix Batch 002: Form-to-Derivation Vocabulary Cleanup

## Source

- Review artifact: `artifacts/epic/002-epic-reverify.json`
- Outcome: `needs-fixes`

## Required Fix

### E06-REVERIFY-001: retire remaining production form vocabulary

The epic reverify confirmed that the prior blocking recovery findings are fixed, but production vocabulary still contains form-named APIs/constants/comments under `packages/lhc/src/domains/messages` and `packages/lhc/src/domains/turns`.

Required scope:

- Rename internal production helpers from `form`/`forms` vocabulary to `derivation`/`derivations`.
- Rename internal files where they carry the retired vocabulary.
- Update imports, local variables, and comments in the message and turn domains.
- Preserve literal legacy storage/migration references where they describe historical `derived_form` or `form` database columns.

## Verification

- Run `cd packages/lhc && pnpm run verify`.
- Run `cd packages/lhc && pnpm run verify-all`.
