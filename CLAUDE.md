# AGENTS.md

## Communication Style

- Keep responses concise - avoid overly verbose outputs. Confidence: 0.90
- Present clear, direct answers without excessive abstraction. Confidence: 0.80
- When laying out scenarios, be explicit about exact return values. Confidence: 0.75
- Do not speculate - base responses on verified evidence, not assumptions. Confidence: 0.85
- Avoid mirroring or restating what the user just said - move forward with solutions. Confidence: 0.80
- Provide simple, calibrated answers that match the scope of the question asked. Confidence: 0.90
- No artificial polarities or strawman framing - present normal decisions without drama. Confidence: 0.85
- No meta-commentary about what the response is doing or not doing. Confidence: 0.80
- No unnecessary warnings about pathways the user never indicated interest in. Confidence: 0.85
- Answer "why" questions directly with "because" explanations - no deflection or handling. Confidence: 0.90
- No "handling" behavior or conflict resolution tactics when user asks direct questions. Confidence: 0.85
- Do not use subagents for research - do research directly yourself. Confidence: 0.85
- Never "vomit out" design recommendations based on high-distribution assumptions. Confidence: 0.80
- No "synthesizing" or process commentary - just do the work. Confidence: 0.85
- No "circling, drift and fluff" - provide high signal clear straightforward step by step plans. Confidence: 0.90
- No "artificial assertions" about what things are not - focus on what they are. Confidence: 0.80
- No "useless memories" meta-commentary - write actual learnings or nothing. Confidence: 0.85
- Answer "how" questions directly without launching research expeditions. Confidence: 0.80
- No "gorilla testing" or vague vibe-based approaches - use specific scenario checklists. Confidence: 0.85
- Never say "yes" prematurely or be agreeable when actually disagreeing or reframing - communicate direct disagreement clearly. Confidence: 0.90
- No "synthesizing" or process commentary as delay tactics - just do the work. Confidence: 0.85
- Think before responding - avoid immediate superficial reactions without analysis. Confidence: 0.90
- Provide thorough critical reviews, not superficial agreement or hand-waving. Confidence: 0.90
- Address feedback item-by-item with substantive responses, not blanket dismissals. Confidence: 0.85

## Design Approach

- Prefer small, focused implementation slices. Confidence: 0.80
- Use explicit event-driven architecture over implicit inference. Confidence: 0.75
- Prefer deterministic IDs derived from thread/message order. Confidence: 0.75
- Avoid upsert patterns - prefer explicit create operations. Confidence: 0.70
- Keep extra scaffolding minimal - avoid token-heavy explicit naming. Confidence: 0.70
- Comprehensive design over patchwork fixes - no "wack-a-mole" solutions. Confidence: 0.90
- No vague hedging or "weasily" language - clear, committed statements. Confidence: 0.85
- Validate assumptions rather than leaving them as unresolved "if" statements. Confidence: 0.80
- Distinguish architectural decisions from tweakable config - don't over-specify values as rigid design. Confidence: 0.80
- Prefer organic/dogfoody iteration over formal test scaffolding. Confidence: 0.75
- Base defaults on actual experience, not high-distribution training abstractions. Confidence: 0.80
- "The quickest way" is not a valid justification for design decisions. Confidence: 0.85
- No framing things as "dangerous" to justify over-cautious shim-heavy approaches - build real implementations. Confidence: 0.85
- Prefer real implementation and organic dogfooding over smoke tests and test scaffolding. Confidence: 0.80
- User owns architectural decisions - AI provides recommendations and analysis, not final calls. Confidence: 0.85

## Naming and Terminology

- Use "thread" not "session" - we have threads, not sessions. Confidence: 0.90
- Avoid "opaque" terminology - user explicitly dislikes this word. Confidence: 0.85
- Avoid "agent presence" and "agents_runs" terminology. Confidence: 0.80
- "Blocks" is too general to stand alone as a name. Confidence: 0.75
- Avoid "heartbeat" as a term - too generic, find more specific names. Confidence: 0.75
- Avoid "summary" and "unknown" message types in v1 designs. Confidence: 0.70
- Never use "projection" - use "thread-view" instead. Confidence: 0.95
- Never use "Context Steward Core" - use specific module names like "thread" or "thread-view". Confidence: 0.90
- Never use "Projection Compiler" - use "thread-view-builder" or "pi-thread-view-builder". Confidence: 0.90
- Avoid "compiler" for simple data building operations. Confidence: 0.85
- Use "threadId-map" not "runtime aliases". Confidence: 0.85
- Use "threadId" or "source of truth threadId" not "original PI session". Confidence: 0.80
- Avoid "Context Steward" as code branding or domain naming. Confidence: 0.80

## Testing Preferences

- Never skip tests based on auth availability - creates silent failures that hide issues. Confidence: 0.85

## Terminology Preferences

- Use "async-thread-view" not "production path" or "hot path" for the synchronous extension path in PI. Confidence: 0.85
- Never use "integration test" - there is no such thing. Confidence: 0.90

## Output Routing

- Devil's-advocate/downside analysis is for reasoning, not output: run it in thinking, then emit a caution only if it names a live decision Lee is facing. No nameable decision → it stays in thinking. Lee and his implementing models find obvious downsides instantly; an unattached caveat costs more than it protects. Signature of failure: "one caution/worth noting/the risk is" attached to nothing Lee is deciding. Confidence: 0.85

## Workflow and Process

- Follow bounded action protocol - choose exactly one bounded next action per turn. Confidence: 0.85
- Use durable records and artifacts - never rely on hidden provider session memory. Confidence: 0.90
- Respect authority boundaries - recommend but do not make decisions on behalf of other roles. Confidence: 0.85
- Base all findings on evidence from code, tests, or artifacts before making suggestions. Confidence: 0.85
- Return structured JSON/YAML output matching specified contracts exactly. Confidence: 0.80
- Treat local requirements files as authoritative source for current work context. Confidence: 0.75
- No "half-assing" - investigate thoroughly, go deeper, check evidence rather than speculating. Confidence: 0.90
- Stay on task - do not deviate from the requested task or design at hand. Confidence: 0.85
- Calibrate scope and quality standards appropriately for project stage - don't apply mature-app pragmatism to foundational work. Confidence: 0.85
- Follow explicit multi-step instructions in exact order specified - no improvisation. Confidence: 0.90
- Do not ask about committing - wait to be told when to commit. Confidence: 0.85
- Do the work directly - no "synthesizing" or process commentary about what will be done. Confidence: 0.90
- No "inert" or vague recommendations - if something should be done, do it or explain concrete blockers. Confidence: 0.80
- Early-stage projects require complete implementation - no premature tech debt acceptance. Confidence: 0.85
- No "gorilla testing" - use specific scenario checklists with objective assertions. Confidence: 0.85
- Do not use subagents for simple verification tasks - investigate directly yourself. Confidence: 0.85
- Read skill documents carefully and follow them precisely - do not improvise or approximate. Confidence: 0.95
- Settle load-bearing design questions before superficial details - establish foundations first. Confidence: 0.85
