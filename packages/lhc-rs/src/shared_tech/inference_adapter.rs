//! Ported from packages/lhc/src/shared-tech/inference-adapter.ts.
//! Phase 1 PARTIAL stub — create_inference_callbacks for Wave 1 inference-prompts.
//!
//! Deleted Wave 1 invent: `target_ratios_of` / `TargetRatios` — not required by
//! Wave 1 suites (inference-adapter full surface is later).

use crate::shared_tech::derivation::InferenceCallbacks;
use crate::shared_tech::inference_types::ResolvedInferenceConfig;

/// TS `createInferenceCallbacks(config)` — PARTIAL stub (Wave 1 tests import it).
pub fn create_inference_callbacks(_config: ResolvedInferenceConfig) -> InferenceCallbacks {
    todo!("phase 2")
}
