# Chunk 3A fix round 5 — the AB1 test does not pin the call site

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

The AB1 **fix is correct** and I verified it at source rather than from the
report: both generation bumps happen while holding the registry mutex
(`capture.rs:470`, `capture.rs:486`), and `lookup_session_snapshot` reads the
generation while still holding that same lock (`capture.rs:512`). The
`(generation, handle)` pair is therefore atomic by construction. The choice of a
locked snapshot over gen-first-retry was the right one, and the unregister
analysis correctly grounds `is_closed()` in tokio's channel guarantee rather
than incidental behaviour.

**The test does not protect it.**

---

## AC1 [blocking] `ab1_refresh_snapshot_atomic_keeps_mid_session_on` cannot fail on the defect it was written for

I reverted `refresh_binding` to the exact pre-AB1 two-observation assembly:

```rust
let handle = crate::capture::lookup_session(&self.session_id);
let generation = registry_generation();
```

That is the defect both verifiers proved, restored verbatim. Result:

```
test tests::ab1_refresh_snapshot_atomic_keeps_mid_session_on ... ok
test result: ok. 151 passed; 0 failed; 0 ignored
```

**The whole lib suite passes with the race reintroduced.** Not just AB1 — all
151. I restored the file byte-identically afterwards (md5 verified) and the
tripwire is green.

### Why it cannot fail

The test switches behaviour with `set_snapshot_racy_for_test`, which toggles a
branch **inside `lookup_session_snapshot`**. So it compares "atomic snapshot
helper" against "racy snapshot helper" — a true and useful property, but not the
one at issue. It never varies **how `refresh_binding` assembles its pair**, so
rewriting that call site back to two separate observations leaves every
assertion satisfied.

This is the same class the project has hit repeatedly: a test that proves the
mechanism it simulates rather than the code path that ships. It is worth stating
plainly that the AB1 evidence in the last report — the racy-vs-atomic event
counts — is real but is evidence about the helper, not about `refresh_binding`.

### Requirement

**A test must fail when `refresh_binding` assembles `(generation, handle)` from
two separate observations.** Pin the call site, not a simulation of it.

The most direct route is to stop making a two-observation assembly expressible:
if the only way to obtain a generation for caching is from
`lookup_session_snapshot`, the defect cannot be written. Consider making the
pair a type the cache requires — e.g. `refresh_binding` accepts only a
`RegistrySnapshot { generation, handle }` produced under the lock, with no
public path that yields a bare `registry_generation()` suitable for caching.
A compile-time impossibility beats a runtime assertion.

If you keep a runtime test instead, it must observe something only the atomic
assembly produces. `registry_lookup_count()` will not separate them — both
orderings take one lock. A lock-ordering or interleave hook placed at the
**`refresh_binding` call site** would, since the two-observation form has a
window the snapshot form does not.

Whichever you choose: **revert `refresh_binding` to the two-observation form,
run your new test, and paste the verbatim failure.** If it passes, the test is
not done. Then restore and confirm the suite is green.

### While you are there

Audit the other tests added in rounds 3–4 the same way — AA1's counter
assertion, and the Y1 probes. For each, state what you broke, and paste what
the suite printed. I verified AA1 myself this way and it genuinely fails
(`registry_lookup_count=1000 (want 0)`), so that one is known good. The Y1
probes I have not broken.

---

## Report

Position against the full project. Lead with the mechanism that makes the
defect unwritable or the test that catches it, plus verbatim
break-watch-restore output for AB1 and for each round 3–4 test you audited.
Confirm hooks 6/6, no seventh touchpoint, vendored port untouched, and give
full suite counts with both fmt gates and `--all-targets` clippy attributed.
