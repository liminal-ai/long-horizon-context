---
name: cc-lhc-build
description: cc-lhc (Claude Code wrapper) is the current big build; phases, rulings, and my orchestration roles
metadata:
  type: project
---

As of 2026-07-03, the active project is cc-lhc: LHC adapted to Claude Code via a CLI wrapper (log item 9). Motivation: Lee's work environment is Claude Code-only; he wants to offer the harness to his team.

**Rulings:** node-pty (@lydell) passthrough, no xterm renderer in v1; in-band `/lhc-*` slash commands via input-side MITM (shadow-buffer keystrokes, swallow on Enter if line starts with `/lhc-`, all other input/commands pass through untouched — no selective compatibility matrix); companion CLI demoted to debug tool; rollout-file watcher feeds lhc intake (ccs-cloner study at ~/code/.older/ccs-cloner encodes the format); inference via claude -p subprocess with system-prompt replacement — Sonnet 5 no-thinking for compressions (watch undershoot vs v3 stated targets), process management is the key risk, not contamination. New package packages/cc-lhc in this workspace, npm publish deferred.

**Working style:** no deadline management — step by step, loose phases, ready to pivot. Orchestration roles: Cursor composer implements, GPT 5.5 high (codex-subagent) verifies, I do a final code review after convergence looking for problem code. **Model escalation (Lee, 2026-07-04):** composer is the default implementer, but when a task looks hard (subtle lifecycle/concurrency, deep debugging) or composer runs long/spins, escalate implementation to gpt-5.5-high codex — far more competent on hard problems, doesn't spin. Caveat: 5.5 overprotects — overtests, writes pedantic tests (e.g. tests that removed code stays removed); prune silly tests in review. Not first choice for routine slices; it's the top tier for when composer struggles. Use /lhc-tool-prune and compacts to keep my context crisp.

**Subagent monitoring (Lee, 2026-07-04):** for long-running subagent tasks: first check ~30-60s after launch (confirm it started cleanly), maybe once more early, then settle into 5-minute checks (read the stream log — tool calls + last events). On track and not churning → sleep 5 more. Churning (kill/retry loops, repeated failing commands, no forward progress) → unstick it: kill the run if needed, diagnose the root cause myself, re-brief with the specific fix. Don't wait out long timeouts blind. Also: put resource lifecycle (open/close handles, timers, process reaping) explicitly in infra briefs — root cause of three separate stuck rounds.

**POC framing (Lee, 2026-07-03):** cc-lhc is explicitly a POC — duct-taping a harness on. Priority is up-and-running + learning warts, Lee drives it at work and collects feedback, likely partial rebuild after. Don't over-index on perfect code/design, don't be precious; also don't let it become a mess. Calibrate verification effort down accordingly — full convergence loops for risky slices (intake mapping, rollout rebuild), lighter or skipped for plumbing.

Related: [[dogfood-setup]], [[plain-communication]].
