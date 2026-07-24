# pi-session-structure.jsonl — provenance

Structure-trimmed from a **real** PI session file (story Anti-Shim
Requirements: the fixture must come from PI's own output, never hand-authored
from the design's description — its job is to catch the design being wrong
about PI, which a design-derived fixture cannot).

- **Source session:** `~/.pi/agent/sessions/--Users-leemoore-code-pi-long-horizon-liminal-context--/2026-06-10T19-16-08-959Z_019eb2f6-a47f-75a3-b98a-8ed1174bc90c.jsonl`
- **Produced by:** PI coding agent `0.79.1` (repo-ref pin `406a2214aa1dce746a1902605daf04e6727349dc`), session format version `3` (`CURRENT_SESSION_VERSION` in `repo-ref/pi/packages/coding-agent/src/core/session-manager.ts`)
- **Trim applied:** header plus the first seven entries kept verbatim
  (covering the `session` header shape, non-message entry kinds, and one
  `message` entry per role — `user`, `assistant`, `toolResult`); every string
  value truncated to 100 characters. No keys added, removed, or reordered;
  no values invented — structure is exactly what PI wrote.
- **Consumed by:** `test/fixtures/pi-session-format.ts`, which derives the
  required header/entry shapes from this file at runtime for TC-5.3/TC-5.5
  conformance checks.
