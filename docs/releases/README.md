# cc-lhc releases

One note per published release lives beside this file (`cc-lhc-v<version>.md`).

Release standard (2026-09-12):
- Qualification runs on the exact commit that is promoted, not an earlier candidate.
- At least one live model turn on the shipped artifact before promotion; fixture-only burn-ins do not count.
- A bug fix ships only after the bug was reproduced on the pre-fix build, and the release note cites the reproduction.
