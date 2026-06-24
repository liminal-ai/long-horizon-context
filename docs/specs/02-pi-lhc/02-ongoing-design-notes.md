# pi-lhc Ongoing Design Notes

## Status

Living notes, not a frozen spec. These notes capture current direction from product/design discussion around the remaining `pi-lhc` work. They are meant to help future agents understand the intent and current questions before expanding epics or implementing slices.

The PRD and tech architecture still provide the broader frame. This document is softer: it names problems, working intentions, and likely next slices without treating them as settled architecture.

## Current Frame

Feature 1 has established the connector foundation: PI traffic can be captured into LHC threads, inference can route through PI provider access, and the extension can initialize LHC as the host. The next broad area is the rest of the core PI/LHC connection: serving LHC thread-view content back to PI, replacing PI's context behavior where needed, and exposing enough operator and agent surfaces to dogfood the result.

Features 2 and 3 in the PRD are a useful boundary for that core work:

- Feature 2 is the serving transition: PI model calls should receive LHC-owned thread-view context rather than relying on PI's native transcript as the source of context.
- Feature 3 is the usability layer around that transition: commands, agent read tools, health, compact receipts, and operator-visible status.

The current intent is to treat those features as one broad core-integration area, then implement it in short, dogfoodable slices. The goal is not to wait for one large epic to be fully specified before Lee can interact with it. Slice 1 has landed: `pi-lhc` registers PI's current `context` hook, serves a minimal replacement from active LHC state, records a context-serving diagnostic, and keeps capture working. Slice 2 has landed: the context hook now serves LHC text messages in order and records a bounded preview for inspection.

## Problems We Are Trying To Solve

### Serving PI From LHC

The central remaining problem is making the PI model loop consume context prepared by LHC. LHC owns the durable thread, derivations, thread-view, compact behavior, and inspect surfaces. PI owns the harness, tools, provider call loop, and its current runtime state. `pi-lhc` should be the adapter between those worlds.

The key questions are practical:

- what exact PI message shape should the context hook return
- which PI message and entry types must be preserved in served context
- how tool calls and tool results should be rendered or carried so PI remains idiomatic
- how mid-turn events stay current during multi-step tool use
- how aborts and partially completed turns appear in served context
- how current PI compaction hooks should be used or redirected
- what runtime state still belongs to PI once LHC becomes the context source

### Fast Feedback While Building

The work needs frequent dogfooding checkpoints. The POC proved the broad idea, but the SDK-backed version needs interactive testing against current PI behavior. Each slice should leave Lee with something he can run, inspect, and react to.

The target shape is:

- small slices that end in a usable PI behavior
- clear verify gates before handoff
- a short explanation of what to try manually
- follow-up slices adjusted from actual dogfooding, not only from the older PRD text

### Packaging And Agent Variants

The eventual package shape may include more than `pi-lhc`. Lee expects a baseline LHC agent, a baseline non-LHC agent, and specialized agents or subagents with different extension/tool/config combinations.

The current direction is to keep capability packages and agent preset packages separate:

- core extensions provide capabilities, such as LHC, web search, service tier, and researcher behavior
- preset packages compose capabilities and config into a named agent
- a thin catalog package can list available scoped agents
- each agent package owns its own help and launch interface

This is not meant to turn `pi-lhc` into a large launcher that owns every variant. The likely direction is a family of scoped npm packages with a shared interface.

## Likely Dogfood Slices

These are working slices, not commitments. The exact boundaries should change if current PI behavior or Lee's dogfooding points somewhere better.

### Slice 1: Context Hook Smoke Path - Landed

Purpose: prove PI can receive context from the extension and that the current PI context hook is the right serving seam.

Delivered:

- register the current PI `context` hook
- return a minimal deterministic message array derived from LHC/thread-view state
- keep existing capture behavior running
- add a plain-data diagnostic seam for the last context-serving attempt
- degrade by returning `undefined` when there is no active LHC session or the context event is malformed, which keeps PI's original messages

This slice is intentionally text-only and narrow. It proves the PI hook and LHC read seam before trying to preserve full PI-native tool semantics.

### Slice 2: Text-Only Served Tail Correctness - Landed

Purpose: make the live tail readable, ordered, current, and useful in real coding turns while still serving text-only PI messages.

Delivered:

- keep LHC `LlmRequestContext` as the serving source
- preserve message order exactly as LHC serves it
- map user messages to PI user string content
- map assistant/context material to PI assistant text parts
- include text renderings of tool calls, tool results, runtime notes, and other material only as LHC already renders them into text
- add a bounded diagnostic preview of the last served context
- test normal, tool-heavy, multi-step, and fallback cases

This slice does not attempt native PI `toolCall` parts. It is meant to make normal coding and first dogfooding possible while keeping the next fidelity question isolated.

### Slice 3: Native Tool Call/Result Serving

Purpose: preserve PI-native tool semantics where LHC exposes enough structure to do so safely.

Likely delivery:

- inspect what LHC currently exposes for tool-call/tool-result identity in served context
- add a narrow LHC serving shape or metadata if needed
- map tool calls to PI `toolCall` parts
- map tool results to PI `toolResult` messages
- preserve correlation by `toolCallId`
- test multi-tool and parallel-tool ordering

This slice should be driven by evidence from Slice 2 dogfooding and current LHC serving shapes. It may stay small if text-only serving works well enough for early use.

### Slice 4: Banded Thread-View Serving

Purpose: serve the real LHC thread-view rather than only a minimal or tail-only shape.

Likely delivery:

- map LHC thread-view bands into PI messages
- keep tail material in record order
- use LHC fallback content when derivations are missing or failed
- avoid waiting on derivation work inside the serving hook
- expose view contents through a small operator or agent-read surface

Lee should be able to inspect whether older context appears at the intended fidelity and whether seams are understandable to the model.

### Slice 5: Manual Smart Compact Path

Purpose: make LHC compact behavior usable during a live PI run.

Likely delivery:

- provide a minimal command to run smart compact
- serve the post-compact thread-view on the next model call
- return a receipt that names what changed, what failed, and what was requeued

Lee should be able to compact mid-session and continue without restarting.

### Slice 6: PI Compaction Redirect

Purpose: prevent PI's native compaction behavior from competing with LHC.

Likely delivery:

- intercept manual PI compact if current PI exposes the needed hook
- redirect the operator toward smart compact or invoke the smart compact path if that becomes the better fit
- verify that bounded served context prevents normal PI auto-compact behavior from altering model-visible context

Lee should be able to use PI without native compaction summaries entering the LHC-served context.

### Slice 7: Core Surfaces

Purpose: make daily use comfortable enough for longer dogfooding.

Likely delivery:

- status command
- health command
- sweep/requeue command
- compact receipts
- materialize/export if still useful after serving is real
- agent read tools for overview, health, message/turn listing, and view contents

Lee should be able to diagnose a thread, recover from common derivation issues, and let the agent ground itself through read-only tools.

## Packaging Direction

The current packaging idea is a scoped family of npm packages. Names below are illustrative, not final:

- `@scope/pi-lhc` or equivalent core LHC connector package
- `@scope/pi-agent-base` for a baseline non-LHC agent
- `@scope/pi-agent-lhc` for Lee's normal baseline LHC agent
- `@scope/pi-agent-researcher`, `@scope/pi-agent-reviewer`, or other specialized presets
- `@scope/pi-agents` as a lightweight catalog/discovery package

The catalog package could expose human and machine-readable discovery:

```bash
npx @scope/pi-agents
npx @scope/pi-agents --json
```

Each agent package should expose its own help and invocation surface:

```bash
npx @scope/pi-agent-lhc --help
npx @scope/pi-agent-researcher --task-file ./task.md --json-report
```

The working intent is that a main agent can learn one interaction pattern for this scoped family, then launch baseline agents or subagents through the same package/interface shape.

## Publishing And Supply-Chain Notes

Because npm supply-chain attacks are an active concern, publishing should be treated as part of the product design rather than an afterthought.

Current direction:

- keep packages under one trusted npm scope
- prefer a monorepo at first so package release logic and dependency policy are centralized
- use npm trusted publishing through CI/OIDC instead of long-lived npm tokens
- enable provenance/attestations on published packages
- keep preset packages thin, with minimal dependencies
- use protected branches/tags and required verify gates before publish
- inspect package contents before publishing
- keep package maintainers minimal

The catalog should not become a mechanism for running arbitrary package names. It should list known scoped packages and expose predictable metadata so human users and agents can understand what they are launching.

## Open Threads

These are not blockers for the next slice, but they should stay visible:

- confirm the current PI `context` hook contract and returned value shape against current PI source
- decide how PI-native tool call/result structure should be represented in served context
- decide whether materialized PI session files remain a core fallback, an export feature, or both
- inventory PI runtime state that matters once LHC serves context
- decide how much package catalog metadata is needed for subagent launch
- decide how strict the shared agent/subagent JSON report protocol should be
- revisit Feature 5 packaging after the core serving path is dogfoodable
