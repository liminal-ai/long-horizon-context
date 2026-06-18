# Tool Result Summary Notes

## Current classifier/prompt finding

The parser + prompt path is working across receipt, failure, no-output, search/no-match, test-result, diff, content, large-log excerpt, and multi-tool mixed cases.

## Haiku-specific watch item

On `trs-d-03-test-assertion-failure`, Haiku 4.5 preserves the facts but adds a mild diagnostic conclusion:

```text
The artifact state object contains an unexpected `providerMetadata` field that should not be persisted.
```

This is grounded in the assertion mismatch, but it goes slightly beyond a pure tool-result receipt. GPT 5.4 mini and Qwen/W&B FP8 stayed closer to reporting actual-vs-expected.

If Haiku becomes a target/default model for `tool_result_summary`, spend more time tuning the `test_summary` prompt, likely with wording like:

```text
For test failures, report actual vs expected exactly. Do not say which side is wrong or what should be persisted unless the raw output says that explicitly.
```

Leaving this for later because current quality is acceptable and Qwen/GPT are the more promising defaults for this derivation.
