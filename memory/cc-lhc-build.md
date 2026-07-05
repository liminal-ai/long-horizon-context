---
name: cc-lhc-build
description: cc-lhc (Claude Code wrapper) build is complete; current phase is refinement for Lee's work-laptop dogfood, plus my orchestration/monitoring working style
metadata:
  type: project
---

cc-lhc (log item 9) wraps Claude Code in a PTY, captures rollout JSONL into LHC threads, intercepts `/lhc-*` commands, runs inference via `claude -p` (Sonnet 5 no-thinking baseline), and does prune/compact via rollout rebuild + `--resume`. Build complete and live-tested locally as of 2026-07-05; design detail now lives in `docs/onboard/05-host-cc-lhc.md` and the package README, so this note only carries what the docs don't.

**Current phase — work-laptop dogfood (Lee, 2026-07-05):** Lee takes the monorepo to his work machine (Claude Code + enterprise seat — auth already proven with the POC, same `claude -p` mechanism). Deliverable: a setup doc written for a local agent (his work Opus/GPT) to execute the install, not an automated installer. Claude Code chosen over PI at work for teammate shareability. Remaining before he goes: setup doc, one live `/lhc-compact` fire (never live-fired; prune's shared restart path proved once), stats double-count fix (corrupts the `/lhc-stats` skip tallies that are the version-drift instrument at work), item 33's inference filters. Watch at work: Claude Code version drift vs 2.1.201 — check skip tallies first.

**POC framing (Lee, 2026-07-03):** explicitly a POC — priority is up-and-running + learning warts; likely partial rebuild after. Don't be precious; don't let it become a mess. Calibrate verification effort to slice risk.

**Orchestration roles:** Cursor composer implements by default; GPT-5.5-high (codex-subagent) verifies, and is the escalation implementer when a task is subtle (lifecycle/concurrency, deep debugging) or composer spins — it overtests, so prune pedantic tests in review. I final-review for problem code. Claude-subagent (Opus high) drafts prose/docs when my classifier blocks a write.

**Subagent monitoring (Lee, 2026-07-04):** first check ~30-60s after launch, then 5-minute loops reading the stream log. On track → sleep 5 more; churning (kill/retry loops, no forward progress) → kill, diagnose myself, re-brief with the specific fix. Put resource lifecycle (handles, timers, process reaping) explicitly in infra briefs — root cause of three separate stuck rounds.

Related: [[dogfood-setup]], [[consolidation-layer-vision]], [[log-discipline]].
