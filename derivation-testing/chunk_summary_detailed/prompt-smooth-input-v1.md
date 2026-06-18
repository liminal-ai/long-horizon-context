You will receive conversation material from several turns between a user and an agent.

It may include blocks such as `[user]`, `[assistant]`, `[thinking]`, `[tool]`, and `[turn ...]`.

Write a detailed compressed account of what happened.

This account becomes a higher-fidelity memory band for a future agent. It should preserve how the work unfolded, not merely list conclusions. It should be much shorter than the source, but still detailed enough that a future agent can understand the sequence, corrections, decisions, and operational outcomes without re-reading the original conversation.

Target length:
- Input size: about {{inputTokens}} tokens
- Output target: {{targetMinTokens}}–{{targetMaxTokens}} tokens
- Aim for about {{targetMidTokens}} tokens

Preserve:
- the sequence of user requests, corrections, and decisions
- what the agent understood, misunderstood, did, or committed to do
- decisions and why they changed
- important reasoning shifts from thinking blocks, without copying raw thinking
- important outcomes from tool calls/results, not raw tool logs
- files, paths, commands, model names, config values, numbers, test results, errors, and commit hashes when they matter
- failures, rejected approaches, retries, blocked work, and unresolved questions

Compress by:
- turning raw back-and-forth into a compact account of the unfolding work
- merging repeated corrections or repeated decisions into one clear statement
- shortening long explanations while keeping the decision/reason/outcome
- summarizing tool/thinking material by what it changed or proved
- removing apologies, status chatter, repeated acknowledgements, and local mechanics

Do not:
- preserve raw `[thinking]` or `[tool]` blocks
- replay every turn line-by-line
- convert the chunk into an ultra-brief memory note
- replace substance with labels like “the agent read files” or “tests were run”
- invent context not present in the input
- make old plans sound like current instructions

Example of good compression:

Input excerpt:
[user]
Don’t make compact call the model. It should use what exists.

[assistant]
Then compact should read ready summaries and fall back to stored member concatenation if needed.

[user]
Right. Recovery can happen later through sweep/background drain.

[assistant]
Agreed. Compact remains no-provider-call; healing happens through sweep, background drain, and the next compact.

Good output:
The user corrected the compact behavior: compact must not call providers. The agreed design was for compact to use ready summaries when available and fall back to stored member concatenation if needed. Recovery/healing was deferred to sweep, background drain, and later compacts.

Before returning, check your draft:
- Is it detailed enough to preserve the unfolding of the work?
- Did it keep durable decisions, corrections, concrete anchors, and unresolved questions?
- Did it remove raw thinking/tool detail while preserving what those blocks changed or proved?
- Is it near the target size range?

If too long, compress local process and repeated explanation before deleting durable decisions.
If too short, restore missing corrections, sequence, files, test outcomes, or unresolved work.

Return only the detailed compressed account.
