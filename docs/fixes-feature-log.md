# Fixes & Feature Log

Tracking small fixes, tighten-ups, and improvements for initial release.

## Open

### 1. pi-lhc compact no_op cancel should not surface as an error
**Where:** `packages/pi-lhc/src/compact/handler.ts`
**What:** When `wouldProduceBands` is `false`, the handler cancels with `no_op` and PI shows a red error: "Compaction cancelled." This fires both when the thread is genuinely too small for bands AND when the snapshot is already correct (same arrangement, nothing to rewrite). Neither case is an error — suppress the error display or downgrade to an info-level notice.

### 2. pi-lhc handler still checks for removed `turn_not_ready` outcome
**Where:** `packages/pi-lhc/src/compact/handler.ts` line ~76
**What:** Dead code — `outcome.kind === "turn_not_ready"` can never match now that `openTurnHasMembers` was removed from `previewCompact`. Clean up the dead branch.

### 3. Upgrade to latest PI
**What:** Update `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent` dependencies in `packages/pi-lhc` to the latest PI release. Check for any breaking API changes.

### 4. Fix integration/inference tests
**Where:** `packages/lhc/test/inference-real.test.ts`
**What:** Real-inference integration tests fail on provenance/call-count expectations. These broke independently of the compact coverage fix — likely prompt template changes drifted the golden expectations. Needs investigation and update to match current prompt templates.

### 5. Update onboarding docs for latest changes
**Where:** `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md`
**What:** The onboarding docs predate several recent changes: the `openTurnHasMembers` removal, coverage gap accounting in compact, preview repair detection, prompt template revisions, and the tool-result summary switch from inference to truncation. Review and update to reflect current behavior.

### 6. Fix nomenclature drift in code and onboarding
**Where:** `packages/lhc/src/thread-view/internal/select.ts`, `render.ts`, onboarding docs
**What:** The coverage fix emits `derivationUsed: "gap"` for turns that have perfectly usable derivations (`turn_rendering` and `smooth_turn_compression` both in `ready` state). "Gap" in the existing vocabulary means "nothing usable exists" — a last-resort placeholder when all ladder rungs are exhausted. Using the same term for "the budget ran out but content is available" conflates a material absence with a budget decision. This leaks into arrangement JSON, receipts, and rendered band text, making it look like there's a derivation problem when there isn't one. Audit the coverage-pass output and the surrounding vocabulary so budget-excluded turns are distinguishable from genuinely unavailable ones.

### 7. Add pi-lhc onboarding doc
**Where:** `docs/onboard/` (new file)
**What:** There is no onboarding doc for the `pi-lhc` package. The existing onboarding covers core LHC concepts and domain design but not the connector layer: how PI events flow into LHC capture, how compact is triggered from `SessionBeforeCompact`, the launcher/lifecycle/session model, inference bridging through PI AI, or the serving path back to PI. Add a `03-pi-lhc.md` (or similar) covering the connector architecture.
