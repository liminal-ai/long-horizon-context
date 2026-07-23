//! Ported from packages/lhc/test/fixtures/model-call.ts. Phase 1.
//!
//! Constants and pure assignment/response maps are REAL. Call builders that
//! return ModelCall functions are skeletons (Python Phase 1 PORT_STATUS).

use std::collections::HashMap;

use indexmap::IndexMap;
use lhc::shared_tech::inference_types::{
    ModelAssignment, ModelCall, ModelCallInput, ModelCallResult, ThinkingLevel,
};
use lhc::shared_tech::prompts::DEFAULT_PROMPT_NAMES;

pub const DERIVATION_TYPES: &[&str] = &[
    "smoothed_prompt",
    "tool_result_summary",
    "turn_rendering",
    "pre_detailed_assembly",
    "detailed_turn_compression",
    "chunk_summary_detailed",
    "chunk_summary_brief",
];

pub const INFERENCE_DERIVATION_TYPES: &[&str] = &[
    "smoothed_prompt",
    "tool_result_summary",
    "detailed_turn_compression",
    "chunk_summary_brief",
];

pub const FAKE_PROVIDER_PREFIX: &str = "prov-";
pub const FAKE_MODEL_PREFIX: &str = "model-";

fn fixture_prompt(kind: &str) -> String {
    for (k, name) in DEFAULT_PROMPT_NAMES {
        if *k == kind {
            return (*name).to_string();
        }
    }
    "unknown-prompt".to_string()
}

/// Partial override bag for [`valid_assignments`] (TS `Partial<ModelAssignment>`).
#[derive(Debug, Clone, Default)]
pub struct ModelAssignmentOverride {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub target_min_ratio: Option<f64>,
    pub target_max_ratio: Option<f64>,
    pub target_aim_ratio: Option<f64>,
    pub thinking: Option<ThinkingLevel>,
}

/// Every kind gets a distinct fake provider/model lane — pure data. REAL.
pub fn valid_assignments(
    overrides: Option<&HashMap<String, ModelAssignmentOverride>>,
) -> IndexMap<String, ModelAssignment> {
    let empty = HashMap::new();
    let overrides = overrides.unwrap_or(&empty);
    let mut map = IndexMap::new();
    for kind in INFERENCE_DERIVATION_TYPES {
        let ov = overrides.get(*kind);
        map.insert(
            (*kind).to_string(),
            ModelAssignment {
                provider: ov
                    .and_then(|o| o.provider.clone())
                    .unwrap_or_else(|| format!("{FAKE_PROVIDER_PREFIX}{kind}")),
                model: ov
                    .and_then(|o| o.model.clone())
                    .unwrap_or_else(|| format!("{FAKE_MODEL_PREFIX}{kind}")),
                prompt: ov
                    .and_then(|o| o.prompt.clone())
                    .unwrap_or_else(|| fixture_prompt(kind)),
                target_min_ratio: ov.and_then(|o| o.target_min_ratio),
                target_max_ratio: ov.and_then(|o| o.target_max_ratio),
                target_aim_ratio: ov.and_then(|o| o.target_aim_ratio),
                thinking: ov.and_then(|o| o.thinking),
            },
        );
    }
    map
}

/// One distinct canned sentence per kind. REAL.
pub fn canned_responses() -> HashMap<String, String> {
    DERIVATION_TYPES
        .iter()
        .map(|kind| {
            (
                (*kind).to_string(),
                format!("canned {kind} text from the fake host"),
            )
        })
        .collect()
}

pub struct RecordingCallBundle {
    pub call: ModelCall,
    pub log: std::sync::Arc<std::sync::Mutex<Vec<ModelCallInput>>>,
}

/// PARTIAL — Phase 1 skeleton (Python Phase 1: call builders skeleton).
pub fn recording_call(_responses: &HashMap<String, String>) -> RecordingCallBundle {
    todo!("phase 2")
}

/// PARTIAL — Phase 1 skeleton.
pub fn scripted_call(_script: Vec<ModelCallResult>) -> ModelCall {
    todo!("phase 2")
}

/// PARTIAL — Phase 1 skeleton.
pub fn throwing_call(_error: Box<dyn std::error::Error + Send + Sync>) -> ModelCall {
    todo!("phase 2")
}

/// PARTIAL — Phase 1 skeleton.
pub fn hanging_call() -> ModelCall {
    todo!("phase 2")
}
