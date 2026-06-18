# Tool Result Summary Classifier Coverage

## Candidate search

A deeper scan pulled candidates from:

- `.context-steward/threads/**/messages.jsonl`
- `liminal-context/.context-steward/threads/**/messages.jsonl`
- `.context-steward/threads/**/thread.sqlite` `message_block` rows

A temporary normalized inventory was written to `/tmp/tool-result-candidates.jsonl` during collection. It found 3,385 tool-result candidates across JSONL and SQLite sources.

## Current fixture groups

### `set-e.jsonl` — classifier breadth, part 1

Real examples:

- `trs-e-01-receipt-edit-success-real` — `receipt / structured_receipt`
- `trs-e-02-failure-bash-missing-dir-real` — `failure / simple_failure`
- `trs-e-03-no-output-search-command-real` — `no_output / no_output`
- `trs-e-04-search-medium-real` — `search_summary / search_result`
- `trs-e-05-test-medium-real` — `test_summary / test_result`

### `set-f.jsonl` — classifier breadth, part 2

Real examples:

- `trs-f-01-content-read-medium-real` — `content_summary / file_content`
- `trs-f-02-diff-medium-real` — `diff_summary / diff_output`
- `trs-f-03-large-log-medium-real` — `large_log / large_log`
- `trs-f-04-generic-unknown-medium-real` — `generic_summary / unknown_content`

Synthetic example:

- `trs-f-05-multi-tool-larger-synthetic` — `multi_tool_summary / multi_tool_result`

Reason synthetic: no real `multi_tool_use.parallel` captured result was found in the searched stores.

### `set-g-stress.jsonl` — larger-input stress cases

Real examples:

- `trs-g-01-large-file-content-real` — `content_summary / large_file_content`
- `trs-g-02-large-diff-real` — `diff_summary / diff_output`
- `trs-g-03-large-log-real` — `large_log / large_log`
- `trs-g-04-large-search-real` — `search_summary / search_result`
- `trs-g-05-large-test-or-verification-real` — `test_summary / test_result`
- `trs-g-06-large-generic-unknown-real` — `generic_summary / unknown_content`

Synthetic stress examples:

- `trs-g-07-large-receipt-batch-synthetic` — `receipt / structured_receipt`
- `trs-g-08-large-multi-tool-synthetic` — `multi_tool_summary / multi_tool_result`

Reason synthetic:

- Single write/edit receipts are inherently short in the current tool protocol, so the realistic larger receipt stress shape is a batch/wrapper receipt.
- No real multi-tool wrapper result was found.

## Classifier corrections made during collection

### Avoid overclassifying docs/reads as test results

The classifier previously treated any large output mentioning “Tests” or “passed” as `test_result`. That misrouted read/doc outputs. It now classifies `test_result` only when:

- operation class is verification and output contains test-runner markers, or
- the output has explicit test-runner structure such as TAP `# tests` lines.

### Do not attach search counts to non-search-result shapes

`searchMatchCount` is now emitted only when the response shape is actually `search_result`, not for `simple_failure` or `no_output` outputs from search/listing commands.

### Batch receipts

Multiple receipt lines such as repeated `Successfully replaced...` / `Successfully wrote...` lines now classify as `structured_receipt` instead of generic unknown content.

## Remaining realistic gaps

Still worth capturing later from live use:

- real search no-match result with actual `rg` output/exit behavior
- real multi-tool wrapper result
- timeout/abort result
- permission-denied result
- JSON/status-report output
- binary/unsupported-file read result
- package-install failure and warning-only install success
