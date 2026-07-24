//! Ported from packages/lhc/test/fixtures/seam-conformance.ts. Phase 1.
//!
//! Parameterized seam-contract assertions (Epic 05 DD-13): the same helpers
//! run against the scripted fakes (TC-1.2) and, unchanged, against the real
//! host (TC-4.3). `probe_input` and `assert_model_call_contract` are REAL.
//! SDK-driving helpers are Phase 1 not-implemented at the first behavior
//! boundary (`todo!("phase 2")`).

use std::sync::{Arc, Mutex};

use lhc::Lhc;
use lhc::shared_tech::derivation::Derivation;
use lhc::shared_tech::inference_types::{
    ModelCall, ModelCallInput, ModelCallMessage, ModelCallMessageRole, ModelCallResult,
    ThinkingLevel,
};

use super::TempStore;
use super::model_call::InferenceAssignments;

/// TS `const FAILURE_KINDS = new Set([...])` — private immutable vocabulary.
const FAILURE_KINDS: &[&str] = &[
    "rate_limit",
    "timeout",
    "network",
    "empty_output",
    "other",
    "auth",
    "invalid_request",
];

/// Partial override bag for [`probe_input`] (TS `Partial<ModelCallInput>`).
#[derive(Debug, Clone, Default)]
pub struct ProbeInputOverrides {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub messages: Option<Vec<ModelCallMessage>>,
    /// Canonical thinking vocabulary — never a bare string.
    pub thinking: Option<ThinkingLevel>,
}

/// Pure data construction — REAL.
pub fn probe_input(overrides: ProbeInputOverrides) -> ModelCallInput {
    ModelCallInput {
        provider: overrides
            .provider
            .unwrap_or_else(|| "probe-provider".into()),
        model: overrides.model.unwrap_or_else(|| "probe-model".into()),
        messages: overrides.messages.unwrap_or_else(|| {
            vec![
                ModelCallMessage {
                    role: ModelCallMessageRole::System,
                    content: "You answer with one word.".into(),
                },
                ModelCallMessage {
                    role: ModelCallMessageRole::User,
                    content: "Say ok.".into(),
                },
            ]
        }),
        thinking: overrides.thinking,
    }
}

/// AC-1.2 result contract on one probe call — REAL (host boundary only).
pub async fn assert_model_call_contract(call: &ModelCall, probe: Option<ModelCallInput>) {
    let probe = probe.unwrap_or_else(|| probe_input(ProbeInputOverrides::default()));
    let result = call(probe).await;
    match result {
        ModelCallResult::Ok { text } => {
            // TS `typeof result.text === "string"`
            let _: &str = text.as_str();
        }
        ModelCallResult::Err { kind, message } => {
            assert!(
                FAILURE_KINDS.contains(&kind.as_str()),
                "failure kind \"{}\" is not in the failure vocabulary",
                kind.as_str()
            );
            // TS `typeof result.message === "string"`
            let _: &str = message.as_str();
        }
    }
}

/// TS `RoutingRunResult` — named Rust return with `file_path`.
pub struct RoutingRunResult {
    pub sdk: Lhc,
    pub file_path: String,
    pub derivations: Vec<Derivation>,
    /// Shared log for concurrent capture; Phase 2 fills it via structuredClone.
    pub log: Arc<Mutex<Vec<ModelCallInput>>>,
}

/// Private TS `seedAllSevenKinds` — SDK-driving; Phase 1 notimpl.
#[allow(dead_code)]
async fn seed_all_seven_kinds(_sdk: &Lhc, _store: &TempStore) -> String {
    todo!("phase 2")
}

/// TC-1.2 routing assertions extracted for TC-4.3 reuse. Hits init_lhc/drain —
/// Phase 1 notimpl at the first behavior boundary. Signature kept complete
/// (closed total [`InferenceAssignments`], cloned-input logging, roles,
/// failure diagnostics).
pub async fn assert_routing_through_sdk(
    _call: ModelCall,
    _assignments: InferenceAssignments,
    _store: &TempStore,
) -> RoutingRunResult {
    todo!("phase 2")
}
