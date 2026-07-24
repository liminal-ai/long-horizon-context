//! Ported from packages/lhc/src/shared-tech/inference-adapter.ts.
//! Phase 1 skeleton — TargetRatios REAL; behavior bodies `todo!("phase 2")`.
//!
//! createInferenceCallbacks returns the same InferenceCallbacks interface direct
//! injection implements. Wave 1 deleted target_ratios_of as premature; Wave 2
//! restores the extraction surface tests/handlers need.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[allow(unused_imports)] // Phase 2 callKind / safeCall / PROMPT_REGISTRY graph
use super::classify::safe_call;
use super::derivation::{InferenceCallbacks, InferenceRequestMessage, InferenceResult};
use super::inference_types::{ModelAssignment, ModelCallFailureKind, ResolvedInferenceConfig};
#[allow(unused_imports)]
use super::prompts::PROMPT_REGISTRY;

/// Partial pick of assignment target-ratio fields (camelCase wire keys).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetRatios {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_min_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_max_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_aim_ratio: Option<f64>,
}

/// TS `boundContent` — marker string is built inline at runtime (no module const).
fn bound_content(_content: &str, _max_input_chars: i64) -> String {
    todo!("phase 2")
}

fn inference_failure(
    _kind: ModelCallFailureKind,
    _message: &str,
    _request_messages: Option<Vec<InferenceRequestMessage>>,
) -> InferenceResult {
    todo!("phase 2")
}

/// Target ratios carried on an assignment, extracted as a plain object so the
/// adapter can merge them into a prompt's render input. Exported so tests pin
/// the extraction directly.
pub fn target_ratios_of(_assignment: Option<&ModelAssignment>) -> TargetRatios {
    todo!("phase 2")
}

/// Merge an assignment's target ratios into a prompt's render input.
fn with_target_ratios(_input: &Value, _assignment: &ModelAssignment) -> Value {
    todo!("phase 2")
}

async fn call_kind(
    _config: &ResolvedInferenceConfig,
    _kind: &str,
    _input: Value,
) -> InferenceResult {
    todo!("phase 2")
}

/// TS `createInferenceCallbacks(config)`.
pub fn create_inference_callbacks(_config: ResolvedInferenceConfig) -> InferenceCallbacks {
    todo!("phase 2")
}
