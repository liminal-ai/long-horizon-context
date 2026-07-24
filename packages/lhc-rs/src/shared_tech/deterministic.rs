//! Ported from packages/lhc/src/shared-tech/deterministic.ts.
//!
//! Deterministic inference callbacks: marked, input-derived output for every
//! seam operation — `<marker>(<digest>:<prefix>)` where digest and prefix are
//! pure functions of the input. The test double reuses these helpers so
//! in-process and spawned runs produce byte-identical artifacts. It is
//! selectable only by explicit construction — never a production default.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceResult, SmoothPromptInput,
    SummarizeChunkBriefInput, SummarizeToolResultInput, ToolOutcome,
};
use super::js_json::{js_char_codes, js_json_stringify, js_slice};

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
// "canonical input JSON" must byte-match JS JSON.stringify — use
// shared_tech::js_json; the hash walks UTF-16 code units (charCodeAt).
pub fn deterministic_digest(input: &Value) -> String {
    let text = js_json_stringify(input);
    let mut hash: u32 = 0x811c_9dc5;
    for code in js_char_codes(&text) {
        hash ^= u32::from(code);
        // Math.imul(hash, 0x01000193) >>> 0
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

pub fn deterministic_text(op: DeterministicOpName, input: &Value, text: &str) -> String {
    // TS: text.slice(0, 40) — 40 UTF-16 code units, not 40 code points.
    format!(
        "{}({}:{})",
        deterministic_marker(op),
        deterministic_digest(input),
        js_slice(text, 0, Some(40))
    )
}

pub fn deterministic_outcomes_suffix(member_outcomes: Option<&[Vec<ToolOutcome>]>) -> String {
    let outcomes: Vec<&ToolOutcome> = member_outcomes
        .unwrap_or(&[])
        .iter()
        .flat_map(|group| group.iter())
        .collect();
    if outcomes.is_empty() {
        return String::new();
    }
    let joined = outcomes
        .iter()
        .map(|o| o.as_str())
        .collect::<Vec<_>>()
        .join(",");
    format!("[outcomes {joined}]")
}

fn ok(op: DeterministicOpName, input: &Value, text: &str) -> BoxFuture<InferenceResult> {
    let text = deterministic_text(op, input, text);
    Box::pin(async move {
        InferenceResult::Ok {
            text,
            provenance: None,
            request_messages: None,
            raw_response: None,
        }
    })
}

fn input_value<T: Serialize>(input: &T) -> Value {
    serde_json::to_value(input).expect("deterministic input serializes")
}

pub fn create_deterministic_inference_callbacks() -> InferenceCallbacks {
    InferenceCallbacks {
        smooth_prompt: Arc::new(|i: SmoothPromptInput| {
            let text = i.text.clone();
            ok(DeterministicOpName::SmoothPrompt, &input_value(&i), &text)
        }),
        summarize_tool_result: Arc::new(|i: SummarizeToolResultInput| {
            let text = i.content.clone();
            ok(
                DeterministicOpName::SummarizeToolResult,
                &input_value(&i),
                &text,
            )
        }),
        compress_detailed_turn: Arc::new(|i: CompressDetailedTurnInput| {
            let text = i.dialogue_text.clone();
            ok(
                DeterministicOpName::CompressDetailedTurn,
                &input_value(&i),
                &text,
            )
        }),
        summarize_chunk_brief: Arc::new(|i: SummarizeChunkBriefInput| {
            let text = i.text.clone();
            ok(
                DeterministicOpName::SummarizeChunkBrief,
                &input_value(&i),
                &text,
            )
        }),
    }
}
