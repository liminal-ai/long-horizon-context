//! Ported from packages/lhc/src/shared-tech/deterministic.ts. Phase 1 skeleton.
//!
//! EXEMPLAR MODULE — canonical pattern for a mixed constants-and-functions
//! file. Constants are ported verbatim as real values (a TS `Record` over a
//! closed vocabulary becomes an exhaustive-match fn — no wildcard arm); every
//! ported function body is `todo!("phase 2")`, even the one-liners.
//!
//! Deterministic inference callbacks: marked, input-derived output for every
//! seam operation — `<marker>(<digest>:<prefix>)` where digest and prefix are
//! pure functions of the input. The test double reuses these helpers so
//! in-process and spawned runs produce byte-identical artifacts. It is
//! selectable only by explicit construction — never a production default.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::derivation::{InferenceCallbacks, ToolOutcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeterministicOpName {
    SmoothPrompt,
    SummarizeToolResult,
    CompressDetailedTurn,
    SummarizeChunkBrief,
}

impl DeterministicOpName {
    pub fn as_str(self) -> &'static str {
        match self {
            DeterministicOpName::SmoothPrompt => "smoothPrompt",
            DeterministicOpName::SummarizeToolResult => "summarizeToolResult",
            DeterministicOpName::CompressDetailedTurn => "compressDetailedTurn",
            DeterministicOpName::SummarizeChunkBrief => "summarizeChunkBrief",
        }
    }
}

/// TS `DETERMINISTIC_MARKERS: Record<DeterministicOpName, string>`.
pub fn deterministic_marker(op: DeterministicOpName) -> &'static str {
    match op {
        DeterministicOpName::SmoothPrompt => "smoothed",
        DeterministicOpName::SummarizeToolResult => "toolresult",
        DeterministicOpName::CompressDetailedTurn => "projection",
        DeterministicOpName::SummarizeChunkBrief => "brief",
    }
}

// FNV-1a 32-bit over the canonical input JSON: stable, dependency-free, and
// input-sensitive enough that distinct inputs mark distinct outputs.
// NOTE (Phase 2): "canonical input JSON" must byte-match JS JSON.stringify —
// use shared_tech::js_json; the hash walks UTF-16 code units (charCodeAt),
// not bytes or chars.
pub fn deterministic_digest(_input: &Value) -> String {
    todo!("phase 2")
}

pub fn deterministic_text(_op: DeterministicOpName, _input: &Value, _text: &str) -> String {
    todo!("phase 2")
}

pub fn deterministic_outcomes_suffix(_member_outcomes: Option<&[Vec<ToolOutcome>]>) -> String {
    todo!("phase 2")
}

pub fn create_deterministic_inference_callbacks() -> InferenceCallbacks {
    todo!("phase 2")
}
