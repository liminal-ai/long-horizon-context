# Tool Result Summary Testing Notes

## Executive summary

For `tool_result_summary`, the right shape is:

```text
tool response -> deterministic classification/parsing -> prompt-mode-specific model summary
```

The model should not be asked to infer basic facts like success/failure, exit code, file path, match counts, block counts, or missing-file errors. Those should be parsed deterministically first and passed as authoritative facts. The model then writes a concise receipt/summary from those facts plus an excerpt of the raw output.

Current working design:

- One generic CLI/harness for tool-result summary testing.
- A classifier routes each tool response by operation class and response shape.
- Parsed semantic facts are passed into the prompt.
- Prompt mode changes based on response shape.
- Large raw outputs are excerpted before model calls.
- Each model call has a hard timeout.
- The summary result should preserve concrete future-useful facts without copying raw tool noise.

Current best model signal:

```text
Best quality/default: GPT 5.4 mini
Best budget/open lane: Qwen 3.6 35B A3B via OpenRouter wandb/fp8
Claude-compatible: Haiku 4.5, good but more expensive and slightly more interpretive on test failures
```

Qwen looks especially promising for this derivation because the deterministic parser does much of the factual work and Qwen is fast/cheap when the prompt is structured well.

## Files created

Main standalone CLI:

```text
derivation-testing/tool_result_summary/tool-result-summary-cli.mjs
```

Supporting modules:

```text
derivation-testing/tool_result_summary/lib/fixture.mjs
derivation-testing/tool_result_summary/lib/classify.mjs
derivation-testing/tool_result_summary/lib/prompt.mjs
derivation-testing/tool_result_summary/lib/model-client.mjs
```

One-off fixtures used during development:

```text
derivation-testing/tool_result_summary/oneoff-bash-failure.mjs
derivation-testing/tool_result_summary/oneoff-edit-failure.mjs
```

Fixture sets:

```text
derivation-testing/tool_result_summary/set-a.jsonl
derivation-testing/tool_result_summary/set-b.jsonl
derivation-testing/tool_result_summary/set-c.jsonl
derivation-testing/tool_result_summary/set-d.jsonl
derivation-testing/tool_result_summary/set-e.jsonl
derivation-testing/tool_result_summary/set-f.jsonl
derivation-testing/tool_result_summary/set-g-stress.jsonl
```

Notes:

```text
derivation-testing/tool_result_summary/notes.md
derivation-testing/tool_result_summary/classifier-coverage-notes.md
derivation-testing/tool_result_summary/tool-result-summary-writeup.md
```

## Current CLI usage

Example:

```bash
node derivation-testing/tool_result_summary/tool-result-summary-cli.mjs \
  --examples derivation-testing/tool_result_summary/set-a.jsonl \
  --out derivation-testing/tool_result_summary/results/set-a-gpt54mini.jsonl \
  --model openai/gpt-5.4-mini \
  --timeout-ms 30000 \
  --extra-json '{"provider":{"only":["openai"],"allow_fallbacks":false}}'
```

Qwen/W&B FP8:

```bash
node derivation-testing/tool_result_summary/tool-result-summary-cli.mjs \
  --examples derivation-testing/tool_result_summary/set-d.jsonl \
  --out derivation-testing/tool_result_summary/results/set-d-qwen36-wandb-fp8.jsonl \
  --model qwen/qwen3.6-35b-a3b \
  --timeout-ms 30000 \
  --extra-json '{"provider":{"only":["wandb/fp8"],"allow_fallbacks":false}}'
```

Haiku:

```bash
node derivation-testing/tool_result_summary/tool-result-summary-cli.mjs \
  --examples derivation-testing/tool_result_summary/set-d.jsonl \
  --out derivation-testing/tool_result_summary/results/set-d-haiku45.jsonl \
  --model anthropic/claude-haiku-4.5 \
  --timeout-ms 30000 \
  --extra-json '{"provider":{"only":["anthropic"],"allow_fallbacks":false}}'
```

## Why deterministic parsing first

Tool responses often include structured facts that should not be left to model interpretation:

- tool name
- success/failure/unknown outcome
- exit code
- target path
- byte count
- block count
- match count
- failed field
- missing command
- system error such as `ENOENT`
- retry guidance when mechanically obvious

The model is good at wording a concise receipt. It should not be trusted as the source of mechanical truth.

The pattern that worked best:

```text
1. Extract semantic facts deterministically.
2. Pass those facts to the model.
3. Tell the model facts are authoritative.
4. Tell the model not to mention parser field names.
5. Tell the model not to infer missing content or root causes.
6. Pass only an excerpt of large raw outputs.
```

## Important prompt lessons

### Use semantic fact names, not parser-shaped names

Bad parsed field names caused model leakage:

```json
{
  "fullTarget": "edits[0].oldText"
}
```

Qwen copied the field label into the summary:

```text
because the `fullTarget` `edits[0].oldText` occurred 2 times
```

Better field shape:

```json
{
  "failedField": "edits[0].oldText",
  "matchCount": 2,
  "targetPath": "tests/thread/lower-band-compression-service.test.ts"
}
```

Prompt instruction that fixed this:

```text
Use parsed field values, but do not mention parsed field labels.
```

### Do not pass diagnostic-only metrics into the prompt

Passing `outputChars` / `outputWords` into the model caused GPT to include them in summaries. Those metrics are useful for diagnostics, not summary content.

Current prompt filtering excludes:

```text
operationClass
responseShape
outputChars
outputWords
```

### Prevent unsupported diagnosis

Haiku added a mild diagnosis on a test failure:

```text
The artifact state object contains an unexpected `providerMetadata` field that should not be persisted.
```

This was grounded but slightly beyond a pure receipt. We added:

```text
Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what the parsed fields or raw response directly support.
```

That helped GPT and Qwen and did not regress quality. Haiku may still need additional tuning if it becomes the default for this derivation.

## Current classifier shape

The classifier first derives:

```text
toolName
operationClass
responseShape
promptMode
facts
```

### Operation classes

Current operation classes:

```text
read
mutation_write
mutation_edit
command
search_or_listing
verification
vcs_inspection
filesystem_mutation
multi_tool
unknown
```

Most are inferred from `toolName`, plus command patterns for `bash`.

Examples:

```text
read  -> read
write -> mutation_write
edit  -> mutation_edit
bash + rg/grep/find -> search_or_listing
bash + vitest/test/tsc/verify -> verification
bash + git diff/status/show/log -> vcs_inspection
multi_tool_use.parallel -> multi_tool
```

### Response shapes

Current response shapes:

```text
structured_receipt
simple_failure
no_output
search_result
test_result
file_content
large_file_content
diff_output
large_log
multi_tool_result
unknown_content
```

### Prompt modes

Current prompt modes:

```text
receipt
failure
no_output
search_summary
test_summary
content_summary
diff_summary
large_log
multi_tool_summary
generic_summary
```

## Covered scenarios

### Receipt-shaped responses

Examples:

```text
Successfully wrote N bytes to path
Successfully replaced N block(s) in path
Found N occurrences of edits[0] in path. Each oldText must be unique.
```

Behavior:

- parse path/count/status
- preserve exact identifiers and counts
- do not infer changed content
- for write/edit success without tool input, say content/edit details were not available if needed

Good summary example:

```text
edit failed for tests/thread/lower-band-compression-service.test.ts: edits[0].oldText matched 2 locations. Retry with more surrounding context so the replacement target is unique.
```

### Simple failures

Examples:

```text
sh: vitest: command not found
Command exited with code 127
```

```text
ENOENT: no such file or directory, access '/path/to/file'
```

Behavior:

- preserve error type
- preserve path/command
- preserve exit code
- preserve retry guidance when obvious

Good summary example:

```text
bash failed with exit code 127: `vitest` was not found. Retry by installing it or invoking it through the project package runner.
```

### No-output success

Example:

```text
(no output)
```

For a command like:

```text
git status --short
```

Good summary:

```text
`git status --short` completed with no output.
```

The prompt can say no output indicates a clean/no-change result only when the parsed outcome says succeeded.

### Search results

Covered:

- small search matches
- medium search output
- large search output
- synthetic no-match search

Behavior:

- preserve command/query if available
- preserve match/no-match status
- preserve match count
- preserve representative matches/paths
- do not list every match for large output

Large search outputs are excerpted before model call.

### Test / verification output

Covered:

- medium test output
- assertion failure
- large verification output

Behavior:

- parse failed test names
- parse pass/fail/total counts when possible
- preserve assertion mismatch
- preserve exit code
- avoid stack frame noise

Good summary after tuning:

```text
Ran `... node --import tsx --test tests/thread/lower-band-compression-service.test.ts` and got exit code 1. Test run: 9 total, 7 passed, 2 failed. Failing tests: `routing uses ceil(chars divided by 3.5) and persists lean semantic artifact state`; `third lower-band size attempt escalates to GPT-5.5 medium and accepts the first escalated response`. Both failures were `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` with actual keys [...] vs expected [...].
```

### Content summaries

Covered:

- small read
- medium read
- large file/document content

Behavior:

- preserve file/document identity if available
- summarize what was learned
- do not dump file contents

### Diff summaries

Covered:

- diffstat-like output
- medium diff output
- large diff output

Behavior:

- preserve changed files
- preserve change nature and scale
- avoid reproducing full diff

### Large logs

Covered:

- medium noisy command output
- large log/report output

Behavior:

- preserve final status
- preserve key errors/counts/paths
- remove repeated boilerplate
- use head/tail excerpts for huge logs

### Multi-tool wrapper results

Covered only synthetically so far.

Behavior:

- preserve each subtool result separately
- preserve mixed success/failure
- preserve missing paths and no-output statuses
- do not collapse the group into one vague result

Example target:

```text
Parallel tool use had mixed results. `read package.json` succeeded. `read missing.ts` failed with ENOENT. `git status --short` succeeded with no output.
```

## Fixture sets

### `set-a.jsonl`

Initial mixed, not-too-big cases:

```text
read small success
bash self-update failure
edit success
write success
bash diffstat success
```

### `set-b.jsonl`

Bigger/missed cases:

```text
edit non-unique failure
medium package read
large PRD read
large package diff
large test output
```

### `set-c.jsonl`

New shape coverage:

```text
search matches
test pass
test failure
large verification failure log
large search output
```

### `set-d.jsonl`

Additional classifier coverage:

```text
read missing file
command success with no output
test assertion failure
search no matches synthetic
multi-tool mixed synthetic
```

### `set-e.jsonl`

Classifier breadth, real examples:

```text
receipt edit success
simple bash missing-dir failure
no-output command
medium search
medium test/verification
```

### `set-f.jsonl`

Classifier breadth, part 2:

```text
medium content read
medium diff
medium large-log/noisy command
generic unknown command output
larger synthetic multi-tool
```

### `set-g-stress.jsonl`

Larger input stress cases:

```text
large file content
large diff
large log
large search
large test/verification
large generic unknown
synthetic batch receipt
synthetic large multi-tool
```

Synthetic cases are marked in `vars.synthetic` when used.

## Model results so far

### GPT 5.4 mini

Strengths:

- best overall polish
- follows prompt reliably
- strong on test summaries after parser/prompt tuning
- good default quality

Typical runtime:

```text
receipt/simple: ~0.7s-1.2s
search/test/log: ~1.5s-2.7s
```

### Qwen 3.6 35B A3B via OpenRouter W&B FP8

Strengths:

- fastest and cheapest tested path
- good when given semantic parsed fields
- strong candidate for `tool_result_summary`
- no collapse on tested tool-summary cases

Typical runtime:

```text
simple cases: ~0.3s-0.7s
test-ish case: ~1.2s-1.5s
```

Qwen initially leaked parser labels when the parsed fields used names like `fullTarget`. Semantic fact names plus explicit prompt instruction fixed that.

### Haiku 4.5

Strengths:

- good concise wording
- strong on simple receipt/failure cases
- compatible Claude lane

Watch:

- can add interpretive diagnostic sentences on test failures
- more expensive than Qwen for this derivation

If Haiku becomes a default/target model for this derivation, spend more time tuning the `test_summary` prompt.

## Safety and timeout changes

A large search case once ran for about 5 minutes because the model call had no client-side timeout and raw search output was passed through too directly.

Fixes added:

```text
--timeout-ms flag
AbortController around fetch
default timeout: 60000ms
quick eval timeout: 30000ms
large search excerpting
huge log head/tail excerpting
```

After excerpting, the same large-search case ran in about 2.4s.

This is required behavior: no eval call should be able to hang for minutes.

## Current prompt shape

The prompt contains:

- general instruction
- authoritative parsed facts
- prompt mode
- mode-specific guidance
- raw tool response excerpt

Important standing instruction:

```text
Use parsed field values, but do not mention parsed field labels.
Preserve paths, commands, identifiers, counts, and exit codes verbatim.
Do not quote or label the raw response.
Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what the parsed fields or raw response directly support.
```

## Current recommendation

For `tool_result_summary`, proceed with:

```text
deterministic parser/classifier first
prompt-mode-specific model summary second
hard timeout
large-output excerpting
```

Recommended default model to test next:

```text
GPT 5.4 mini for quality baseline
Qwen/W&B FP8 for budget/open lane
```

Qwen is especially promising for this derivation because most factual reliability comes from deterministic parsing.

## Remaining gaps for next pass

To be fully complete, still capture or synthesize better examples for:

```text
real search no-match
real multi-tool wrapper result
timeout / aborted command
permission denied
JSON/status-report output
binary or unsupported-file read
package install failure
warning-only install success
stderr warning with exit 0
malformed command / invalid option
large mutation receipts from real wrapped/batch output
```

Also worth testing:

```text
Haiku-specific test failure prompt tuning
Qwen on all stress cases
GPT/Qwen/Haiku on set-e/f/g, not just set-d
whether receipt-shaped outputs can skip inference entirely in some cases
whether deterministic summaries are good enough for simple receipts/failures
```

## Possible future optimization

Some receipt-shaped cases may not need inference at all.

Examples:

```text
Successfully wrote N bytes to path
Successfully replaced N block(s) in path
ENOENT path missing
command not found
```

For those, deterministic summary templates may be enough:

```text
write succeeded: wrote N bytes to `path`; written content was not available in the response.
```

This could reduce cost/latency and make the model path focus on content-shaped cases: large reads, logs, tests, search, diffs, and multi-tool results.

Do not decide this yet. First run the broader fixture sets and see how often model summaries add value over deterministic receipts.
