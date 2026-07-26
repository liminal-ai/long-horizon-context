# Cross-language conformance harness (schema v5)

Verifier tooling, run ad hoc at certification — not part of the cargo suite
(gate counts are unaffected; rs-driver is a standalone crate).

Two legs, both required to print BYTE-IDENTICAL:
1. Fresh v5: both drivers `create` from identical adversarial inputs
   (2^53-1, 0.1, 1e21, astral-plane unicode, nested providerUsage, full and
   empty turn_end); `dump_diff.py` masks only the sanctioned variables
   (thread id, server-stamped timestamps).
2. Migration: one TS-built v5 file, `downgrade.py` to v4 twice (cmp-equal
   copies), each port `open`s one copy (production migration path), dumps
   compared. Also assert user_version=5 after.

ts-driver path assumes packages/lhc/dist is freshly built (pnpm build).
