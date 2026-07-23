//! Ported from packages/lhc/src/shared-tech/classify.ts. Phase 1 skeleton.
//!
//! `safe_call` contains the host function: a thrown exception becomes `other`
//! and the adapter-owned timeout race becomes `timeout`, so host behavior cannot
//! crash a drain.

use super::inference_types::{ModelCall, ModelCallInput, ModelCallResult};

/// try/catch + timeout race around the host function.
pub async fn safe_call(
    _call: &ModelCall,
    _input: ModelCallInput,
    _timeout_ms: i64,
) -> ModelCallResult {
    todo!("phase 2")
}
