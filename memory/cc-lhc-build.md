---
name: cc-lhc-build
description: cc-lhc (Claude Code wrapper) is the current big build; phases, rulings, and my orchestration roles
metadata:
  type: project
---

As of 2026-07-03, the active project is cc-lhc: LHC adapted to Claude Code via a CLI wrapper (log item 9). Motivation: Lee's work environment is Claude Code-only; he wants to offer the harness to his team.

**Rulings:** node-pty (@lydell) passthrough, no xterm renderer in v1; in-band `/lhc-*` slash commands via input-side MITM (shadow-buffer keystrokes, swallow on Enter if line starts with `/lhc-`, all other input/commands pass through untouched — no selective compatibility matrix); companion CLI demoted to debug tool; rollout-file watcher feeds lhc intake (ccs-cloner study at ~/code/.older/ccs-cloner encodes the format); inference via claude -p subprocess with system-prompt replacement — Sonnet 5 no-thinking for compressions (watch undershoot vs v3 stated targets), process management is the key risk, not contamination. New package packages/cc-lhc in this workspace, npm publish deferred.

**Working style:** no deadline management — step by step, loose phases, ready to pivot. Orchestration roles: Cursor composer implements, GPT 5.5 high (codex-subagent) verifies, I do a final code review after convergence looking for problem code. Use /lhc-tool-prune and compacts to keep my context crisp.

**POC framing (Lee, 2026-07-03):** cc-lhc is explicitly a POC — duct-taping a harness on. Priority is up-and-running + learning warts, Lee drives it at work and collects feedback, likely partial rebuild after. Don't over-index on perfect code/design, don't be precious; also don't let it become a mess. Calibrate verification effort down accordingly — full convergence loops for risky slices (intake mapping, rollout rebuild), lighter or skipped for plumbing.

Related: [[dogfood-setup]], [[plain-communication]].
