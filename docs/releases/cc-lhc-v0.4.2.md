# cc-lhc v0.4.2

## Overview

Maintenance release on the shared LHC core. One accounting fix, two documentation
additions, no schema change, no change to captured records or served views.

- Thinking-signature bytes are now estimated at the provider's billed rate instead
  of the text tokenizer's, so turn sizes, segment splits, and compact triggers stop
  firing early on threads that carry reasoning signatures.
- Thinking replay after compact is documented with its prefix-check exposure and the
  one-line recovery.
- The release standard is written down (`docs/releases/README.md`) and this is the
  first cc-lhc release cut under it.

## The defect

Reasoning signatures are base64 strings attached to thinking blocks. The estimator
ran them through the o200k text tokenizer, which counts base64 at roughly 1.47
characters per token. The API bills them far lower.

Reproduction on the pre-fix build (cc-lhc 0.4.1, LHC `c7d31155`), Alder's live
comparison of 2026-09-07 on the CC-LHC steward thread: 18 thinking blocks with no
visible text and 1.4k–4k-character signatures were estimated at 33,714 tokens where
the provider billed 8,637 (ratio 3.90). Reed re-measured the tokenizer rate on 300
live Fable signatures (672,884 chars, 458,756 o200k tokens, 1.467 chars/token),
giving 5.73 chars per billed token; 5.74 is used.

Effect before the fix: a thread's estimated size ran high by the signature volume in
its tail, so turn segmentation and compact triggers fired earlier than the budget
intended and the live tail was thinner than configured.

## Highlights

### Signatures estimated at the billed rate

`estimateSignatureTokens` in `packages/lhc/src/shared-tech/token-counting` counts
signature characters at 5.74 per token; the message projector uses it for the
signature part of a thinking message and the text tokenizer for the visible text.
Rate documented in source with its derivation. LHC commit `5f181303`.

### Thinking replay after compact, documented

Both hosts (cc-lhc and the t3code sidecar) replay the tail's signed thinking blocks
after a compact. Accounts created on or after 2026-08-31, and later models for all
accounts, reject that request shape with a prefix-mismatch 400. The READMEs now
name the constant to flip (`SELECTED_THINKING_REBUILD_ARM` → `omit`), the rebuild,
and the preserved-thinking doc. No behavior change in this release.

## Compatibility and validation

- Thread schema unchanged (13). Records, bands, and served views are byte-identical
  to 0.4.1 for the same input; only the token estimate column changes on new writes.
- LHC package: 919 tests passed, 31 skipped; production and test typecheck clean.
- Six-platform build: run RUN_ID_TBD. Live turn on the shipped Linux artifact
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
- The billed rate is a measured constant, not a value the API reports; re-derive if
  Anthropic changes signature billing.

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.1`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.1)
- Source: LHC main `5f181303` (estimator), `c7d31155` (thinking note), `a61c2be6` (release standard)
- Build run: RUN_ID_TBD; npm package sha256 `SHA256_TBD`
- Live turn on the shipped artifact: LIVE_TURN_TBD
- Source comparison: [`cc-lhc-v0.4.1...cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.1...cc-lhc-v0.4.2)
- Release tag: [`cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.2)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.2/SHA256SUMS)
- npm: [`cc-lhc@0.4.2`](https://www.npmjs.com/package/cc-lhc/v/0.4.2)
