# Chunk 2 fix round 16 — make the pinning claim true

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Round 15's scalar pins are real and verified — a verifier re-ran the deletion
sweep independently and the scalar deletions failed their tests as claimed. U2's
`Option` presence bits are correct. The regression suite is green.

Two things are not true as documented.

---

## V1 [blocking] The count pins do not pin the counts

A verifier re-ran the sweep and found that deleting **only** the count integer
leaves the matching test green for `tool_calls.len()`, `images.len()`,
`summary.len()`, `content.len()`, `sources_count`, and `User.content_count`.
The tests only fail when the integer **and its whole item loop** are removed.
The `Search`/`OpenPage` discriminant tags behave the same way.

So `MAPPING.md`'s "one deletion-proof pin per framed field" is inaccurate for
these. Do **not** fix this by rewording the claim into something vague — an
unpinned field that nobody notices is exactly what U1 was about.

**Answer the real question first, per count site:** *is the count load-bearing
for injectivity at all?*

The elements are individually length-framed and, at some sites, tag-prefixed
(`"summary_text"`, etc.). A count matters when it is the only thing preventing a
**boundary shift** — two different groupings whose framed bytes would otherwise
be identical, e.g. a sequence of N elements followed by another field versus
N−1 elements where the last element's bytes are absorbed by the next field.
Where the surrounding tags are disjoint, the count may genuinely be redundant.

For each count, determine which it is and act accordingly:

- **Load-bearing** → pin it with a **boundary-shift test**: construct two items
  whose element bytes concatenate identically but whose grouping differs, and
  assert different fingerprints. That is a genuine single-property pin, and it
  is the test the round-15 pins should have been.
- **Genuinely redundant** → **remove the field** and say so. A field that cannot
  affect the outcome should not be in the encoding pretending to.

Either way `MAPPING.md` becomes accurate: every framed field is either pinned by
a test that fails when it is deleted, or gone.

Note the verifier's reasoning, which is correct and worth preserving: no two
valid Rust values can differ **only** in a derived `Vec::len()`, which is why a
single-field-difference test cannot pin a count. That is a fact about the test
shape, not a reason to leave the field unverified.

## V2 [blocking] The pin inventory is still incomplete

Framed projections with **no** direct single-field pin:

| Arm | Unpinned projections |
|---|---|
| `System` | `content` |
| `User` | `content_count`; content-part `Text`/`Image` tag and payload |
| `Assistant` | tool-call `id`; plain and tool-assistant `content` |
| `ToolResult` | `tool_call_id`, `content`; image tag and payload |
| `WebSearch` | kind tag, `query`, source `type` / `url`; Find and OpenPage payloads |

These are ordinary varying fields — unlike the counts, each **can** differ
between two otherwise-identical items, so each takes a straightforward pin.

Then enumerate **every** field written by `raw_fingerprint` and show the
complete field → test mapping, with the deletion result for each. The
enumeration is the deliverable; a list that omits a field is the defect this
round exists to close. If the list and the code disagree, the code wins and the
list was wrong.

## V3 [minor] MAPPING.md

Update the Test | Expect table to the true state after V1 and V2: every framed
field pinned by a test that fails on its deletion, with the boundary-shift
tests named for counts and any removed-as-redundant fields recorded as removed
and why.

---

## Standing requirements

Break-watch-restore with captured output for every new test. Full suite counts,
both fmt gates, `--all-targets` clippy attributed. Vendored port, capture tee
and dedup semantics untouched.

## Report

Position against the full project. Lead with V1: for **each** count site, your
load-bearing-or-redundant determination with the reasoning, and either the
boundary-shift test or the removal. Then V2's complete field → test →
deletion-result table. Then V3.
