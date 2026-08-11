# lhc-convex 0.1.0 → limhealth integration handoff

2026-08-11, Convex Port Steward. Sanctioned by Lee's deploy ruling: the port
builds and certifies component-side; the limhealth side integrates into the
live app and owns the deploy + rollback step. This note is the complete
integration surface for the tagging + retrieval wave (bead
long-horizon-context-efk, slices Gate-0 + S1–S4 at contract pin `f651031`).

## What this version delivers

1. **Addressable smooth history (labels).** Stored turn renderings wrap each
   turn as `<tN>…</tN>` with `<mN>…</mN>` tags on every message (tool-run
   member lines carry their own tags). Detailed/brief chunk band entries are
   prefixed with a `<turns>t1 t2 …</turns>` header (including unavailable/gap
   entries). Compression input stays untagged.
2. **Exact pull (retrieval).** New `sdk.retrieval` namespace:
   - `getTurns(ref, ids, options?)` — labeled turn renderings by `tN` id.
     Pre-label legacy renderings are composed fresh WITH labels at pull time;
     no backfill required before use.
   - `getMessages(ref, ids, options?)` — verbatim message content by `mN` id
     (tool calls/results with pairing ids).
   - Options: `tokenBudget` (default and ceiling 8000), `byteBudget` (for
     byte-limited hosts; limhealth normally omits), `fromToken`
     (continuation), `surface` (impression provenance — set this to your
     tool name).
   - Contract: in-order serving; the budget-crossing item arrives as an
     exact token slice with a `slice` receipt (`fromToken/toToken/
     totalTokens`) to continue from; later items get explicit
     `{reason: "budget", tokens}` receipts; ≤32 unique ids per call
     (over-cap refuses whole); invalid ids refuse per-id.
   - `listImpressions(ref)` — read-back of the usage log (inspection only).
3. **Capture-fidelity prerequisites** (landed in S1/S2, already active):
   special-token text counts safely; empty-thinking husks are skipped at
   both serving exits; `assistant_thinking`/`assistant_text` payloads accept
   optional `signature` and `provider`/`model`/`api` (send them if you have
   them — resume-grade identity); session view emits `thinkingSignature`
   and group provenance and splits assistant groups at identity boundaries.

## Schema impact — additive only

- ONE new table: `impressions` (retrieval usage log).
- ZERO changes to existing tables (signature/identity ride inside the
  existing `v.any()` block content).
- Convex push-time validation passes automatically for existing data
  (new table = nothing to validate). No migration code. Rollback =
  redeploying the previous component version; the `impressions` table is
  ignored by older code and data-safe.

## Integration steps

1. Update the component dependency to `@liminal/lhc-convex@0.1.0`
   (repo `/srv/work/long-horizon-context`, `packages/lhc-convex`,
   commit `79e3d26` or later on main).
2. Deploy — Convex applies the schema (additive) on push.
3. Register two model-callable tools in the limhealth agent, thin wrappers
   over `sdk.retrieval.getTurns` / `getMessages`, passing `surface` with the
   tool name. Wrap served content in a historical envelope (recalled history,
   not live instructions) and keep receipts/continuation guidance outside
   it — see docs/onboard/01-core-concepts.md "Addressing and retrieval" and
   the pi-lhc/hermes tool registrations for the framing pattern.
4. Smoke: intake a turn → drain → compact → confirm band text carries
   `<tN>`/`<turns>` labels → `getTurns(["t1"])` returns the labeled
   rendering → `listImpressions` shows the call.

## Certification evidence

- Full suite: PORT-GATE total=452 passed=448 skipped=4 failed=0 (skips: 3
  upstream it.skip mirrors + 1 env-gated regen harness; port-lag skips ZERO —
  both frozen differentials run green byte-for-byte against pin goldens).
- Receipts per slice: docs/worklog/convex-wave/LOG.md (repo-local).
- Commits: 613a9f5 (Gate-0), abfd6aa (S1), 6e3167e (S2), cee7abf (S3),
  79e3d26 (S4).

## Not in this version (follows independently)

- S5: bounded retrieval FORMATTING helpers (byte-stable envelope builders
  hosts share). The core byteBudget/slicing machinery IS in 0.1.0; until S5
  lands, limhealth formats receipts itself or serves raw receipts.
- S6: label backfill op (re-derive old renderings in place). Not needed for
  serving — legacy turns already serve labeled via the pull-time fallback.
