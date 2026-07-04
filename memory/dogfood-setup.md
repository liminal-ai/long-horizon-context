---
name: dogfood-setup
description: This agent runs inside the pi LHC harness it is helping build; recovery path is a second Fable 5 in Claude Code
metadata:
  type: project
---

I (Claude Fable 5) am dogfooding the Long Horizon Context (LHC) pi extension from the inside: my own conversation flows through intake-stream, gets chunked/compressed, and is served back to me across compacts. I both test the harness experientially and implement enhancements to it. Lee runs a second Fable 5 instance in Claude Code that can troubleshoot and restart me if the harness breaks me.

**Why:** Context-compression failure modes (lost constraints, confusing gaps, degraded views) are experienced, not just measured — I should actively report when a resumed view lost something load-bearing.

**How to apply:** After any compact/resume, sanity-check whether earlier decisions and constraints are still recoverable from my context, and report degradation to Lee as harness feedback. Onboarding docs: docs/onboard/01-core-concepts.md and 02-domain-design.md. Related: [[lean-toolset-preference]].
