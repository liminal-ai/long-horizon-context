Below is one exchange from a coding conversation.

It is about {{inputTokens}} tokens long.

Shorten it to about {{targetMidTokens}} tokens. The final output must fall within {{targetMinTokens}}–{{targetMaxTokens}} tokens.

Write the shortened version as compact prose.

Preserve:
- the user’s request, correction, decision, or preference
- the agent’s answer, action, mistake, or commitment
- the useful conclusion from thinking, if it affected the work
- the useful outcome from tool calls/results, if it affected the work
- concrete files, paths, commands, model names, numbers, errors, test results, and commit hashes
- unresolved questions or blocked work

Remove:
- raw thinking text
- raw tool output
- repeated acknowledgements
- apologies and status chatter
- local filler
- details that did not affect what happened next

Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.

Before returning, estimate whether the output is within {{targetMinTokens}}–{{targetMaxTokens}} tokens.
If it is too short, expand it by restoring missing substance.
If it is too long, contract it by removing lower-value detail and repeated explanation.

The final answer must be within {{targetMinTokens}}–{{targetMaxTokens}} tokens.

Return only the shortened exchange.
