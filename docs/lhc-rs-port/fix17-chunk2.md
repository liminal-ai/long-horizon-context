# Chunk 2 fix round 17 — five dispositions and a scope gap

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Both acceptance verifiers, in **separate trees**, converged on the same five
rows. Everything else in round 16 passed, including under attack:

- **Inventory is exactly right** — one verifier derived the deletion units from
  the code independently (parsing statement spans across the five fingerprint
  functions) and got **exactly 63, in bijection with the 63 table rows.** No
  missing contribution, no phantom row.
- **The redundancy exemptions survived a real attack** — a 615-item adversarial
  corpus with payloads impersonating every literal the encoder emits (`"n"`,
  `"s"`, `"0"`, `"t"`, `"i"`, `"summary_text"`, …); no collisions. The other
  verifier deleted **all eight count sites simultaneously** and probed with
  empty and multi-element vectors: also no collisions.
- **W2 and W4 pass.** The de-confounded tests hold, `Reasoning.id`, summary
  tag/text and `Find.url` are individually caught, and W4's asymmetry is
  confirmed in both directions — the `push_option_dbg` mutation passes the full
  suite (inert), the same mutation on `push_option_str` fails five tests
  (load-bearing).

**The engineering could not be broken. Five dispositions are wrong.** That is
this round.

---

## X1 [blocking] `pin_tag_x_search` is confounded — one word

`pin_tag_x_search` (`equivalence.rs:1973`) builds its fixture with
`name: "x_search"` — **byte-identical to the kind tag it asserts** — and
`assert_tag_framed` is a `.contains()`. So framing the *name* alone satisfies
the assertion, and deleting the kind tag at line 471 leaves all 131 lib tests
green.

A verifier confirmed the fix: change the fixture's `name` to `"nm"`; the test
then fails on deletion (`130 passed; 1 failed`) and passes with the tag present
(`131 passed`).

**Audit every other tag/literal assertion for the same confound** — a fixture
field that happens to equal the literal being asserted. This is the fourth
instance of a test asserting something another field satisfies; find the rest
rather than fixing only the one that was caught.

## X2 [blocking] Presence bits are *jointly* pinned — the doc forecloses the category

MAPPING.md:470 defines pinned as "a test fails when that contribution **alone**
is removed." For rows **28/30** (`WS.sources`) and **59/61**
(`Reasoning.content`) that is false: deleting **either arm alone** leaves
`None` and `Some([])` distinguishable by the surviving asymmetry in field
count. Deleting **both** arms does fail the test — confirmed for each pair.

So there is a genuine **third category**, and MAPPING.md:427 explicitly denies
one exists. Fix both the labels and the definition:

- Re-classify these four as **jointly pinned**, naming the pair.
- Add a **pair-deletion test** per pair, so the joint property is guarded
  rather than merely asserted.
- Update the taxonomy at :427 and :470 to admit three dispositions —
  **individually pinned**, **jointly pinned** (with the pair named), and
  **documented-redundant** — and say precisely what each means.

Do not collapse this by deleting one arm of each pair to force an individual
pin. The pair is the load-bearing unit; encode the truth rather than reshaping
the code to fit a two-category doc.

## X3 [major] Seven `push_str` kind tags are outside the accounting scope

The 63-unit definition covers `push_framed` / `push_option_*` only, so seven
`out.push_str(kind_tag)` contributions are **excluded from the table** — and a
verifier found **one of them survives the whole suite**.

Defensible under the literal wording "framed contribution", but it means the
table is **not a complete account of what enters the fingerprint**, which is
what a reader will take it for. Bring them into scope: extend the accounting to
every contribution that reaches the fingerprint string, give each a disposition,
and pin the survivor. Report the new total.

---

## Standing requirements

Break-watch-restore with captured output for every new or changed test. Full
suite counts, both fmt gates, `--all-targets` clippy attributed. Vendored port,
capture tee and dedup semantics untouched.

## Report

Position against the full project. Lead with X2 — the three-category taxonomy,
the pair-deletion tests, and the corrected MAPPING.md text. Then X1 with the
audit of every other literal assertion, and X3 with the extended accounting and
its new total. State the survivor count of a fresh full sweep: it should equal
the documented-redundant count exactly, with **zero** rows surviving that claim
to be pinned.
