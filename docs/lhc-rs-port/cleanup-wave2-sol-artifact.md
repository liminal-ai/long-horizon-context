# Sol verifier cleanup — exact interrupted-run artifact

You are the cleanup continuation for Sol verification run
`20260724-172411-def27b`. That run created the isolated disposable directory
`/tmp/lhc-r2-reverify.eT0Hg8` (currently about 13 GiB) and the wrapper exited
before cleanup.

Confirm that exact path exists and contains the isolated `lhc-rs` copy/target
from that run, then remove **only** `/tmp/lhc-r2-reverify.eT0Hg8`. Do not edit
or delete anything in `/srv/work/long-horizon-context`, do not touch any other
`/tmp` path, and do not commit or push. Verify the exact directory is absent
afterward and report the result. Do not request user input.
