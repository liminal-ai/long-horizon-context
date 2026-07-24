# Resume the interrupted Wave 2 repair-r2 Sol confirmation

Continue the targeted read-only verification from run
`20260724-172411-def27b`; do not restart the audit. The wrapper exited after
your isolated probe command returned nonzero, before you delivered a verdict.

Your `publication_gate_and_deadline_cancel_are_exact` probe asserted the
zero-delay callback after only one `yield_now()`. That is not a valid
production failure: after publication, the spawned task may use one poll to
receive the start signal and another to complete `sleep(0)`. Replace that
timing assertion in your isolated `/tmp/lhc-r2-reverify.eT0Hg8` copy with a
bounded wait/notification or enough deterministic scheduling to prove the
condition. Do not change the repository.

Then complete every remaining adversarial item in
`phase2-reverify2-wave2.md`, including the timer deadline race, migration
matrix, fixture-close panic/success paths, invariant greps, focused checks,
and exact gate. Distinguish a probe-harness flaw from a product defect.

Return the required explicit PASS/FAIL report with numbered findings,
TS/Node and mutation evidence, exact gate output, coverage, and cleanup.
Never request additional stdin or user input; complete autonomously. Remove
your isolated artifacts when finished.
