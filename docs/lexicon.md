# Lexicon — staging ledger

Newly decided vocabulary lands here at decision time. The durable lexicon is
[onboard/01-core-concepts](onboard/01-core-concepts.md) — terms fold into it
as their designs become full, and leave here. Terms enter when decided, not
while in transit. If a needed term is missing, propose it — don't coin
silently. (Alignment work: bead `long-horizon-context-7gu`.)

## Terms

**agentic turn** — one full cycle from user prompt to final assistant
response, however many model turns it takes. The boundary PI reports at
`agent_end`. Do not call this a "run" or "agent run."

**model turn** — one LLM request/response cycle (a single model step, possibly
with tool calls) inside an agentic turn.

**quick board** (abbrev. **qb** where brevity fits; short form "the board" in
code surfaces like `/board`, `board_post`) — the ephemeral serve-time surface
next to the live prompt where transient content appears: recalled turns and
messages, notices, later memory tickles. Content here is never persisted to
the record; it decays and vanishes unless restated into the transcript. The
quick board is the living surface; the record is the durable one. Named
2026-08-07 (previously "notification board").

**ttl** — turns to live (not time-to-live): how many turns a quick-board
entry survives before it vanishes. Currently counted in completed agentic
turns; the counting unit is under active design review, the term itself is
adopted. Adopted 2026-08-07.
