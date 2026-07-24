//! Ported from packages/lhc/src/shared-tech/inference-types.ts. Phase 1 skeleton.
//!
//! Inference boundary vocabulary: the one function a host supplies, its
//! structured result shapes, and the config that arrives at initLhc as the
//! alternative to direct inference callback injection. LHC treats provider/model
//! strings as host routing keys; the host's ModelCall implementation is the only
//! code that interprets them.

use indexmap::IndexMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::derivation::BoxFuture;

/// `empty_output` is adapter-generated; hosts never return it.
/// Thrown exceptions classify as `other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallFailureKind {
    RateLimit,
    Timeout,
    Network,
    EmptyOutput,
    Other,
    Auth,
    InvalidRequest,
}

impl ModelCallFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelCallFailureKind::RateLimit => "rate_limit",
            ModelCallFailureKind::Timeout => "timeout",
            ModelCallFailureKind::Network => "network",
            ModelCallFailureKind::EmptyOutput => "empty_output",
            ModelCallFailureKind::Other => "other",
            ModelCallFailureKind::Auth => "auth",
            ModelCallFailureKind::InvalidRequest => "invalid_request",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    None,
    Minimal,
    Medium,
    High,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ThinkingLevel::None => "none",
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallMessageRole {
    System,
    User,
}

impl ModelCallMessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelCallMessageRole::System => "system",
            ModelCallMessageRole::User => "user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallMessage {
    pub role: ModelCallMessageRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallInput {
    pub provider: String,
    pub model: String,
    pub messages: Vec<ModelCallMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
}

/// In-memory host boundary result — no serde (mirrors Wave 0 InferenceResult).
#[derive(Debug, Clone, PartialEq)]
pub enum ModelCallResult {
    Ok {
        text: String,
    },
    Err {
        kind: ModelCallFailureKind,
        message: String,
    },
}

/// The one function a host supplies. Single-turn completion; provider/model
/// are host routing keys the host's implementation interprets.
/// `Arc` (not `Box`): one host call fans out into four per-kind callbacks
/// (phase-review H4).
pub type ModelCall = Arc<dyn Fn(ModelCallInput) -> BoxFuture<ModelCallResult> + Send + Sync>;

/// ModelAssignment includes target ranges for compression types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAssignment {
    pub provider: String,
    pub model: String,
    /// must name a PROMPT_REGISTRY entry
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_min_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_max_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_aim_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmoothedPromptGuards {
    /// default 700
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_inference_tokens: Option<i64>,
    /// default 0.15
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspicious_output_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultSummaryGuards {
    /// default 60_000
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedTurnCompressionGuards {
    /// default 80
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiny_turn_tokens: Option<i64>,
}

/// DerivationGuards config for operational limits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationGuards {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoothed_prompt: Option<SmoothedPromptGuards>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result_summary: Option<ToolResultSummaryGuards>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed_turn_compression: Option<DetailedTurnCompressionGuards>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSmoothedPromptGuards {
    pub max_inference_tokens: i64,
    pub suspicious_output_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedToolResultSummaryGuards {
    pub timeout_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDetailedTurnCompressionGuards {
    pub tiny_turn_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDerivationGuards {
    pub smoothed_prompt: ResolvedSmoothedPromptGuards,
    pub tool_result_summary: ResolvedToolResultSummaryGuards,
    pub detailed_turn_compression: ResolvedDetailedTurnCompressionGuards,
}

/// SdkConfig.inference: the alternative to SdkConfig.inferenceCallbacks.
///
/// No Debug/Clone/Serialize — holds ModelCall.
pub struct InferenceConfig {
    pub call: ModelCall,
    /// Partial by design: inference derivation types the host omits are filled
    /// from DEFAULT_INFERENCE_ASSIGNMENTS; deterministic types are optional.
    /// Unknown keys are rejected at construction.
    /// Insertion-ordered — host key order is observable at construction errors.
    pub assignments: Option<IndexMap<String, ModelAssignment>>,
    /// default 60_000
    pub timeout_ms: Option<i64>,
    /// default 200_000
    pub max_input_chars: Option<i64>,
}

/// InferenceConfig after initLhc validation: every optional filled.
///
/// No Debug/Clone/Serialize — holds ModelCall.
pub struct ResolvedInferenceConfig {
    pub call: ModelCall,
    /// Insertion-ordered map.
    pub assignments: IndexMap<String, ModelAssignment>,
    pub guards: ResolvedDerivationGuards,
    pub timeout_ms: i64,
    pub max_input_chars: i64,
}

/// Default guard values: documented operational limits applied when the host
/// omits a guard. Centralized so construction and tests share one source of
/// truth for the defaults.
pub const DEFAULT_GUARDS: ResolvedDerivationGuards = ResolvedDerivationGuards {
    smoothed_prompt: ResolvedSmoothedPromptGuards {
        max_inference_tokens: 700,
        suspicious_output_ratio: 0.15,
    },
    tool_result_summary: ResolvedToolResultSummaryGuards { timeout_ms: 60_000 },
    detailed_turn_compression: ResolvedDetailedTurnCompressionGuards {
        tiny_turn_tokens: 80,
    },
};

/// Fill a DerivationGuards with defaults for every omitted value. A pure
/// function: no defaults drift between construction and the values tests pin.
pub fn resolve_guards(guards: Option<&DerivationGuards>) -> ResolvedDerivationGuards {
    let empty = DerivationGuards {
        smoothed_prompt: None,
        tool_result_summary: None,
        detailed_turn_compression: None,
    };
    let g = guards.unwrap_or(&empty);
    ResolvedDerivationGuards {
        smoothed_prompt: ResolvedSmoothedPromptGuards {
            max_inference_tokens: g
                .smoothed_prompt
                .as_ref()
                .and_then(|sp| sp.max_inference_tokens)
                .unwrap_or(DEFAULT_GUARDS.smoothed_prompt.max_inference_tokens),
            suspicious_output_ratio: g
                .smoothed_prompt
                .as_ref()
                .and_then(|sp| sp.suspicious_output_ratio)
                .unwrap_or(DEFAULT_GUARDS.smoothed_prompt.suspicious_output_ratio),
        },
        tool_result_summary: ResolvedToolResultSummaryGuards {
            timeout_ms: g
                .tool_result_summary
                .as_ref()
                .and_then(|tr| tr.timeout_ms)
                .unwrap_or(DEFAULT_GUARDS.tool_result_summary.timeout_ms),
        },
        detailed_turn_compression: ResolvedDetailedTurnCompressionGuards {
            tiny_turn_tokens: g
                .detailed_turn_compression
                .as_ref()
                .and_then(|dt| dt.tiny_turn_tokens)
                .unwrap_or(DEFAULT_GUARDS.detailed_turn_compression.tiny_turn_tokens),
        },
    }
}
