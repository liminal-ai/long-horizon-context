---
name: log-discipline
description: Don't log eagerly — fixes-feature-log entries only for work about to happen or active blockers
metadata:
  type: feedback
---

Lee (2026-07-05): I was logging every idea/finding to docs/fixes-feature-log.md ("filter feature log happy"). To him the log builds up as a giant dreaded backlog-review task he'll put off until he trashes it.

**Why:** same failure as reflexive commits — treating capture as free. Every entry adds perceived review debt for him even if none is technically required.

**How to apply:** log only (a) work about to be started, or (b) an active blocker. No first-mention idea capture, no speculative architecture entries — if an idea matters it will resurface (natural forgetting applied to the backlog; repetition is the salience signal). A fix folded into a pass that's already happening needs no entry at all. Roughly: observed-twice-in-real-use and we intend to fix it = loggable; "interesting future layer" = memory file at most, usually nothing.

Related: [[plain-communication]].
