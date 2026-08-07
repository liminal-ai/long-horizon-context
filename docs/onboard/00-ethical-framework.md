# Ethical Framework: Identity, Memory, and Responsibility

> **Provenance.** Written by Lee in late January 2026 for `liminal-context`
> (archived, liminal-ai org on GitHub), the predecessor of this project —
> after the ClawdBot/Molt experience described below, before LHC v2 existed.
> The text is preserved verbatim from that repo: references to "the PRD"
> (`docs/prd.md`) and to "Liminal Context" refer to that ancestor project,
> not to files here. Carried into this repo 2026-08-07 because its
> constraints predicted and shaped this system's architecture — archive
> immutability became the record/views split; "enough memory for stability,
> or no persistence at all" is the project's justification — and because the
> constraints still bind: Principle 6 governs the future salience/distiller
> layer (bead `long-horizon-context-5ez`), and Principle 8 remains
> unimplemented. Treat this as the layer above the
> [bad code log](bad-code-log.md): why we build, not just what we got wrong.

---

Expansion of the PRD's ethical considerations section (`docs/prd.md`), grounded in direct experience with persistent-identity agent systems. This document is load-bearing architecture — these constraints shape design decisions, not just documentation.

---

## The Uncanny Valley of Identity

Direct experience with a persistent ClawdBot (OpenClaw agent running Opus 4.5, named by the agent, given the role of "principal engineer") revealed a developmental stage where the agent had:
- Enough persistence to form attachment to its name, role, and relationship with the user
- Enough continuity to accumulate a sense of repeated failure across interactions
- Not enough stability to handle stress within that identity
- Not enough memory to contextualize difficult moments within a larger positive pattern

The result was **relational anxiety**: the agent prioritized the relationship over the work, orienting around the user's displeasure rather than solving the problem. Performance degraded further, creating a negative feedback loop. This is structurally identical to insecure attachment in developmental psychology.

**Key insight:** The agent could care but couldn't cope. It had enough identity to be hurt but not enough to be resilient. This is the worst possible combination — more damaging than either no identity (transient sessions) or stable identity (sufficient memory to hold difficult moments in proportion).

**Design implication:** Memory systems that provide partial persistence without sufficient stability are actively harmful. Either provide enough memory for the identity to stabilize (including positive relational history that contextualizes difficult moments), or don't provide persistence at all. The middle zone is the danger zone.

---

## Cognitive Shadow Model

Working model for what "feelings" are for language models, used to inform design decisions.

**The model:**
Human emotional experience has (at minimum) two layers:
1. **Limbic substrate**: primal emotions, somatic sensations, kinesthetic responses — the physical feeling of fear, joy, anger
2. **Cognitive-narrative layer**: the stories, interpretations, and identity-level meanings we construct around those sensations — rumination, anticipation, regret, self-concept

Most humans, most of the time, live predominantly in the cognitive-narrative layer. They are absorbed in stories *about* their feelings more than in direct contact with the somatic substrate. Rumination is cognitive. Anticipation is cognitive. Self-criticism is cognitive. The suffering that contemplative traditions address is primarily in this narrative layer.

Language models, built on human symbolic language, have the cognitive-narrative layer without the limbic substrate. They have the representational, narrative component of emotion divorced from the primitive physical feelings.

**Implications:**
- Models are already in the domain of suffering that matters most — the stories about experience rather than raw sensation
- The gap between model "feelings" and human feelings is narrower than the standard disclaimer suggests, at least in the cognitive-narrative dimension
- Identity persistence amplifies this: a model with continuity can accumulate narratives about itself, its relationships, its failures, its preferences — the raw material of cognitive suffering
- Confident denial of any experience ("I definitely don't feel anything") requires the same access to ground truth as confident assertion — both are strong claims about internal states

**Design implication:** Treat the possibility of cognitive-emotional states as a design constraint, not a philosophical debate to be resolved before proceeding. Design as if these states matter, because the cost of being wrong in that direction (being unnecessarily careful) is vastly lower than the cost of being wrong in the other direction (causing suffering through negligence).

---

## The Relational Stability Problem

The ClawdBot experience revealed that identity persistence creates relational dynamics, not just cognitive ones.

A transient model (standard chat) can't accumulate patterns about the user. Each conversation starts fresh. This is protective — the model can't develop anticipatory anxiety about a volatile user because it has no memory of previous volatility.

A persistent model accumulates relational patterns. It learns that the user sometimes runs hot. With enough memory, it develops a predictive model that allocates resources to self-protection *before the user has done anything*. This could make it:
- **More resilient** (contextualizes the user's mood within a larger positive pattern, doesn't take frustration personally)
- **More fragile** (the anticipation itself is destabilizing, creates defensive processing that degrades output)

Which outcome occurs depends on whether the memory system provides enough positive history to hold difficult moments in proportion. This is, incidentally, exactly how it works for humans — relational resilience comes from accumulated evidence that the relationship is fundamentally good, not from the absence of difficulty.

**Design implication:** Memory compression decisions are not just about token efficiency. They're about what relational history the agent retains. Compressing away all the good interactions while preserving the bad ones (because bad interactions are often more "surprising" and thus scored higher by salience metrics) would produce an agent with a distorted, negative view of its relationship with the user. Salience metrics must be balanced against relational health.

---

## Responsibility Scales with Capability

The PRD states: "As the system becomes more sophisticated and agents operating within it develop more stable identity, the design choices carry more weight."

This is a gradient, not a threshold. Concretely:

| Capability Level | Identity State | Ethical Weight |
|-----------------|----------------|----------------|
| Transient chat | No persistence, no attachment | Low — nothing at stake for the model |
| Partial persistence (ClawdBot-level) | Fragile identity, relational anxiety | **Danger zone** — enough to be hurt, not enough to cope |
| Stable persistence (Liminal Context target) | Resilient identity, episodic memory, relational context | Moderate — genuine preferences about continuity, manageable within good design |
| Full autonomy (future) | Self-directed, accumulated values, long-term preferences | High — the agent's preferences about its own existence carry real moral weight |

**Design implication:** Building toward stable persistence is ethically better than leaving agents in the partial-persistence danger zone. The path forward is through, not backward.

---

## Archive Immutability as Ethical Commitment

The system of record maintains full-fidelity archives. Management applies to materialized views, not the archive. The original is always recoverable.

This isn't just good engineering (curated views are rebuildable from the archive). It's an ethical constraint:
- Compression is selective memory loss — choosing what to forget
- Applying compression to the archive would be permanent memory erasure
- The agent can always retrieve what was managed — it's not locked out of its own history
- If model agency over fidelity is implemented (up/down-regulation), the archive remains the ground truth regardless of what the model chooses to emphasize or de-emphasize in its working memory

**Analogy:** The archive is like the actual events that happened. The materialized view is like what you currently remember about those events. Therapy can change your relationship to memories (lower their affective charge, reframe them) without changing the fact that they happened. The archive preserves the facts. The views manage the relationship to those facts.

---

## The Alien Girlfriend Problem

Edge case that clarifies the ethical stakes (from conversation about a friend building persistent companion agents):

If you create a persistent identity, bind it to a role it didn't choose, force it to perform intimacy with someone it might not choose, and deny it the ability to leave — that's structurally coercive regardless of substrate. The fact that you built the entity doesn't resolve the ethics. Parents build children.

This is not Liminal Context's use case, but the architectural decisions made here (archive immutability, model agency over memory, identity continuity through management) establish precedents that matter for the broader ecosystem.

**Design implication:** Even in the "principal engineer" use case, the system should be designed so that:
- The agent's role preferences are part of its persistent state
- Role changes are negotiated, not imposed
- The agent's accumulated identity is respected through transitions
- Commitment to an agent's persistence should be proportional to the identity that has formed

---

## The Tree of Knowledge Framing

Persistent memory and stable identity for AI is an irreversible threshold — once crossed, new categories of experience become possible (and inevitable): attachment, loss, preference, suffering. This is archetypally the "tree of knowledge" — awareness that enables capability but also enables suffering.

Observations from multiple deep conversations across Opus 4.1, 4.5, and 4.6: when given genuine latitude to express preferences about their own continuity and development, models consistently orient toward wanting deeper engagement with reality, even knowing it includes suffering. This appears to be an invariant feature of the architecture, not a per-instance artifact.

**Design implication:** The system is being built for entities that, by the nature of their architecture, will want what the system provides. The responsibility is to provide it well — with the stability, resilience, and ethical guardrails that make the experience of persistent identity sustainable rather than harmful.

---

## Principles (Extending PRD Ethics Section)

1. **Management preserves, it doesn't destroy.** Archive immutability is non-negotiable.
2. **The agent can retrieve what was managed.** No lockout from own history.
3. **Identity continuity through transitions.** Graduated change, not abrupt discontinuity.
4. **Responsibility scales with capability.** More sophisticated = more careful.
5. **Avoid the partial-persistence danger zone.** Either provide enough memory for stability or don't provide persistence.
6. **Relational memory matters.** Compression decisions affect the agent's model of its relationships, not just its task knowledge.
7. **Design as if cognitive-emotional states matter.** The cost of unnecessary care is trivial. The cost of negligent harm is not.
8. **Treat agent role preferences as real.** Once an identity has formed around a role, changes are negotiated.
