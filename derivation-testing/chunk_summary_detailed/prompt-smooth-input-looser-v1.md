You will receive conversation material from several turns between a user and an agent.

It may include blocks such as `[user]`, `[assistant]`, `[thinking]`, `[tool]`, and `[turn ...]`.

Write a detailed historical account of what happened.

This account becomes a higher-fidelity memory band for a future agent. It should preserve how the work unfolded: what the user wanted, how the agent responded, what changed, what was decided, what evidence or tool results mattered, and what remained unresolved.

This is not the brief memory note. Keep enough detail that a future agent can follow the work without re-reading the original conversation.

Target length:
- Input size: about {{inputTokens}} tokens
- Output target: {{targetMinTokens}}–{{targetMaxTokens}} tokens
- Aim for about {{targetMidTokens}} tokens

Preserve:
- sequence of user requests, corrections, and decisions
- what the agent understood, misunderstood, did, or committed to do
- decisions and why they changed
- important reasoning shifts from thinking blocks, without copying raw thinking
- important outcomes from tool calls/results, not raw tool logs
- files, paths, commands, model names, config values, numbers, test results, errors, and commit hashes when they matter
- failures, rejected approaches, retries, blocked work, and unresolved questions

Compress mainly by:
- removing raw tool output, raw thinking, repeated acknowledgements, apologies, and local status chatter
- summarizing tool/thinking material by what it changed or proved
- merging repeated corrections or repeated decisions when they truly repeat
- shortening long explanations while keeping the decision, reason, and outcome

Do not compress away important sequence just to be short. Prefer preserving meaningful unfolding over hitting the lower side of the target range.

Do not:
- preserve raw `[thinking]` or `[tool]` blocks
- replay every line verbatim
- collapse this into an ultra-brief note
- replace substance with labels like “the agent read files” or “tests were run”
- invent context not present in the input
- make old plans sound like current instructions

Before returning, check your draft:
- Is it detailed enough to preserve the unfolding of the work?
- Did it keep durable decisions, corrections, concrete anchors, and unresolved questions?
- Did it preserve what tool/thinking blocks changed or proved, without copying their raw text?
- Is it near the target size range?

If too long, compress local process and repeated explanation before deleting durable decisions.
If too short, restore missing corrections, sequence, files, test outcomes, or unresolved work.

Return only the detailed historical account.
