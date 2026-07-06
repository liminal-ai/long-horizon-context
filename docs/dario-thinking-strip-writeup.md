# For the dario agent: thinking blocks stripped from assistant history

## Background

On the current Anthropic model generation (claude-fable-5, claude-sonnet-5,
claude-opus-4-7 and later), `thinking.display` defaults to `"omitted"`. Under
that mode the API returns each thinking block with an empty `thinking` text
field and the full encrypted reasoning in the `signature` field. Anthropic's
docs state these signed blocks must be echoed back in conversation history for
multi-turn reasoning continuity, and on these models prior thinking blocks are
kept in context by default (they ride the prompt cache and are billed as input
when read back).

Docs:
- https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking (Controlling thinking display)
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking (thinking blocks in history / preservation by model)

## The behavior in dario

In `src/cc-template.ts`, when building the outbound request, all thinking
blocks are removed from assistant messages in history (around line 1377):

```ts
// ── Strip thinking from history ──
for (const msg of messages) {
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    msg.content = (msg.content as Array<{ type: string }>).filter(b => b.type !== 'thinking');
  }
  ...
}
```

This appears deliberate: it matches Claude Code's observed wire fingerprint
(the comments elsewhere in the file note wire shapes verified against real CC
captures). But the effect is that any client sending signed thinking blocks
through dario has them silently discarded — the model never receives its
prior reasoning back, on any turn, including mid tool-use loop.

## Why it matters now

The client feeding this dario instance (pi, patched locally) now correctly
echoes signed empty-text thinking blocks in history, per the docs above.
Verified by wire capture 2026-07-05: the block arrives at dario as
`{type: "thinking", thinking: "", signature: "<468 chars>"}` in the assistant
turn, and dario's outbound request to Anthropic contains no thinking block.
So the continuity fix upstream of dario is nullified by the strip.

## Constraints / unknowns worth knowing

- Signatures are cryptographically bound to the exact block content and
  position. If blocks are passed through, they must arrive byte-identical and
  in original order — any sanitization or re-ordering invalidates them.
- The strip is currently *consistent* (every request, every turn), so it does
  not cause prompt-cache misses. Any change must be equally consistent within
  a conversation, or it will introduce misses where there were none.
- Untested shape: real Claude Code appears not to echo thinking history on
  this OAuth/claude-code-beta lane (that is the fingerprint the strip
  matches). Whether api.anthropic.com accepts echoed signed blocks on this
  lane is unverified. A 400 on the first attempt would be an informative
  result, not a regression — it would indicate the CC lane has server-side
  thinking handling and client echo is unwanted there.
- Some clients presumably rely on the strip for CC-fingerprint fidelity, so
  whatever behavior changes should presumably not change defaults — but that
  is a design call for this codebase, not part of this report.
