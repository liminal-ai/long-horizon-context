//! Ported from packages/lhc/test/fixtures/model-call.ts.
//!
//! Constants and pure assignment/response maps are REAL. Call builders are
//! boundary doubles (host ModelCall functions) — REAL, matching lhc-py.

use std::collections::HashMap;
use std::ops::{Index, IndexMut};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use lhc::shared_tech::inference_types::{
    ModelAssignment, ModelCall, ModelCallInput, ModelCallResult, ThinkingLevel,
};
use lhc::shared_tech::prompts::DEFAULT_PROMPT_NAMES;

/// Closed fixture vocabulary for derivation types (TS `DerivationType` /
/// `DERIVATION_TYPES` in model-call.ts). Production keeps plain strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DerivationType {
    SmoothedPrompt,
    ToolResultSummary,
    TurnRendering,
    PreDetailedAssembly,
    DetailedTurnCompression,
    ChunkSummaryDetailed,
    ChunkSummaryBrief,
}

impl DerivationType {
    pub const ALL: &[DerivationType] = &[
        Self::SmoothedPrompt,
        Self::ToolResultSummary,
        Self::TurnRendering,
        Self::PreDetailedAssembly,
        Self::DetailedTurnCompression,
        Self::ChunkSummaryDetailed,
        Self::ChunkSummaryBrief,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SmoothedPrompt => "smoothed_prompt",
            Self::ToolResultSummary => "tool_result_summary",
            Self::TurnRendering => "turn_rendering",
            Self::PreDetailedAssembly => "pre_detailed_assembly",
            Self::DetailedTurnCompression => "detailed_turn_compression",
            Self::ChunkSummaryDetailed => "chunk_summary_detailed",
            Self::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }
}

pub const DERIVATION_TYPES: &[&str] = &[
    DerivationType::SmoothedPrompt.as_str(),
    DerivationType::ToolResultSummary.as_str(),
    DerivationType::TurnRendering.as_str(),
    DerivationType::PreDetailedAssembly.as_str(),
    DerivationType::DetailedTurnCompression.as_str(),
    DerivationType::ChunkSummaryDetailed.as_str(),
    DerivationType::ChunkSummaryBrief.as_str(),
];

/// Closed fixture vocabulary for inference derivation types that cross the
/// host ModelCall boundary (TS `InferenceDerivationType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InferenceDerivationType {
    SmoothedPrompt,
    ToolResultSummary,
    DetailedTurnCompression,
    ChunkSummaryBrief,
}

impl InferenceDerivationType {
    pub const ALL: &[InferenceDerivationType] = &[
        Self::SmoothedPrompt,
        Self::ToolResultSummary,
        Self::DetailedTurnCompression,
        Self::ChunkSummaryBrief,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SmoothedPrompt => "smoothed_prompt",
            Self::ToolResultSummary => "tool_result_summary",
            Self::DetailedTurnCompression => "detailed_turn_compression",
            Self::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "smoothed_prompt" => Some(Self::SmoothedPrompt),
            "tool_result_summary" => Some(Self::ToolResultSummary),
            "detailed_turn_compression" => Some(Self::DetailedTurnCompression),
            "chunk_summary_brief" => Some(Self::ChunkSummaryBrief),
            _ => None,
        }
    }
}

/// String vocabulary derived from [`InferenceDerivationType`].
pub const INFERENCE_DERIVATION_TYPES: &[&str] = &[
    InferenceDerivationType::SmoothedPrompt.as_str(),
    InferenceDerivationType::ToolResultSummary.as_str(),
    InferenceDerivationType::DetailedTurnCompression.as_str(),
    InferenceDerivationType::ChunkSummaryBrief.as_str(),
];

pub const FAKE_PROVIDER_PREFIX: &str = "prov-";
pub const FAKE_MODEL_PREFIX: &str = "model-";

fn fixture_prompt(kind: InferenceDerivationType) -> String {
    let kind_str = kind.as_str();
    for (k, name) in DEFAULT_PROMPT_NAMES {
        if *k == kind_str {
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

/// Total closed assignment container for the four inference derivation kinds
/// (TS `Record<InferenceDerivationType, ModelAssignment>`).
#[derive(Debug, Clone)]
pub struct InferenceAssignments {
    pub smoothed_prompt: ModelAssignment,
    pub tool_result_summary: ModelAssignment,
    pub detailed_turn_compression: ModelAssignment,
    pub chunk_summary_brief: ModelAssignment,
}

impl InferenceAssignments {
    pub fn get(&self, kind: InferenceDerivationType) -> &ModelAssignment {
        match kind {
            InferenceDerivationType::SmoothedPrompt => &self.smoothed_prompt,
            InferenceDerivationType::ToolResultSummary => &self.tool_result_summary,
            InferenceDerivationType::DetailedTurnCompression => &self.detailed_turn_compression,
            InferenceDerivationType::ChunkSummaryBrief => &self.chunk_summary_brief,
        }
    }

    pub fn get_mut(&mut self, kind: InferenceDerivationType) -> &mut ModelAssignment {
        match kind {
            InferenceDerivationType::SmoothedPrompt => &mut self.smoothed_prompt,
            InferenceDerivationType::ToolResultSummary => &mut self.tool_result_summary,
            InferenceDerivationType::DetailedTurnCompression => &mut self.detailed_turn_compression,
            InferenceDerivationType::ChunkSummaryBrief => &mut self.chunk_summary_brief,
        }
    }

    /// Explicit conversion for the production [`InferenceConfig`] string-key path.
    pub fn to_string_keyed(&self) -> IndexMap<String, ModelAssignment> {
        let mut map = IndexMap::new();
        for kind in InferenceDerivationType::ALL {
            map.insert(kind.as_str().to_string(), self.get(*kind).clone());
        }
        map
    }
}

impl Index<InferenceDerivationType> for InferenceAssignments {
    type Output = ModelAssignment;

    fn index(&self, kind: InferenceDerivationType) -> &ModelAssignment {
        self.get(kind)
    }
}

impl IndexMut<InferenceDerivationType> for InferenceAssignments {
    fn index_mut(&mut self, kind: InferenceDerivationType) -> &mut ModelAssignment {
        self.get_mut(kind)
    }
}

fn assignment_for(
    kind: InferenceDerivationType,
    ov: Option<&ModelAssignmentOverride>,
) -> ModelAssignment {
    let kind_str = kind.as_str();
    ModelAssignment {
        provider: ov
            .and_then(|o| o.provider.clone())
            .unwrap_or_else(|| format!("{FAKE_PROVIDER_PREFIX}{kind_str}")),
        model: ov
            .and_then(|o| o.model.clone())
            .unwrap_or_else(|| format!("{FAKE_MODEL_PREFIX}{kind_str}")),
        prompt: ov
            .and_then(|o| o.prompt.clone())
            .unwrap_or_else(|| fixture_prompt(kind)),
        target_min_ratio: ov.and_then(|o| o.target_min_ratio),
        target_max_ratio: ov.and_then(|o| o.target_max_ratio),
        target_aim_ratio: ov.and_then(|o| o.target_aim_ratio),
        thinking: ov.and_then(|o| o.thinking),
    }
}

/// Every kind gets a distinct fake provider/model lane — pure data. REAL.
/// Returns a total closed [`InferenceAssignments`] covering all four inference kinds.
pub fn valid_assignments(
    overrides: Option<&HashMap<InferenceDerivationType, ModelAssignmentOverride>>,
) -> InferenceAssignments {
    let empty = HashMap::new();
    let overrides = overrides.unwrap_or(&empty);
    InferenceAssignments {
        smoothed_prompt: assignment_for(
            InferenceDerivationType::SmoothedPrompt,
            overrides.get(&InferenceDerivationType::SmoothedPrompt),
        ),
        tool_result_summary: assignment_for(
            InferenceDerivationType::ToolResultSummary,
            overrides.get(&InferenceDerivationType::ToolResultSummary),
        ),
        detailed_turn_compression: assignment_for(
            InferenceDerivationType::DetailedTurnCompression,
            overrides.get(&InferenceDerivationType::DetailedTurnCompression),
        ),
        chunk_summary_brief: assignment_for(
            InferenceDerivationType::ChunkSummaryBrief,
            overrides.get(&InferenceDerivationType::ChunkSummaryBrief),
        ),
    }
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
    pub log: Arc<Mutex<Vec<ModelCallInput>>>,
}

/// Resolves each call with its kind's canned text — kind inferred from the
/// model routing key [`valid_assignments`] made unique per kind. REAL.
pub fn recording_call(responses: &HashMap<String, String>) -> RecordingCallBundle {
    let log = Arc::new(Mutex::new(Vec::new()));
    let responses = responses.clone();
    let log_for_call = Arc::clone(&log);
    let known: Vec<String> = INFERENCE_DERIVATION_TYPES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let call: ModelCall = Box::new(move |input| {
        let responses = responses.clone();
        let log = Arc::clone(&log_for_call);
        let known = known.clone();
        Box::pin(async move {
            log.lock().expect("recordingCall log").push(input.clone());
            let kind = if input.model.starts_with(FAKE_MODEL_PREFIX) {
                input.model[FAKE_MODEL_PREFIX.len()..].to_string()
            } else {
                input.model.clone()
            };
            if !known.iter().any(|k| k == &kind) {
                panic!(
                    "recordingCall: no canned response for model \"{}\"",
                    input.model
                );
            }
            let text = responses.get(&kind).cloned().unwrap_or_else(|| {
                panic!(
                    "recordingCall: no canned response for model \"{}\"",
                    input.model
                );
            });
            ModelCallResult::Ok { text }
        })
    });
    RecordingCallBundle { call, log }
}

/// Returns script entries in order; a call past the end of the script is a
/// test bug and panics loudly. REAL.
pub fn scripted_call(script: Vec<ModelCallResult>) -> ModelCall {
    let next = Arc::new(AtomicUsize::new(0));
    let script = Arc::new(script);
    Box::new(move |input| {
        let next = Arc::clone(&next);
        let script = Arc::clone(&script);
        Box::pin(async move {
            let i = next.fetch_add(1, Ordering::SeqCst);
            match script.get(i) {
                Some(entry) => entry.clone(),
                None => panic!(
                    "scriptedCall: script exhausted after {} calls (model \"{}\")",
                    script.len(),
                    input.model
                ),
            }
        })
    })
}

/// A host whose function panics — the AC-3.3 containment leg (JS Promise.reject).
/// REAL. `safe_call` will catch panics once implemented.
pub fn throwing_call(error: Box<dyn std::error::Error + Send + Sync>) -> ModelCall {
    let msg = error.to_string();
    Box::new(move |_input| {
        let msg = msg.clone();
        Box::pin(async move {
            panic!("{msg}");
        })
    })
}

/// A host that never settles — the DD-6 timeout leg. REAL.
pub fn hanging_call() -> ModelCall {
    Box::new(|_input| Box::pin(futures::future::pending::<ModelCallResult>()))
}
