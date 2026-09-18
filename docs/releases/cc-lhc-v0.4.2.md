# cc-lhc v0.4.2

## Overview

Release on the shared LHC core: the token estimator becomes provider-aware, the
context-window class feature is removed in favor of one built-in policy, three
burn-in fixes, and two documentation additions. No schema change; records and
served views are unchanged for the same input.

- **Provider-aware token estimator.** One estimator per SDK instance with a required
  tokenizer family. Stored estimates stay raw o200k; a measured per-family weight
  applies on read (claude-2026 1.55, claude-2025 1.17, gemini-4 1.14, qwen-3.5 1.08,
  grok 1.05, deepseek-v4 1.04, glm-5 1.00, o200k 1.00, kimi-k2 0.99). cc-lhc resolves
  the family from the launch `--model`, else the resumed record's last assistant
  model, else the Anthropic fallback, and prints it in receipts, the compact note,
  and `/details`. CLI commands take `--token-family`. LHC commit `6dbe7ee8`.
- **Context-window class removed.** The 200k policy, the status-line window observer,
  its launch-settings injection, and every window/class surface are gone. One
  built-in policy (180k target, 360k trigger, 50k minimum runway; cc-lhc assumes a
  1M-window model), with the user, project, launch-flag, and `/bounds` override
  chain unchanged. `268c816d`.
- **Thinking-signature bytes at the billed rate**, per family, instead of the text
  tokenizer's (the original 0.4.2 fix, now a family field). `5f181303`.
- **Burn-in fixes:** the old generation drains through the initialised SDK instead
  of the bare domain module (`62aec60d`); Claude Code's synthetic model id no longer
  flips the tokenizer family each turn (`0b1eb9a2`); capture stop reports each failing
  step by name and always closes (`c7e7d59e`).
- Thinking replay after compact is documented with its prefix-check exposure and the
  one-line recovery.
- The release standard is written down (`docs/releases/README.md`) and this is the
  first cc-lhc release cut under it.

## The defect

The estimator counted every string with one text tokenizer (o200k) and one rate.
Two things were wrong with that. Reasoning signatures, base64 strings on thinking
blocks, tokenize at about 1.47 characters per token in o200k while the provider
bills them far lower: Alder's live comparison of 2026-09-07 on the CC-LHC steward
thread put 18 signature-only thinking blocks at 33,714 estimated against 8,637
billed (ratio 3.90). And Claude text itself bills above o200k: 67 live Reed
requests fitted 1.55 billed tokens per o200k token, and the Anthropic count
endpoint reproduced 1.551 on the campaign's passages.

Effect before the fix: a thread's estimated size ran high on signatures and low on
Claude text, so segment splits and compact triggers fired off-budget and the live
tail was not the configured size.

## Highlights

### Provider-aware token estimator

`packages/lhc/src/shared-tech/token-counting` now builds one `TokenEstimator` per SDK
instance from a required tokenizer family. Stored estimates stay raw o200k; the
family's weight applies on read, and signatures are counted at the family's own
characters-per-token rate. Measured weights (billed / o200k): o200k 1.00,
claude-2026 1.55, claude-2025 1.17, grok 1.05, qwen-3.5 1.08, glm-5 1.00,
kimi-k2 0.99, deepseek-v4 1.04, gemini-4 1.14. Method and passages:
`docs/token-estimator/` (LHC commit `6dbe7ee8`).

### Family resolved from the model, context-window class removed

cc-lhc resolves the family from the launch `--model`, else the resumed record's last
assistant model, else the Anthropic fallback, and re-resolves from each captured
reply; Claude Code's synthetic model id is ignored. The family and its source print
in receipts, the compact note, and `/details`. The 200k/1M context-window class
feature and its status-line probe are gone: one built-in policy (LHC commits
`268c816d`, `0b1eb9a2`).

### Burn-in fixes

The capture stop path now drains the old generation through the initialised SDK
(every compact handoff had logged a spurious drain failure), and it reports each
failing step by name and always writes the closed marker (`62aec60d`, `c7e7d59e`).

### Thinking replay after compact, documented

Both hosts (cc-lhc and the t3code sidecar) replay the tail's signed thinking blocks
after a compact. Accounts created on or after 2026-08-31, and later models for all
accounts, reject that request shape with a prefix-mismatch 400. The READMEs now
name the constant to flip (`SELECTED_THINKING_REBUILD_ARM` → `omit`), the rebuild,
and the preserved-thinking doc. No behavior change in this release.

## Compatibility and validation

- Thread schema unchanged (13). Records, bands, and served views are byte-identical
  to 0.4.1 for the same input; only the token estimate column changes on new writes.
- Package suites rerun green on `8f5c3276` (lhc, cc-lhc, claude-lhc, pi-lhc); workspace typecheck clean except `t3code-inject`, which only resolves its types from the main checkout and is untouched.
- Six-platform build: run 35360589771. Live turn on the shipped Linux artifact
  before publication: see "Source and artifacts".

## Install or upgrade

Install on Linux or macOS from the checksum-verified GitHub release:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.2/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.2/install.ps1 | iex
```

npm:

```sh
npm install --global cc-lhc@0.4.2
```

Upgrading in place keeps records and config; the estimate rate applies to new
captures only. Do not mix npm-owned and script-owned launchers on the same `PATH`.

## Known limitations

- Unchanged from 0.4.1 (see that note): tool-only middle segments of a split turn
  carry no summary by design; smooth-band zeroing on one very large exchange is
  still reachable and is expected to shrink with this estimator change, not yet
  re-measured.
- Family weights and signature rates are measured constants, not values the API
  reports; re-derive if a provider changes its tokenizer or signature billing.
- Removing the window class means a 200k-window Claude model gets the 1M policy
  unless overridden; set `/bounds` or project config for such models.

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.1`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.1)
- Source: LHC main `8f5c3276` (estimator, window-class removal, burn-in fixes), `5f181303` (signature rate), `c7d31155` (thinking note), `a61c2be6` (release standard)
- Build run: 35360589771; npm package sha256 `e191b455aadaed10a1274030522a8b843b3510223a3648189d93049e68b6d38f`
- Live turn on the shipped artifact: 2026-09-18 ~15:45Z, cc-lhc 0.4.2 from the CI npm package installed to a scratch prefix, scratch CC_LHC_HOME, one-shot prompt answered correctly; capture wrote record `65c123b5` (3 events, 1 segment end); wrapper log: family claude-2026 (provider fallback)
- Source comparison: [`cc-lhc-v0.4.1...cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.1...cc-lhc-v0.4.2)
- Release tag: [`cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.2)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.2/SHA256SUMS)
- npm: [`cc-lhc@0.4.2`](https://www.npmjs.com/package/cc-lhc/v/0.4.2)
