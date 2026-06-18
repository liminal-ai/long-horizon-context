Below is a conversation between a user and an agent.

`>` marks user text.
`●` marks agent text.

Condense the conversation.

Keep it as a back-and-forth conversation:
- preserve the speaker order
- use `>` for condensed user entries
- use `●` for condensed agent entries
- one output line may summarize several nearby lines from the same speaker
- do not turn the conversation into a third-person recap or essay

Target length:
- Input: about {{inputTokens}} tokens
- Output target: {{targetMinTokens}}–{{targetMaxTokens}} tokens
- Aim for about {{targetMidTokens}} tokens

Keep the substance of the exchange:
- what the user asked for, corrected, rejected, or decided
- what the agent understood, misunderstood, agreed to, did, or committed to do
- important decisions, constraints, preferences, and unresolved questions
- concrete files, paths, commands, symbols, model names, numbers, and test outcomes
- failures, blocked work, rejected approaches, and corrections
- enough sequence that the conversation still makes sense

Compress by:
- dropping glue words: articles, filler, pleasantries, hedges, and repeated acknowledgements
- using compact fragments when meaning stays clear
- shortening long explanations into decision/reason/outcome
- using `->` for cause/effect when readable
- merging repeated corrections or repeated decisions into one clear version
- dropping low-value tool mechanics unless the outcome matters
- preserving substance over grammar polish
- keeping the communication, not every sentence

Do not:
- invent context
- add headings
- explain that you are summarizing
- present old plans as current instructions
- remove speaker attribution
- replace dialogue content with bracketed activity labels

Bad:
● [Read both docs in full with interleaved thoughts — PRD covered long-horizon context management...]

Good:
● Read PRD/tech arch and reported: canonical thread records should stay separate from PI runtime files; compact should assemble prepared context, not mutate source history; source records and derived views need clear separation.

Bad:
● [Ran tests and reviewed output.]

Good:
● Ran tests; key result was 430 passed / 9 skipped, with real-inference skipped because `LHC_OPENROUTER_KEY` was unset.

Compress what was communicated or learned, not merely that an action happened.

Before returning, check your draft against the target length:
- if it is too long, remove glue/explanation before deleting facts; collapse repeated corrections/decisions into one line
- if it is too short, restore missing decisions, corrections, constraints, and concrete details
- make sure the final answer still reads like a compressed conversation

Return only the condensed conversation.
